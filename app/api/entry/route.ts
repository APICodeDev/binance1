export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getAuthContext } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { notifyAllActiveDevices } from '@/lib/pushNotifications';
import {
  closeTrackedPosition,
  normalizePositionManagementMode,
  type PositionManagementMode,
  type TradingMode,
} from '@/lib/positions';
import {
  bitgetBuildPositionContext,
  bitgetCancelAllOrders,
  bitgetCancelOrder,
  bitgetClosePosition,
  bitgetGetCommissionRate,
  bitgetGetCurrentFundingRate,
  bitgetGetExchangeInfo,
  bitgetGetMakerCommissionRate,
  bitgetGetMergeDepth,
  bitgetGetOrderDetail,
  bitgetGetOrderFills,
  bitgetGetPendingTpslOrders,
  bitgetGetPositionMode,
  bitgetGetPrice,
  bitgetGetSinglePosition,
  bitgetGetTickSize,
  bitgetGetVipFeeRates,
  bitgetGetWsBestBidAsk,
  bitgetModifyTpslOrder,
  bitgetSetPositionMode,
  bitgetNormalizePriceByContract,
  bitgetNormalizePriceByContractDirectional,
  bitgetNormalizeSizeByContract,
  bitgetNormalizeSymbol,
  bitgetOrderSuccess,
  bitgetPlaceLimitOrder,
  bitgetPlaceMarketOrder,
  bitgetPlaceStopMarket,
  bitgetPlaceTpslMarket,
  type BitgetPositionMode,
  bitgetSetLeverage,
} from '@/lib/bitget';

