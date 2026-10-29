import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import {
  krakenContractSymbol, krakenNormalizeSymbol, krakenSymbolsMatch,
  krakenGetExchangeInfo, krakenGetPrice, krakenNormalizeSizeByContract,
  krakenPlaceMarketOrder, krakenClosePosition, krakenGetOrderFills,
  krakenGetSinglePosition, krakenGetCommissionRate, krakenOrderSuccess,
  krakenGetOpenOrders,
} from '@/lib/kraken';
import { calculateCloseMetrics, type TradingMode } from '@/lib/positions';
import { BLOCKED_ENTRY_SYMBOLS_SETTING_KEY, resolveBlockedEntrySymbols } from '@/lib/tradingFilters';

export const SPECIAL_MAX_ENTRIES = 5;
export type SpecialSignalResult = {
  status: number;
  body: Record<string, any> & { error?: boolean; success?: boolean; message: string };
};
const fail = (message: string, status = 409): SpecialSignalResult => ({ status, body: { error: true, message } });
const done = (message: string, extra: Record<string, unknown> = {}): SpecialSignalResult => ({ status: 200, body: { success: true, message, ...extra } });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Call under withTradingLock. The durable pending intent is deliberately not
// expired automatically: a timeout is not proof that Kraken rejected an order.
export async function executeSpecialSignal(data: any, tradingMode: TradingMode): Promise<SpecialSignalResult> {
  if (tradingMode !== 'demo' && tradingMode !== 'live') return fail('Invalid trading mode', 400);
  const rawSymbol = String(data.symbol || '').trim().toUpperCase().split(':').pop()!.replace(/\.P$/, '');
  if (/^(PI|FF)_/.test(rawSymbol)) return fail('Special admite exclusivamente perpetuos lineales PF de Kraken.', 400);
  const symbol = krakenNormalizeSymbol(rawSymbol);
  const contract = krakenContractSymbol(symbol);
  const type = String(data.type || '').toLowerCase();
  const origin = String(data.origin || '').trim();
  const timeframe = data.timeframe == null ? null : String(data.timeframe);
  if (!symbol || !/^[A-Z0-9]+USD(T|C)?$/.test(symbol) || !origin || !['buy', 'sell', 'close'].includes(type)) {
    return fail('Special requiere symbol, origin y type buy, sell o close.', 400);
  }
  const signalId = data.signal_id == null ? '' : String(data.signal_id).trim();
  const receiptKey = signalId ? `special_receipt:${hash(JSON.stringify([tradingMode, contract, origin, timeframe, type, signalId]))}` : null;
  if (receiptKey && await prisma.setting.findUnique({ where: { key: receiptKey } })) {
    return done('Ignorada: senal special ya ejecutada.', { duplicate: true });
  }
  const stateKey = `special_state:${tradingMode}:${contract}`;
  const pendingKey = `special_pending:${tradingMode}:${contract}`;
  if (await prisma.setting.findUnique({ where: { key: pendingKey } })) {
    return fail('Special bloqueado: existe una orden pendiente de conciliacion. Revisar fills y posicion antes de retirar el bloqueo.');
  }
  const candidates = (await prisma.position.findMany({ where: { status: 'open', tradingMode } }))
    .filter((position) => krakenSymbolsMatch(position.symbol, symbol));
  const position = candidates[0];
  if (data.expectedPositionId && position?.id !== data.expectedPositionId) return fail('La posicion solicitada ya no esta abierta.');
  if (candidates.length > 1 || (position && (position.managementMode !== 'special' ||
    position.origin !== origin || position.timeframe !== timeframe))) {
    return fail('El contrato ya pertenece a otra posicion, modo, origin o timeframe. Special no mezcla estrategias.');
  }
  if (type === 'close' && !position) return done('Ignorada: no hay posicion special abierta.');
  const isEntry = type === 'buy' || type === 'sell';
  if (isEntry) {
    if ((await prisma.setting.findUnique({ where: { key: 'bot_enabled' } }))?.value === '0') return done('Bot disabled');
    const blocked = await prisma.setting.findUnique({ where: { key: BLOCKED_ENTRY_SYMBOLS_SETTING_KEY } });
    if (resolveBlockedEntrySymbols(blocked?.value).some((blockedSymbol) => krakenSymbolsMatch(blockedSymbol, symbol))) return fail('Activo bloqueado por la configuracion de entradas.');
  }
  const stateRow = await prisma.setting.findUnique({ where: { key: stateKey } });
  const state = stateRow ? JSON.parse(stateRow.value) : null;
  if (position && state?.positionId !== position.id) return fail('Falta el estado de la piramide. Conciliar antes de operar.');
  const entries = position ? Number(state.entries) : 0;
  if (isEntry && state?.positionId === position?.id && state?.closing) return fail('Cierre parcial pendiente. Completar close antes de nuevas entradas.');

  if (isEntry && position && position.positionType !== type) {
    const closeResult = await executeSpecialSignal({
      ...data,
      type: 'close',
      expectedPositionId: position.id,
      signal_id: signalId ? `${signalId}:reverse-close` : undefined,
      internalCloseReason: 'special_reverse',
      internalCloseOrigin: 'app_rules',
    }, tradingMode);
    if (closeResult.status !== 200 || closeResult.body.error) return closeResult;
    const entryResult = await executeSpecialSignal(data, tradingMode);
    if (entryResult.status !== 200 || entryResult.body.error) return entryResult;
    return {
      ...entryResult,
      body: {
        ...entryResult.body,
        message: `Posicion special invertida de ${position.positionType} a ${type}.`,
        reversed: true,
        closedPositionId: position.id,
      },
    };
  }

  if (isEntry && entries >= SPECIAL_MAX_ENTRIES) return fail('Limite de cinco entradas special alcanzado.');
  const info = await krakenGetExchangeInfo(symbol, tradingMode);
  if (!info || info.type !== 'flexible_futures' || !info.krakenSymbol.startsWith('PF_') || info.tradeable !== true || info.suspended || info.postOnly) {
    return fail('Contrato lineal Kraken no disponible para ordenes de mercado.', 400);
  }
  const snapshot = await krakenGetSinglePosition(symbol, tradingMode);
  if (!snapshot.ok) return fail('No se pudo verificar la posicion de Kraken.', 502);
  const actualQuantity = snapshot.positions.reduce((sum, item) => sum + Number(item.positionAmt), 0);
  const tolerance = Number(info.sizeMultiplier) / 10;
  const expectedActualQuantity = position
    ? (position.positionType === 'buy' ? position.quantity : -position.quantity)
    : 0;
  if (Math.abs(actualQuantity - expectedActualQuantity) > tolerance) {
    return fail('La posicion de Kraken no coincide con la app. Conciliar antes de operar.');
  }
  const pendingOrders = await krakenGetOpenOrders(symbol, tradingMode);
  if (!pendingOrders.ok || pendingOrders.orders.length) return fail('Hay ordenes previas o no se pudieron verificar. Special requiere el contrato sin ordenes pendientes.');
  let quantity = position?.quantity || 0;
  if (isEntry) {
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) return fail('amount debe ser un nominal USD positivo por entrada.', 400);
    const price = await krakenGetPrice(symbol, tradingMode);
    if (!price) return fail('No se pudo obtener precio de Kraken.', 502);
    quantity = krakenNormalizeSizeByContract(amount / price, info);
    if (quantity <= 0) return fail('amount inferior al tamano minimo del contrato.', 400);
    if (Number(info.maxPositionSize) > 0 && quantity + (position?.quantity || 0) > Number(info.maxPositionSize)) return fail('Se supera el tamano maximo de posicion de Kraken.', 400);
  }
  const fee = await krakenGetCommissionRate(symbol, tradingMode);
  const clientOid = randomUUID();
  await prisma.setting.create({ data: { key: pendingKey, value: JSON.stringify({ clientOid, symbol, type, quantity, signalId, positionId: position?.id, createdAt: new Date().toISOString() }) } });
  const response = isEntry
    ? await krakenPlaceMarketOrder(symbol, type === 'buy' ? 'BUY' : 'SELL', quantity, tradingMode, undefined, clientOid)
    : await krakenClosePosition(symbol, position!.positionType === 'buy' ? 'SELL' : 'BUY', quantity, tradingMode, undefined, clientOid);
  if (!krakenOrderSuccess(response)) {
    // Only an explicit exchange rejection proves no fill occurred. Transport
    // failures retain the intent, preventing an accidental second purchase.
    const rejectedWithoutFill = ['insufficientAvailableFunds', 'invalidSize', 'invalidPrice', 'wouldNotReducePosition', 'maxPositionViolation'].includes(response?.sendStatus?.status);
    if (rejectedWithoutFill || (tradingMode === 'live' && process.env.KRAKEN_LIVE_TRADING_ENABLED !== '1')) {
      await prisma.setting.deleteMany({ where: { key: pendingKey } });
    }
    return fail(`Kraken no confirmo la orden special: ${response?.sendStatus?.status || response?.error || 'respuesta desconocida'}`, 502);
  }
  const orderId = response.orderId || response.sendStatus?.order_id || response.data?.orderId;
  let filled = 0;
  let notional = 0;
  for (const delay of [0, 200, 500, 1000, 2000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (!orderId) break;
    const result = await krakenGetOrderFills(symbol, orderId, tradingMode);
    if (!krakenOrderSuccess(result)) continue;
    const fills = result.fills || [];
    filled = fills.reduce((sum: number, fill: any) => sum + Number(fill.size), 0);
    notional = fills.reduce((sum: number, fill: any) => sum + Number(fill.size) * Number(fill.price), 0);
    if (!(filled > 0 && filled <= quantity + tolerance && notional > 0)) continue;
    if (tradingMode === 'demo') break;
    const after = await krakenGetSinglePosition(symbol, tradingMode);
    const afterQuantity = after.positions.reduce((sum, item) => sum + Number(item.positionAmt), 0);
    const signedFillDelta = isEntry
      ? (type === 'buy' ? filled : -filled)
      : (position!.positionType === 'buy' ? -filled : filled);
    if (after.ok && Math.abs(afterQuantity - (actualQuantity + signedFillDelta)) <= tolerance) break;
    filled = 0;
  }
  if (!(filled > 0 && filled <= quantity + tolerance && Number.isFinite(notional) && notional > 0)) {
    return fail('Ejecucion sin fills verificables. Se conserva el bloqueo para conciliacion; no reenviar compras.', 502);
  }
  const price = notional / filled;
  const completeClose = type === 'close' && Math.abs(quantity - filled) <= tolerance;
  const saved = await prisma.$transaction(async (tx) => {
    let savedPosition;
    if (isEntry) {
      const totalQuantity = (position?.quantity || 0) + filled;
      const totalNotional = (position ? position.entryPrice * position.quantity : 0) + notional;
      const values = {
        quantity: totalQuantity, amount: totalNotional, entryPrice: totalNotional / totalQuantity,
        commission: ((position ? position.entryPrice * position.quantity * (position.commission || 0) : 0) + notional * fee) / totalNotional,
        stopLoss: 0, takeProfit: null, maxProfitPercent: 0, maxProfitAt: null,
        maxAdversePercent: 0, maxAdverseAt: null,
      };
      savedPosition = position
        ? await tx.position.update({ where: { id: position.id }, data: values })
        : await tx.position.create({ data: { ...values, symbol, positionType: type, managementMode: 'special', tradingMode, origin, timeframe, pricePrecision: info.pricePlace } });
      const value = JSON.stringify({ positionId: savedPosition.id, entries: entries + 1 });
      await tx.setting.upsert({ where: { key: stateKey }, create: { key: stateKey, value }, update: { value } });
    } else {
      const metrics = calculateCloseMetrics({ positionType: position!.positionType, entryPrice: position!.entryPrice, quantity: filled, exitPrice: price, entryCommission: position!.commission || 0, exitCommission: fee });
      const realized = (position!.profitLossFiat || 0) + metrics.profitFiat;
      const closedQuantity = Number(state.closedQuantity || 0) + filled;
      const closeNotional = Number(state.closeNotional || 0) + notional;
      savedPosition = await tx.position.update({ where: { id: position!.id }, data: {
        ...(completeClose ? { status: 'closed', quantity: closedQuantity, closedAt: new Date(), exitPrice: closeNotional / closedQuantity, exitOrderId: orderId, exitReason: data.internalCloseReason || 'special_close', exitSource: tradingMode === 'demo' ? 'paper' : 'kraken', closeOrigin: data.internalCloseOrigin || 'api_close' }
          : { quantity: quantity - filled }),
        profitLossFiat: realized, profitLossPercent: position!.amount > 0 ? realized / position!.amount * 100 : 0,
      } });
      if (!completeClose) await tx.setting.updateMany({ where: { key: stateKey, value: stateRow!.value }, data: { value: JSON.stringify({ ...state, closing: true, closedQuantity, closeNotional }) } });
    }
    await tx.auditLog.create({ data: { action: isEntry ? 'position.special.entry' : 'position.special.close', targetType: 'position', targetId: String(savedPosition.id), metadata: { orderId, clientOid, signalId, filled, price, tradingMode, side: isEntry ? type : position!.positionType, entries: isEntry ? entries + 1 : entries, partial: filled < quantity - tolerance } } });
    if (receiptKey && (isEntry || completeClose)) await tx.setting.create({ data: { key: receiptKey, value: JSON.stringify({ positionId: savedPosition.id, orderId }) } });
    await tx.setting.deleteMany({ where: { key: pendingKey } });
    return savedPosition;
  });
  if (type === 'close' && !completeClose) return fail('Cierre parcial: queda posicion abierta. Reenviar close para cerrar el resto.');
  return done(isEntry ? `${type === 'buy' ? 'Compra' : 'Venta'} special acumulada a mercado.` : 'Posicion special cerrada.', { positionId: saved.id, quantity: saved.quantity, entryPrice: saved.entryPrice, entries: isEntry ? entries + 1 : entries, filled, orderId, tradingMode, deduplicatedBySignalId: Boolean(signalId) });
}