const DEFAULT_MAKER_RETRY_DELAYS_MS = [500];
const DEFAULT_MAX_SPREAD_PERCENT = 0.6;
const DEFAULT_MAX_TAKER_COST_PERCENT = 1.0;
const DEFAULT_PROTECTION_RETRY_DELAYS_MS = [500, 1000, 1500];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const createClientOid = (symbol: string) =>
  `bgd-${symbol.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const summarizeBitgetResponse = (resp: any) => {
  if (!resp || typeof resp !== 'object') {
    return 'without response payload';
  }

  const code = resp.code ? `code=${resp.code}` : null;
  const msg = resp.msg || resp.message ? `msg=${JSON.stringify(resp.msg || resp.message)}` : null;
  const data = resp.data !== undefined ? `data=${JSON.stringify(resp.data)}` : null;
  return [code, msg, data].filter(Boolean).join(' | ') || JSON.stringify(resp);
};

const getBitgetResponseCode = (resp: any) => String(resp?.code || '').trim();
const RETRYABLE_PROTECTION_CODES = new Set(['43023', '40891']);
const isRetryableProtectionPlacementError = (resp: any) => RETRYABLE_PROTECTION_CODES.has(getBitgetResponseCode(resp));

const parseOptionalPrice = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = Number.parseFloat(String(value ?? ''));
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
};

const parseOptionalPercent = (...values: unknown[]) => {
  for (const value of values) {
    const raw = String(value ?? '').trim().replace('%', '').replace(',', '.');
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
};

const hasPayloadValue = (value: unknown) =>
  value !== undefined && value !== null && String(value).trim() !== '';

const normalizeSignalOrigin = (value: unknown) => {
  const raw = String(value ?? '').trim();
  return raw ? raw : null;
};

const isSameOrigin = (left: unknown, right: unknown) =>
  normalizeSignalOrigin(left) === normalizeSignalOrigin(right);

const getProtectionRetryDelays = () => {
  const rawValue = process.env.BITGET_PROTECTION_RETRY_DELAYS_MS;
  if (!rawValue) {
    return DEFAULT_PROTECTION_RETRY_DELAYS_MS;
  }

  const parsed = rawValue
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  return parsed.length > 0 ? parsed : DEFAULT_PROTECTION_RETRY_DELAYS_MS;
};

async function hasBitgetOpenPosition(symbol: string, tradingMode: TradingMode) {
  const snapshot = await bitgetGetSinglePosition(symbol, tradingMode);
  if (!snapshot.ok) {
    return false;
  }

  return snapshot.positions.some((position: any) => position.symbol && parseFloat(position.positionAmt) !== 0);
}

async function placeProtectionOrderWithRetries(params: {
  kind: 'stop' | 'takeProfit';
  symbol: string;
  tradingMode: TradingMode;
  place: () => Promise<any>;
}) {
  const { kind, symbol, tradingMode, place } = params;
  const delays = getProtectionRetryDelays();
  let response = await place();
  let attempts = 1;

  while (!bitgetOrderSuccess(response) && isRetryableProtectionPlacementError(response) && attempts <= delays.length) {
    const delayMs = delays[attempts - 1];
    await sleep(delayMs);
    await hasBitgetOpenPosition(symbol, tradingMode).catch(() => false);
    response = await place();
    attempts += 1;
  }

  const exhaustedRetryable = !bitgetOrderSuccess(response) && isRetryableProtectionPlacementError(response);
  return {
    ok: bitgetOrderSuccess(response),
    response,
    attempts,
    exhaustedRetryable,
    kind,
  };
}

const isBetterTakeProfit = (
  currentTakeProfit: number | null,
  nextTakeProfit: number,
  positionType: 'buy' | 'sell'
) => {
  if (currentTakeProfit === null) {
    return true;
  }

  return positionType === 'buy'
    ? nextTakeProfit > currentTakeProfit
    : nextTakeProfit < currentTakeProfit;
};

function resolveRequestedTakeProfit(params: {
  entryPrice: number;
  positionType: 'buy' | 'sell';
  exchangeInfo: any;
  requestedTakeProfitPrice: number | null;
  requestedTakeProfitPercent: number | null;
}) {
  const {
    entryPrice,
    positionType,
    exchangeInfo,
    requestedTakeProfitPrice,
    requestedTakeProfitPercent,
  } = params;
  const takeProfitNormalizeDirection = positionType === 'buy' ? 'up' : 'down';
  const normalizeExitPrice = (price: number | null, direction: 'down' | 'up') =>
    price !== null
      ? bitgetNormalizePriceByContractDirectional(price, exchangeInfo, direction)
      : null;
  const computedTakeProfitPriceFromPercent = requestedTakeProfitPercent !== null
    ? (positionType === 'buy'
        ? entryPrice * (1 + (requestedTakeProfitPercent / 100))
        : entryPrice * (1 - (requestedTakeProfitPercent / 100)))
    : null;
  const resolvedRequestedTakeProfitPrice = requestedTakeProfitPrice !== null
    ? requestedTakeProfitPrice
    : computedTakeProfitPriceFromPercent;
  const takeProfitInputSource = requestedTakeProfitPrice !== null ? 'price' : requestedTakeProfitPercent !== null ? 'percent' : 'none';
  const normalizedRequestedTakeProfit = resolvedRequestedTakeProfitPrice !== null
    ? normalizeExitPrice(resolvedRequestedTakeProfitPrice, takeProfitNormalizeDirection)
    : null;
  const isRequestedTakeProfitValid = normalizedRequestedTakeProfit !== null &&
    (
      (positionType === 'buy' && normalizedRequestedTakeProfit > entryPrice) ||
      (positionType === 'sell' && normalizedRequestedTakeProfit < entryPrice)
    );

  return {
    computedTakeProfitPriceFromPercent,
    resolvedRequestedTakeProfitPrice,
    takeProfitInputSource,
    normalizedRequestedTakeProfit,
    isRequestedTakeProfitValid,
  };
}

const resolveTradingMode = async () => {
  const modeSetting = await prisma.setting.findUnique({ where: { key: 'trading_mode' } });
  return (modeSetting?.value || 'demo') as TradingMode;
};

async function closePositionFromEntrySignal(
  data: any,
  req: NextRequest,
  auth: Awaited<ReturnType<typeof getAuthContext>>
) {
  const symbol = bitgetNormalizeSymbol(data.symbol || '');
  const modeProvided = data.mode !== undefined && data.mode !== null && String(data.mode).trim() !== '';
  const managementMode = normalizePositionManagementMode(data.mode);
  const signalOrigin = normalizeSignalOrigin(data.origin);

  if (!symbol) {
    return NextResponse.json({ error: true, message: 'Invalid symbol for close' }, { status: 400 });
  }

  const tradingMode = await resolveTradingMode();
  const where: Record<string, unknown> = {
    symbol,
    status: 'open',
    tradingMode,
  };

  if (modeProvided) {
    where.managementMode = managementMode;
  }

  const position = await prisma.position.findFirst({
    where: where as any,
    orderBy: { createdAt: 'desc' },
  });

  if (!position) {
    return NextResponse.json({
      success: true,
      message: `No open position found for ${symbol} in ${tradingMode}.`,
    });
  }

  if (!isSameOrigin(position.origin, signalOrigin)) {
    await writeAuditLog({
      action: 'position.close_signal_ignored_origin',
      userId: auth?.user?.id,
      targetType: 'position',
      targetId: String(position.id),
      metadata: {
        symbol,
        tradingMode,
        managementMode,
        positionOrigin: position.origin || null,
        signalOrigin,
        trigger: auth ? auth.authType : 'webhook',
      },
      req,
    });

    return NextResponse.json({
      success: true,
      message: `Ignorada (${tradingMode}): El close de ${signalOrigin || 'sin origin'} no coincide con el origin ${position.origin || 'sin origin'} de la posicion abierta en ${symbol}.`,
    });
  }

  const closeResult = await closeTrackedPosition(position);
  if (!closeResult.ok) {
    const errDetail = `No se pudo cerrar ${symbol} por senal externa: ${closeResult.message}`;
    await saveLastEntryError(errDetail, symbol, 'close');
    return NextResponse.json({ error: true, message: closeResult.message, details: closeResult.details }, { status: closeResult.status });
  }

  await writeAuditLog({
    action: 'position.close.signal',
    userId: auth?.user?.id,
    targetType: 'position',
    targetId: String(position.id),
      metadata: {
        symbol: closeResult.symbol,
        tradingMode: closeResult.tradingMode,
        managementMode,
        origin: signalOrigin,
        trigger: auth ? auth.authType : 'webhook',
      },
      req,
  });

  await prisma.setting.upsert({
    where: { key: 'last_entry_error' },
    update: { value: '' },
    create: { key: 'last_entry_error', value: '' },
  });

  return NextResponse.json({
    success: true,
    message: `Position closed in ${closeResult.tradingMode} for ${closeResult.symbol}`,
  });
}

async function maybeUpgradeTakeProfitFromSameDirectionSignal(params: {
  existing: any;
  symbol: string;
  type: 'buy' | 'sell';
  tradingMode: TradingMode;
  effectivePositionMode: BitgetPositionMode;
  exchangeInfo: any;
  requestedTakeProfitPrice: number | null;
  requestedTakeProfitPercent: number | null;
  req: NextRequest;
  auth: Awaited<ReturnType<typeof getAuthContext>>;
}) {
  const {
    existing,
    symbol,
    type,
    tradingMode,
    effectivePositionMode,
    exchangeInfo,
    requestedTakeProfitPrice,
    requestedTakeProfitPercent,
    req,
    auth,
  } = params;

  const takeProfitResolution = resolveRequestedTakeProfit({
    entryPrice: existing.entryPrice,
    positionType: type,
    exchangeInfo,
    requestedTakeProfitPrice,
    requestedTakeProfitPercent,
  });

  const candidateTakeProfit = takeProfitResolution.isRequestedTakeProfitValid
    ? takeProfitResolution.normalizedRequestedTakeProfit
    : null;
  const currentTakeProfit = Number.isFinite(existing.takeProfit) ? Number(existing.takeProfit) : null;

  if (candidateTakeProfit === null) {
    return NextResponse.json({
      success: true,
      message: `Ignorada (${tradingMode}): Ya existe una posicion abierta en direccion ${type} para ${symbol} y la nueva senal no trae un TP valido para mejorarla.`,
    });
  }

  if (!isBetterTakeProfit(currentTakeProfit, candidateTakeProfit, type)) {
    return NextResponse.json({
      success: true,
      message: `Ignorada (${tradingMode}): Ya existe una posicion abierta en direccion ${type} para ${symbol} y el TP entrante no mejora el actual.`,
    });
  }

  const existingContext = bitgetBuildPositionContext(existing.positionType as 'buy' | 'sell', effectivePositionMode);
  const pendingProfitOrders = await bitgetGetPendingTpslOrders(symbol, tradingMode);
  if (!pendingProfitOrders.ok) {
    const errDetail = `No se pudieron consultar los TP pendientes de ${symbol} para evaluar mejora de take profit. ${pendingProfitOrders.error || 'unknown error'}`;
    await saveLastEntryError(errDetail, symbol, type);
    return NextResponse.json({ error: true, message: errDetail }, { status: 502 });
  }

  const currentProfitOrder = pendingProfitOrders.orders.find((order: any) => {
    const planType = String(order?.planType || '').toLowerCase();
    const orderSource = String(order?.orderSource || '').toLowerCase();
    return planType.includes('profit') || orderSource.includes('profit');
  });

  const tpResp = currentProfitOrder?.orderId
    ? await bitgetModifyTpslOrder(symbol, String(currentProfitOrder.orderId), candidateTakeProfit, existing.quantity, tradingMode)
    : await bitgetPlaceTpslMarket(
        symbol,
        'profit_plan',
        existingContext.holdSide,
        candidateTakeProfit,
        existing.quantity,
        createClientOid(symbol),
        tradingMode
      );

  if (!bitgetOrderSuccess(tpResp)) {
    const errDetail = `Bitget no permitio actualizar el TP de ${symbol} en ${tradingMode}. ${summarizeBitgetResponse(tpResp)}.`;
    await saveLastEntryError(errDetail, symbol, type);
    return NextResponse.json({ error: true, message: errDetail, detail: tpResp }, { status: 500 });
  }

  await prisma.position.update({
    where: { id: existing.id },
    data: {
      takeProfit: candidateTakeProfit,
    },
  });

  await writeAuditLog({
    action: 'position.tp_upgraded_from_signal',
    userId: auth?.user?.id,
    targetType: 'position',
    targetId: String(existing.id),
    metadata: {
      symbol,
      tradingMode,
      positionType: existing.positionType,
      managementMode: existing.managementMode,
      previousTakeProfit: currentTakeProfit,
      appliedTakeProfit: candidateTakeProfit,
      requestedTakeProfitPrice,
      requestedTakeProfitPercent,
      resolvedRequestedTakeProfitPrice: takeProfitResolution.resolvedRequestedTakeProfitPrice,
      computedTakeProfitPriceFromPercent: takeProfitResolution.computedTakeProfitPriceFromPercent,
      requestedTakeProfitAccepted: takeProfitResolution.isRequestedTakeProfitValid,
      requestedTakeProfitInputSource: takeProfitResolution.takeProfitInputSource,
      bitgetAction: currentProfitOrder?.orderId ? 'modify-tpsl-order' : 'place-tpsl-order',
      bitgetOrderId: currentProfitOrder?.orderId || null,
      trigger: auth ? auth.authType : 'webhook',
    },
    req,
  });

  const pricePrecision = Number.isFinite(existing.pricePrecision)
    ? Number(existing.pricePrecision)
    : parseInt(exchangeInfo?.pricePlace || '4', 10);

  await notifyAllActiveDevices({
    title: `${symbol} TP ampliado`,
    body: `La posicion #${existing.id} ahora apunta a ${candidateTakeProfit.toFixed(pricePrecision)}.`,
    data: {
      kind: 'position_take_profit_expanded',
      positionId: existing.id,
      symbol,
      tradingMode,
      previousTakeProfit: currentTakeProfit,
      takeProfit: candidateTakeProfit,
    },
  }).catch(() => undefined);

  return NextResponse.json({
    success: true,
    message: `TP actualizado (${tradingMode}) para ${symbol}.`,
    takeProfit: {
      previous: currentTakeProfit,
      applied: candidateTakeProfit,
      source: takeProfitResolution.takeProfitInputSource,
      action: currentProfitOrder?.orderId ? 'modified' : 'created',
    },
  });
}

const extractOrderData = (detailResponse: any) => detailResponse?.data?.[0] || detailResponse?.data || {};
const toDepthFromWsQuote = (quote: any) => {
  if (!quote?.ok || !Number.isFinite(quote.bestBid) || !Number.isFinite(quote.bestAsk)) {
    return null;
  }

  return {
    ok: true,
    bids: [[quote.bestBid.toString(), Number.parseFloat(String(quote.bidSize || 0)).toString()]],
    asks: [[quote.bestAsk.toString(), Number.parseFloat(String(quote.askSize || 0)).toString()]],
    error: null,
    source: 'websocket',
  };
};

const getMakerRetryDelays = () => {
  const rawValue = process.env.BITGET_MAKER_RETRY_DELAYS_MS;
  if (!rawValue) {
    return DEFAULT_MAKER_RETRY_DELAYS_MS;
  }

  const parsed = rawValue
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  return parsed.length > 0 ? parsed : DEFAULT_MAKER_RETRY_DELAYS_MS;
};

async function executeEntry(
  data: any,
  req: NextRequest,
  auth: Awaited<ReturnType<typeof getAuthContext>>
) {
  try {
    const symbol = bitgetNormalizeSymbol(data.symbol || '');
    let amount = parseFloat(data.amount) || 0;
    const type = String(data.type || '').toLowerCase();
    const managementMode = normalizePositionManagementMode(data.mode) as PositionManagementMode;
    const origin = normalizeSignalOrigin(data.origin);
    const timeframe = data.timeframe ? String(data.timeframe) : null;
    const incomingQuantity = parseFloat(data.quantity || data.contracts) || 0;
    const rawRequestedEntryPrice =
      data.entryPrice ??
      data.entry_price ??
      data.entryprice;
    const rawRequestedStopPrice =
      data.stopPrice ??
      data.stop_price ??
      data.stopLoss ??
      data.stop_loss ??
      data.slPrice ??
      data.sl_price ??
      data.slprice;
    const rawRequestedTakeProfitPrice =
      data.takeProfit ??
      data.take_profit ??
      data.targetPrice ??
      data.target_price ??
      data.targetprice ??
      data.tpPrice ??
      data.tp_price ??
      data.tpprice ??
      data.spPrice ??
      data.sp_price ??
      data.sp;
    const rawRequestedStopPercent =
      data.stoploss ??
      data.stopLossPercent ??
      data.stop_loss_percent ??
      data.stoploss_percent ??
      data.stoplossPercent ??
      data.stopPercent ??
      data.stop_percent ??
      data.stoppercent ??
      data.slPercent ??
      data.sl_percent ??
      data.slpercent;
    const rawRequestedTakeProfitPercent =
      data.takeprofit ??
      data.takeProfitPercent ??
      data.take_profit_percent ??
      data.takeprofit_percent ??
      data.takeprofitPercent ??
      data.targetPercent ??
      data.target_percent ??
      data.targetpercent ??
      data.tpPercent ??
      data.tp_percent ??
      data.tppercent;
    const requestedEntryPrice = parseOptionalPrice(
      rawRequestedEntryPrice,
    );
    const requestedStopPrice = parseOptionalPrice(
      rawRequestedStopPrice,
    );
    const requestedTakeProfitPrice = parseOptionalPrice(
      rawRequestedTakeProfitPrice,
    );
    const requestedStopPercent = parseOptionalPercent(
      rawRequestedStopPercent,
    );
    const requestedTakeProfitPercent = parseOptionalPercent(
      rawRequestedTakeProfitPercent,
    );
    const stopInputProvided = hasPayloadValue(rawRequestedStopPrice) || hasPayloadValue(rawRequestedStopPercent);
    const takeProfitInputProvided = hasPayloadValue(rawRequestedTakeProfitPrice) || hasPayloadValue(rawRequestedTakeProfitPercent);
    const allowTakerFallback = data.allowTakerFallback === undefined
      ? true
      : String(data.allowTakerFallback || '').toLowerCase() === 'true';
    const takerFallbackMode = String(data.takerFallbackMode || 'market').toLowerCase() === 'ioc' ? 'ioc' : 'market';

    if (type === 'close') {
      return closePositionFromEntrySignal(data, req, auth);
    }

    const botEnabled = await prisma.setting.findUnique({ where: { key: 'bot_enabled' } });
    if (botEnabled?.value === '0') {
      return NextResponse.json({ success: true, message: 'Bot disabled' });
    }

    const tradingMode = await resolveTradingMode();
    const apiStopModeSetting = await prisma.setting.findUnique({ where: { key: 'api_stop_mode' } });
    const apiStopMode = apiStopModeSetting?.value === 'legacy' ? 'legacy' : 'signal';
    const forcedPositionMode = (() => {
      const raw = String(process.env.BITGET_FORCE_POSITION_MODE || '').trim().toLowerCase();
      if (raw === 'hedge_mode' || raw === 'one_way_mode') {
        return raw as BitgetPositionMode;
      }
      return null;
    })();
    const detectedPositionMode = await bitgetGetPositionMode(symbol, tradingMode);
    let effectivePositionMode = detectedPositionMode || 'one_way_mode';

    if (forcedPositionMode && forcedPositionMode !== effectivePositionMode) {
      const setPositionModeResp = await bitgetSetPositionMode(symbol, forcedPositionMode, tradingMode);
      if (!bitgetOrderSuccess(setPositionModeResp)) {
        const errDetail = `Bitget no permitio fijar position mode ${forcedPositionMode} para ${symbol}. ` +
          `${summarizeBitgetResponse(setPositionModeResp)}.`;
        await saveLastEntryError(errDetail, symbol, type);
        return NextResponse.json({ error: true, message: errDetail, detail: setPositionModeResp }, { status: 500 });
      }
      effectivePositionMode = forcedPositionMode;
    }

    const positionContext = bitgetBuildPositionContext(type as 'buy' | 'sell', effectivePositionMode);
    const openTradeSide = positionContext.openTradeSide;
    const closeTradeSide = positionContext.closeTradeSide;

    const customAmountSetting = await prisma.setting.findUnique({ where: { key: 'custom_amount' } });
    const leverageEnabledSetting = await prisma.setting.findUnique({ where: { key: 'leverage_enabled' } });
    const leverageValueSetting = await prisma.setting.findUnique({ where: { key: 'leverage_value' } });
    const customAmount = parseFloat(String(customAmountSetting?.value || '0').replace(/[^0-9.]/g, ''));
    const leverageEnabled = leverageEnabledSetting?.value === '1';
    const configuredLeverage = Number.parseFloat(String(leverageValueSetting?.value || '1'));
    if (customAmount > 0) {
      amount = customAmount;
    }

    if (!symbol || (amount <= 0 && incomingQuantity <= 0) || !['buy', 'sell'].includes(type)) {
      return NextResponse.json({ error: true, message: 'Invalid parameters' }, { status: 400 });
    }

    if (tradingMode === 'live') {
      if (symbol.endsWith('USDT')) {
        const errDetail = `Modo LIVE detectado: El par ${symbol} (USDT) no esta permitido. Solo se admite USDC.`;
        await saveLastEntryError(errDetail, symbol, type);
        return NextResponse.json({ error: true, message: 'USDT symbols are forbidden in LIVE mode. Use USDC pairs.', detail: errDetail }, { status: 400 });
      }
      if (!symbol.endsWith('USDC')) {
        const errDetail = `Modo LIVE detectado: El par ${symbol} debe ser un par USDC.`;
        await saveLastEntryError(errDetail, symbol, type);
        return NextResponse.json({ error: true, message: 'Only USDC pairs are allowed in LIVE mode.', detail: errDetail }, { status: 400 });
      }
    }

    const existing = await prisma.position.findFirst({
      where: { symbol, status: 'open', tradingMode } as any,
    });

    if (existing) {
      const sameOrigin = isSameOrigin(existing.origin, origin);

      if (existing.positionType === type) {
        if (!sameOrigin) {
          await writeAuditLog({
            action: 'position.same_direction_ignored_origin',
            userId: auth?.user?.id,
            targetType: 'position',
            targetId: String(existing.id),
            metadata: {
              symbol,
              tradingMode,
              existingPositionType: existing.positionType,
              incomingPositionType: type,
              managementMode: existing.managementMode,
              positionOrigin: existing.origin || null,
              signalOrigin: origin,
              trigger: auth ? auth.authType : 'webhook',
            },
            req,
          });

          return NextResponse.json({
            success: true,
            message: `Ignorada (${tradingMode}): Ya existe una posicion abierta en ${symbol} del origin ${existing.origin || 'sin origin'} y la nueva senal llega desde ${origin || 'sin origin'}.`,
          });
        }

        if (!takeProfitInputProvided) {
          return NextResponse.json({ success: true, message: `Ignorada (${tradingMode}): Ya existe una posicion abierta en direccion ${type} para ${symbol}.` });
        }

        const existingExchangeInfo = await bitgetGetExchangeInfo(symbol, tradingMode);
        if (!existingExchangeInfo) {
          const errDetail = `No se pudo obtener la configuracion del contrato de ${symbol} para evaluar mejora de TP sobre posicion existente.`;
          await saveLastEntryError(errDetail, symbol, type);
          return NextResponse.json({ error: true, message: errDetail }, { status: 500 });
        }

        return maybeUpgradeTakeProfitFromSameDirectionSignal({
          existing,
          symbol,
          type: type as 'buy' | 'sell',
          tradingMode,
          effectivePositionMode,
          exchangeInfo: existingExchangeInfo,
          requestedTakeProfitPrice,
          requestedTakeProfitPercent,
          req,
          auth,
        });
      }

      if (!sameOrigin) {
        await writeAuditLog({
          action: 'position.reverse_signal_ignored_origin',
          userId: auth?.user?.id,
          targetType: 'position',
          targetId: String(existing.id),
          metadata: {
            symbol,
            tradingMode,
            existingPositionType: existing.positionType,
            incomingPositionType: type,
            managementMode: existing.managementMode,
            positionOrigin: existing.origin || null,
            signalOrigin: origin,
            trigger: auth ? auth.authType : 'webhook',
          },
          req,
        });

        return NextResponse.json({
          success: true,
          message: `Ignorada (${tradingMode}): Ya existe una posicion abierta en ${symbol} del origin ${existing.origin || 'sin origin'} y no se revierte con una senal opuesta de ${origin || 'sin origin'}.`,
        });
      }

      const closeResult = await closeTrackedPosition(existing);
      if (!closeResult.ok) {
        const errDetail = `Error al cerrar posicion previa de ${symbol} en ${tradingMode} para cambio de direccion del mismo origin. ${closeResult.message}`;
        await saveLastEntryError(errDetail, symbol, type);
        return NextResponse.json({ error: true, message: errDetail, details: closeResult.details }, { status: closeResult.status });
      }

      await writeAuditLog({
        action: 'position.reversed_from_signal',
        userId: auth?.user?.id,
        targetType: 'position',
        targetId: String(existing.id),
        metadata: {
          symbol,
          tradingMode,
          existingPositionType: existing.positionType,
          incomingPositionType: type,
          managementMode: existing.managementMode,
          positionOrigin: existing.origin || null,
          signalOrigin: origin,
          trigger: auth ? auth.authType : 'webhook',
        },
        req,
      });
    }

    const exchangeInfo = await bitgetGetExchangeInfo(symbol, tradingMode);
    if (!exchangeInfo) {
      const errDetail = `No se pudo obtener la configuracion del contrato de ${symbol}.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail }, { status: 500 });
    }

    const wsQuote = await bitgetGetWsBestBidAsk(symbol, tradingMode);
    const depth = toDepthFromWsQuote(wsQuote) || await bitgetGetMergeDepth(symbol, tradingMode);

    if (!depth.ok || depth.bids.length === 0 || depth.asks.length === 0) {
      const errDetail = `No se pudo obtener profundidad para ${symbol}.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail }, { status: 500 });
    }

    const bestBid = parseFloat(depth.bids[0][0]);
    const bestAsk = parseFloat(depth.asks[0][0]);
    const midPrice = (bestBid + bestAsk) / 2;
    const tickSize = bitgetGetTickSize(exchangeInfo);
    const spreadPercent = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : 0;
    const maxSpreadPercent = Number.parseFloat(process.env.BITGET_MAX_SPREAD_PERCENT || `${DEFAULT_MAX_SPREAD_PERCENT}`);
    const maxTakerCostPercent = Number.parseFloat(process.env.BITGET_MAX_TAKER_COST_PERCENT || `${DEFAULT_MAX_TAKER_COST_PERCENT}`);
    const makerRetryDelays = getMakerRetryDelays();

    const vipFees = await bitgetGetVipFeeRates();
    const makerFeeRate = await bitgetGetMakerCommissionRate(symbol, tradingMode);
    const takerFeeRate = await bitgetGetCommissionRate(symbol, tradingMode);
    const fundingRate = await bitgetGetCurrentFundingRate(symbol, tradingMode);
    const pricePrecision = parseInt(exchangeInfo?.pricePlace || '4', 10);
    const minLever = Math.max(1, Number.parseFloat(String(exchangeInfo?.minLever || '1')) || 1);
    const maxLever = Math.max(minLever, Number.parseFloat(String(exchangeInfo?.maxLever || '1')) || 1);
    const requestedLeverage = leverageEnabled ? (Number.isFinite(configuredLeverage) ? configuredLeverage : 1) : 1;
    const appliedLeverage = Math.min(maxLever, Math.max(minLever, requestedLeverage));
    const leverageHoldSide = positionContext.leverageHoldSide;

    const leverageResp = await bitgetSetLeverage(symbol, appliedLeverage, leverageHoldSide, tradingMode);
    if (!bitgetOrderSuccess(leverageResp)) {
      const errDetail = `Bitget no acepto el leverage ${appliedLeverage}x para ${symbol}.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail, detail: leverageResp }, { status: 500 });
    }

    const rawSize = incomingQuantity > 0 ? incomingQuantity : amount / midPrice;
    if (!Number.isFinite(rawSize) || rawSize <= 0) {
      const errDetail = `Invalid quantity calculated for ${symbol}. Amount: ${amount}, Mid: ${midPrice}`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: 'Calculation error' }, { status: 500 });
    }

    const size = bitgetNormalizeSizeByContract(rawSize, exchangeInfo);
    const side = type === 'buy' ? 'BUY' : 'SELL';

    const computeMakerPrice = (bid: number, ask: number) => {
      const raw = type === 'buy'
        ? ask - tickSize
        : bid + tickSize;
      const fallback = type === 'buy' ? bid : ask;
      const valid = type === 'buy'
        ? raw > bid && raw < ask
        : raw > bid && raw < ask;
      return bitgetNormalizePriceByContract(valid ? raw : fallback, exchangeInfo);
    };

    const targetMakerPrice = computeMakerPrice(bestBid, bestAsk);
    const makerNotional = targetMakerPrice * size;
    const expectedMakerFee = makerNotional * makerFeeRate;
    const expectedSpreadCost = Math.abs(targetMakerPrice - midPrice) * size;
    const fundingRisk = fundingRate.ok ? makerNotional * Math.abs(fundingRate.fundingRate) : 0;

    if (spreadPercent > maxSpreadPercent && !allowTakerFallback) {
      const errDetail = `Spread demasiado alto para ${symbol}: ${spreadPercent.toFixed(4)}%.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail }, { status: 409 });
    }

    await bitgetCancelAllOrders(symbol, tradingMode);

    let filledSize = 0;
    let entryPrice = targetMakerPrice;
    let executionMode: 'maker' | 'ioc' | 'market' = 'maker';
    let executionClientOid = '';
    let executionOrderId = '';
    let realEntryFee = expectedMakerFee;
    let lastOrderResponse: any = null;

    for (const delayMs of makerRetryDelays) {
      const attemptWsQuote = await bitgetGetWsBestBidAsk(symbol, tradingMode);
      const attemptDepth = toDepthFromWsQuote(attemptWsQuote) || await bitgetGetMergeDepth(symbol, tradingMode);
      if (!attemptDepth.ok || attemptDepth.bids.length === 0 || attemptDepth.asks.length === 0) {
        continue;
      }

      const bid = parseFloat(attemptDepth.bids[0][0]);
      const ask = parseFloat(attemptDepth.asks[0][0]);
      const makerPrice = computeMakerPrice(bid, ask);
      const clientOid = createClientOid(symbol);
      const makerResp = await bitgetPlaceLimitOrder(symbol, side, size, makerPrice, 'post_only', clientOid, tradingMode, openTradeSide);
      lastOrderResponse = makerResp;

      if (!bitgetOrderSuccess(makerResp)) {
        continue;
      }

      executionClientOid = clientOid;
      executionOrderId = makerResp?.data?.orderId || makerResp?.data?.orderIdStr || '';
      await sleep(delayMs);

      const detailResp = await bitgetGetOrderDetail(symbol, tradingMode, executionOrderId || undefined, clientOid);
      const orderData = extractOrderData(detailResp);
      const accBaseVolume = parseFloat(orderData?.baseVolume || orderData?.filledQty || orderData?.size || '0');
      const status = String(orderData?.state || orderData?.status || '').toLowerCase();

      if (status.includes('filled') || accBaseVolume > 0) {
        filledSize = accBaseVolume > 0 ? accBaseVolume : size;
        entryPrice = parseFloat(orderData?.priceAvg || orderData?.avgPrice || makerPrice.toString()) || makerPrice;

        if (executionOrderId) {
          const fillsResp = await bitgetGetOrderFills(symbol, executionOrderId, tradingMode);
          const fills = Array.isArray(fillsResp?.data) ? fillsResp.data : Array.isArray(fillsResp?.data?.fillList) ? fillsResp.data.fillList : [];
          realEntryFee = fills.reduce((sum: number, fill: any) => sum + Math.abs(parseFloat(fill.fee || '0')), 0) || (filledSize * entryPrice * makerFeeRate);
        }
        break;
      }

      await bitgetCancelOrder(symbol, tradingMode, executionOrderId || undefined, clientOid);
      executionClientOid = '';
      executionOrderId = '';
    }

    if (filledSize <= 0 && allowTakerFallback) {
      const takerReferencePrice = type === 'buy' ? bestAsk : bestBid;
      const takerNotional = takerReferencePrice * size;
      const takerFee = takerNotional * takerFeeRate;
      const takerSpreadCost = Math.abs(takerReferencePrice - midPrice) * size;
      const takerCostPercent = takerNotional > 0 ? ((takerFee + takerSpreadCost) / takerNotional) * 100 : 100;

      if (spreadPercent > maxSpreadPercent || takerCostPercent > maxTakerCostPercent) {
        const errDetail = `Fallback taker bloqueado para ${symbol}. Spread ${spreadPercent.toFixed(4)}% / coste ${takerCostPercent.toFixed(4)}%.`;
        await saveLastEntryError(errDetail, symbol, type);
        return NextResponse.json({ error: true, message: errDetail }, { status: 409 });
      }

      executionClientOid = createClientOid(symbol);
      executionMode = takerFallbackMode;

      if (takerFallbackMode === 'market') {
        const marketResp = await bitgetPlaceMarketOrder(symbol, side, size, tradingMode, openTradeSide);
        lastOrderResponse = marketResp;
        if (!bitgetOrderSuccess(marketResp)) {
          const errDetail = `Fallback market rechazado para ${symbol}.`;
          await saveLastEntryError(errDetail, symbol, type);
          return NextResponse.json({ error: true, message: errDetail, detail: marketResp }, { status: 500 });
        }

        filledSize = size;
        entryPrice = parseFloat(marketResp?.avgPrice || midPrice.toString()) || midPrice;
        realEntryFee = filledSize * entryPrice * takerFeeRate;
      } else {
        const iocPrice = bitgetNormalizePriceByContract(takerReferencePrice, exchangeInfo);
        const iocResp = await bitgetPlaceLimitOrder(symbol, side, size, iocPrice, 'ioc', executionClientOid, tradingMode, openTradeSide);
        lastOrderResponse = iocResp;
        if (!bitgetOrderSuccess(iocResp)) {
          const errDetail = `Fallback IOC rechazado para ${symbol}.`;
          await saveLastEntryError(errDetail, symbol, type);
          return NextResponse.json({ error: true, message: errDetail, detail: iocResp }, { status: 500 });
        }

        executionOrderId = iocResp?.data?.orderId || '';
        await sleep(400);
        const detailResp = await bitgetGetOrderDetail(symbol, tradingMode, executionOrderId || undefined, executionClientOid);
        const orderData = extractOrderData(detailResp);
        const accBaseVolume = parseFloat(orderData?.baseVolume || orderData?.filledQty || orderData?.size || '0');
        if (accBaseVolume <= 0) {
          await bitgetCancelOrder(symbol, tradingMode, executionOrderId || undefined, executionClientOid);
          const errDetail = `IOC no obtuvo ejecucion para ${symbol}.`;
          await saveLastEntryError(errDetail, symbol, type);
          return NextResponse.json({ error: true, message: errDetail }, { status: 409 });
        }

        filledSize = accBaseVolume;
        entryPrice = parseFloat(orderData?.priceAvg || orderData?.avgPrice || iocPrice.toString()) || iocPrice;
        realEntryFee = filledSize * entryPrice * takerFeeRate;
      }
    }

    if (filledSize <= 0) {
      const errDetail = `La orden maker de ${symbol} no se ejecuto dentro de la ventana configurada y no hay fallback taker autorizado.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail, detail: lastOrderResponse }, { status: 409 });
    }

    const slPercent = 1.2 / 100;
    const rawLegacyStopPrice = type === 'buy' ? entryPrice * (1 - slPercent) : entryPrice * (1 + slPercent);
    const stopNormalizeDirection = type === 'buy' ? 'down' : 'up';
    const normalizeExitPrice = (price: number | null, direction: 'down' | 'up') =>
      price !== null
        ? bitgetNormalizePriceByContractDirectional(price, exchangeInfo, direction)
        : null;
    const computedStopPriceFromPercent = requestedStopPercent !== null
      ? (type === 'buy'
          ? entryPrice * (1 - (requestedStopPercent / 100))
          : entryPrice * (1 + (requestedStopPercent / 100)))
      : null;
    const takeProfitResolution = resolveRequestedTakeProfit({
      entryPrice,
      positionType: type as 'buy' | 'sell',
      exchangeInfo,
      requestedTakeProfitPrice,
      requestedTakeProfitPercent,
    });
    const computedTakeProfitPriceFromPercent = takeProfitResolution.computedTakeProfitPriceFromPercent;
    const resolvedRequestedStopPrice = requestedStopPrice !== null
      ? requestedStopPrice
      : computedStopPriceFromPercent;
    const resolvedRequestedTakeProfitPrice = takeProfitResolution.resolvedRequestedTakeProfitPrice;
    const stopInputSource = requestedStopPrice !== null ? 'price' : requestedStopPercent !== null ? 'percent' : 'legacy';
    const takeProfitInputSource = takeProfitResolution.takeProfitInputSource;
    const legacyStopPrice = normalizeExitPrice(rawLegacyStopPrice, stopNormalizeDirection);
    const normalizedRequestedStop = resolvedRequestedStopPrice !== null
      ? normalizeExitPrice(resolvedRequestedStopPrice, stopNormalizeDirection)
      : null;
    const isRequestedStopValid = normalizedRequestedStop !== null &&
      (
        (type === 'buy' && normalizedRequestedStop < entryPrice) ||
        (type === 'sell' && normalizedRequestedStop > entryPrice)
      );
    const normalizedRequestedTakeProfit = takeProfitResolution.normalizedRequestedTakeProfit;
    const isRequestedTakeProfitValid = takeProfitResolution.isRequestedTakeProfitValid;
    const stopPrice = managementMode === 'self'
      ? normalizedRequestedStop
      : (apiStopMode === 'legacy' ? legacyStopPrice : (isRequestedStopValid ? normalizedRequestedStop : legacyStopPrice));
    const takeProfitPrice = isRequestedTakeProfitValid ? normalizedRequestedTakeProfit : null;
    const slSide = positionContext.closeSide;
    const holdSide = positionContext.holdSide;
    const rollbackCloseSide = slSide;
    const shouldRejectInvalidStop = (managementMode === 'self' && stopInputProvided) || hasPayloadValue(rawRequestedStopPercent);
    const shouldRejectInvalidTakeProfit = (managementMode === 'self' && takeProfitInputProvided) || hasPayloadValue(rawRequestedTakeProfitPercent);

    if ((managementMode === 'self' && !isRequestedStopValid) || (shouldRejectInvalidStop && stopInputProvided && !isRequestedStopValid)) {
      await bitgetClosePosition(symbol, rollbackCloseSide, filledSize, tradingMode, closeTradeSide);
      const errDetail = `Stop invalido para ${symbol}. ` +
        `JSON stop=${JSON.stringify(rawRequestedStopPrice)}, stopPercent=${JSON.stringify(rawRequestedStopPercent)}, ` +
        `takeProfit=${JSON.stringify(rawRequestedTakeProfitPrice)}, takeProfitPercent=${JSON.stringify(rawRequestedTakeProfitPercent)}, ` +
        `parsedStop=${requestedStopPrice}, parsedStopPercent=${requestedStopPercent}, resolvedStop=${resolvedRequestedStopPrice}, ` +
        `normalizedStop=${normalizedRequestedStop}, entry=${entryPrice}. ` +
        `Rollback ejecutado.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail }, { status: 400 });
    }

    if (shouldRejectInvalidTakeProfit && takeProfitInputProvided && !isRequestedTakeProfitValid) {
      await bitgetClosePosition(symbol, rollbackCloseSide, filledSize, tradingMode, closeTradeSide);
      const errDetail = `Take profit invalido para ${symbol}. ` +
        `JSON takeProfit=${JSON.stringify(rawRequestedTakeProfitPrice)}, takeProfitPercent=${JSON.stringify(rawRequestedTakeProfitPercent)}, ` +
        `parsedTakeProfit=${requestedTakeProfitPrice}, parsedTakeProfitPercent=${requestedTakeProfitPercent}, ` +
        `resolvedTakeProfit=${resolvedRequestedTakeProfitPrice}, normalizedTakeProfit=${normalizedRequestedTakeProfit}, entry=${entryPrice}. ` +
        `Rollback ejecutado.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail }, { status: 400 });
    }

    const shouldPlaceInitialStop = stopPrice !== null;
    const shouldPlaceInitialTakeProfit = takeProfitPrice !== null;
    let slResponse: any = null;
    let tpResponse: any = null;
    let initialStopAttempts = 0;
    let initialTakeProfitAttempts = 0;
    let initialTakeProfitPending = false;
    let persistedTakeProfitPrice = takeProfitPrice;

    if (shouldPlaceInitialStop) {
      const stopPlacement = await placeProtectionOrderWithRetries({
        kind: 'stop',
        symbol,
        tradingMode,
        place: () => bitgetPlaceStopMarket(symbol, slSide, stopPrice!, filledSize, tradingMode, closeTradeSide),
      });
      slResponse = stopPlacement.response;
      initialStopAttempts = stopPlacement.attempts;
    }

    if (shouldPlaceInitialStop && !bitgetOrderSuccess(slResponse)) {
      await bitgetCancelAllOrders(symbol, tradingMode);
      await bitgetClosePosition(symbol, rollbackCloseSide, filledSize, tradingMode, closeTradeSide);
      const errDetail = `SL rechazado por Bitget (${tradingMode}) para ${symbol}. ` +
        `${summarizeBitgetResponse(slResponse)}. Intentos=${initialStopAttempts || 1}. Rollback ejecutado.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail, detail: slResponse }, { status: 500 });
    }

    if (shouldPlaceInitialTakeProfit) {
      const takeProfitPlacement = await placeProtectionOrderWithRetries({
        kind: 'takeProfit',
        symbol,
        tradingMode,
        place: () => bitgetPlaceTpslMarket(
          symbol,
          'profit_plan',
          holdSide,
          takeProfitPrice!,
          filledSize,
          createClientOid(symbol),
          tradingMode
        ),
      });
      tpResponse = takeProfitPlacement.response;
      initialTakeProfitAttempts = takeProfitPlacement.attempts;
      initialTakeProfitPending = takeProfitPlacement.exhaustedRetryable;
    }

    if (shouldPlaceInitialTakeProfit && !bitgetOrderSuccess(tpResponse) && !initialTakeProfitPending) {
      await bitgetCancelAllOrders(symbol, tradingMode);
      await bitgetClosePosition(symbol, rollbackCloseSide, filledSize, tradingMode, closeTradeSide);
      const errDetail = `TP rechazado por Bitget (${tradingMode}) para ${symbol}. ` +
        `${summarizeBitgetResponse(tpResponse)}. Intentos=${initialTakeProfitAttempts || 1}. Rollback ejecutado.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail, detail: tpResponse }, { status: 500 });
    }

    if (initialTakeProfitPending) {
      persistedTakeProfitPrice = takeProfitPrice;
    }

    const createdPosition = await prisma.position.create({
      data: {
        symbol,
        positionType: type,
        managementMode,
        amount,
        quantity: filledSize,
        entryPrice,
        requestedEntryPrice,
        stopLoss: stopPrice!,
        takeProfit: persistedTakeProfitPrice,
        status: 'open',
        tradingMode,
        origin,
        timeframe,
        commission: (executionMode === 'maker' ? makerFeeRate : takerFeeRate) as any,
        pricePrecision,
      },
    } as any);

    await writeAuditLog({
      action: 'position.open',
      userId: auth?.user.id,
      targetType: 'position',
      targetId: String(createdPosition.id),
      metadata: {
        symbol,
        tradingMode,
        managementMode,
        type,
        amount,
        quantity: filledSize,
        trigger: auth ? auth.authType : 'webhook',
        executionMode,
        clientOid: executionClientOid,
        orderId: executionOrderId,
        targetMakerPrice,
        bestBid,
        bestAsk,
        spreadPercent,
        expectedMakerFee,
        expectedSpreadCost,
        fundingRisk,
        leverageEnabled,
        leverageRequested: requestedLeverage,
        leverageApplied: appliedLeverage,
        leverageHoldSide,
        detectedPositionMode,
        forcedPositionMode,
        effectivePositionMode,
        contractMinLever: minLever,
        contractMaxLever: maxLever,
        marketDataSource: wsQuote.ok ? 'websocket' : 'rest',
        vipMakerFee: vipFees.makerFeeRate,
        vipTakerFee: vipFees.takerFeeRate,
        realEntryFee,
        requestedEntryPrice,
        requestedStopPrice,
        requestedStopPercent,
        requestedStopInputSource: stopInputSource,
        apiStopMode,
        computedStopPriceFromPercent,
        resolvedRequestedStopPrice,
        normalizedRequestedStop,
        requestedStopAccepted: isRequestedStopValid,
        legacyStopPrice,
        appliedStopPrice: stopPrice,
        initialStopOrderPlaced: shouldPlaceInitialStop,
        requestedTakeProfitPrice,
        requestedTakeProfitPercent,
        requestedTakeProfitInputSource: takeProfitInputSource,
        computedTakeProfitPriceFromPercent,
        resolvedRequestedTakeProfitPrice,
        normalizedRequestedTakeProfit,
        requestedTakeProfitAccepted: isRequestedTakeProfitValid,
        appliedTakeProfitPrice: persistedTakeProfitPrice,
        initialTakeProfitOrderPlaced: shouldPlaceInitialTakeProfit && !initialTakeProfitPending && bitgetOrderSuccess(tpResponse),
        initialTakeProfitPending,
        initialTakeProfitAttempts,
        initialStopAttempts,
        initialTakeProfitResponseCode: getBitgetResponseCode(tpResponse),
      },
      req,
    });

    if (initialTakeProfitPending) {
      await writeAuditLog({
        action: 'position.open.tp_pending',
        userId: auth?.user?.id,
        targetType: 'position',
        targetId: String(createdPosition.id),
        metadata: {
          symbol,
          tradingMode,
          type,
          requestedTakeProfitPrice,
          requestedTakeProfitPercent,
          appliedTakeProfitPrice: takeProfitPrice,
          quantity: filledSize,
          attempts: initialTakeProfitAttempts,
          responseCode: getBitgetResponseCode(tpResponse),
          responseSummary: summarizeBitgetResponse(tpResponse),
          trigger: auth ? auth.authType : 'webhook',
        },
        req,
      });
    }

    await notifyAllActiveDevices({
      title: initialTakeProfitPending ? `${symbol} abierta con TP pendiente` : `${symbol} abierta`,
      body: initialTakeProfitPending
        ? `Nueva posicion ${type.toUpperCase()} en ${tradingMode.toUpperCase()} @ ${entryPrice.toFixed(pricePrecision)}. El TP ha quedado pendiente en Bitget.`
        : `Nueva posicion ${type.toUpperCase()} en ${tradingMode.toUpperCase()} @ ${entryPrice.toFixed(pricePrecision)}.`,
      data: {
        kind: initialTakeProfitPending ? 'position_opened_tp_pending' : 'position_opened',
        positionId: createdPosition.id,
        symbol,
        tradingMode,
        positionType: type,
        entryPrice: Number(entryPrice.toFixed(pricePrecision)),
      },
    }).catch(() => undefined);

    await prisma.setting.upsert({
      where: { key: 'last_entry_error' },
      update: { value: '' },
      create: { key: 'last_entry_error', value: '' },
    });

    return NextResponse.json({
      success: true,
      message: initialTakeProfitPending
        ? `Position opened in ${tradingMode} for ${symbol} with TP pending on Bitget`
        : `Position opened in ${tradingMode} for ${symbol}`,
      managementMode,
      positionMode: effectivePositionMode,
      executionMode,
      entryPrice,
      quantity: filledSize,
      costs: {
        expectedMakerFee,
        expectedSpreadCost,
        fundingRisk,
        realEntryFee,
      },
      stop: {
        mode: managementMode === 'self'
          ? stopInputSource
          : (apiStopMode === 'legacy' ? 'legacy' : (isRequestedStopValid ? stopInputSource : 'legacy')),
        requested: requestedStopPrice,
        requestedPercent: requestedStopPercent,
        resolved: resolvedRequestedStopPrice,
        accepted: isRequestedStopValid,
        applied: stopPrice,
        fallback: legacyStopPrice,
        orderPlaced: shouldPlaceInitialStop,
      },
      takeProfit: {
        requested: requestedTakeProfitPrice,
        requestedPercent: requestedTakeProfitPercent,
        resolved: resolvedRequestedTakeProfitPrice,
        accepted: isRequestedTakeProfitValid,
        applied: persistedTakeProfitPrice,
        orderPlaced: shouldPlaceInitialTakeProfit && !initialTakeProfitPending && bitgetOrderSuccess(tpResponse),
        pending: initialTakeProfitPending,
        attempts: initialTakeProfitAttempts,
      },
    });
  } catch (error: any) {
    const errDetail = `Excepcion inesperada: ${error.message}`;
    try {
      await saveLastEntryError(errDetail, 'N/A', 'N/A');
    } catch {}
    return NextResponse.json({ error: true, message: error.message, detail: errDetail }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await getAuthContext(req);

  let data: any;
  try {
    data = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: true, message: 'Invalid JSON syntax from webhook.' }, { status: 400 });
  }

  const isExternalWebhook = !auth?.user;

  if (isExternalWebhook) {
    waitUntil(
      executeEntry(data, req, auth).catch(async (error: any) => {
        try {
          const symbol = bitgetNormalizeSymbol(data?.symbol || 'N/A');
          const type = String(data?.type || 'N/A');
          await writeAuditLog({
            action: 'entry.async_failed',
            userId: auth?.user?.id,
            targetType: 'entry',
            targetId: symbol,
            metadata: {
              symbol,
              type,
              detail: error?.message || 'unknown error',
              requestBody: data,
            },
            req,
          });
          await saveLastEntryError(`Excepcion async entry: ${error?.message || 'unknown error'}`, symbol, type);
        } catch {
          return;
        }
      })
    );

    return NextResponse.json({
      success: true,
      message: 'Entry accepted for background processing',
    });
  }

  return executeEntry(data, req, auth);
}

async function saveLastEntryError(detail: string, symbol: string, type: string) {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    symbol,
    type,
    detail,
  });

  try {
    await prisma.setting.upsert({
      where: { key: 'last_entry_error' },
      update: { value: payload },
      create: { key: 'last_entry_error', value: payload },
    });
  } catch (error) {
    console.error('Could not save last_entry_error:', error);
  }
}
