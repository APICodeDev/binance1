export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';
import {
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
  bitgetGetPrice,
  bitgetGetTickSize,
  bitgetGetVipFeeRates,
  bitgetNormalizePriceByContract,
  bitgetNormalizeSizeByContract,
  bitgetNormalizeSymbol,
  bitgetOrderSuccess,
  bitgetPlaceLimitOrder,
  bitgetPlaceMarketOrder,
  bitgetPlaceStopMarket,
} from '@/lib/bitget';

type TradingMode = 'demo' | 'live';

const DEFAULT_MAKER_RETRY_DELAYS_MS = [1200, 1800, 2500];
const DEFAULT_MAX_SPREAD_PERCENT = 0.12;
const DEFAULT_MAX_TAKER_COST_PERCENT = 0.2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const createClientOid = (symbol: string) =>
  `bgd-${symbol.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const extractOrderData = (detailResponse: any) => detailResponse?.data?.[0] || detailResponse?.data || {};
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

export async function POST(req: NextRequest) {
  const auth = await getAuthContext(req);

  try {
    let data: any;
    try {
      data = JSON.parse(await req.text());
    } catch {
      return NextResponse.json({ error: true, message: 'Invalid JSON syntax from webhook.' }, { status: 400 });
    }

    const symbol = bitgetNormalizeSymbol(data.symbol || '');
    let amount = parseFloat(data.amount) || 0;
    const type = String(data.type || '').toLowerCase();
    const origin = data.origin ? String(data.origin) : null;
    const timeframe = data.timeframe ? String(data.timeframe) : null;
    const incomingQuantity = parseFloat(data.quantity || data.contracts) || 0;
    const allowTakerFallback = String(data.allowTakerFallback || '').toLowerCase() === 'true';
    const takerFallbackMode = String(data.takerFallbackMode || 'ioc').toLowerCase() === 'market' ? 'market' : 'ioc';

    const botEnabled = await prisma.setting.findUnique({ where: { key: 'bot_enabled' } });
    if (botEnabled?.value === '0') {
      return NextResponse.json({ success: true, message: 'Bot disabled' });
    }

    const modeSetting = await prisma.setting.findUnique({ where: { key: 'trading_mode' } });
    const tradingMode = (modeSetting?.value || 'demo') as TradingMode;

    const customAmountSetting = await prisma.setting.findUnique({ where: { key: 'custom_amount' } });
    const customAmount = parseFloat(String(customAmountSetting?.value || '0').replace(/[^0-9.]/g, ''));
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
      if (existing.positionType === type) {
        return NextResponse.json({ success: true, message: `Ignorada (${tradingMode}): Ya existe una posicion abierta en direccion ${type} para ${symbol}.` });
      }

      await bitgetCancelAllOrders(symbol, tradingMode);
      const closeSide = existing.positionType === 'buy' ? 'SELL' : 'BUY';
      const closeResp = await bitgetClosePosition(symbol, closeSide as 'BUY' | 'SELL', existing.quantity, tradingMode);
      if (!bitgetOrderSuccess(closeResp)) {
        const errDetail = `Error al cerrar posicion previa de ${symbol} en ${tradingMode} para cambio de direccion.`;
        await saveLastEntryError(errDetail, symbol, type);
        return NextResponse.json({ error: true, message: errDetail, detail: closeResp }, { status: 500 });
      }

      const currentPrice = (await bitgetGetPrice(symbol, tradingMode)) || existing.entryPrice;
      const exitComm = await bitgetGetCommissionRate(symbol, tradingMode);
      const entryComm = (existing as any).commission ?? exitComm;
      const entryCost = existing.entryPrice * existing.quantity * entryComm;
      const exitCost = currentPrice * existing.quantity * exitComm;
      const profitFiat = existing.positionType === 'buy'
        ? ((currentPrice - existing.entryPrice) * existing.quantity) - entryCost - exitCost
        : ((existing.entryPrice - currentPrice) * existing.quantity) - entryCost - exitCost;
      const profitPercent = existing.positionType === 'buy'
        ? ((currentPrice - existing.entryPrice) / existing.entryPrice) * 100
        : ((existing.entryPrice - currentPrice) / existing.entryPrice) * 100;

      await prisma.position.update({
        where: { id: existing.id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          profitLossPercent: profitPercent,
          profitLossFiat: profitFiat,
        },
      });
    }

    const exchangeInfo = await bitgetGetExchangeInfo(symbol, tradingMode);
    if (!exchangeInfo) {
      const errDetail = `No se pudo obtener la configuracion del contrato de ${symbol}.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail }, { status: 500 });
    }

    const depth = await bitgetGetMergeDepth(symbol, tradingMode);
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
        ? Math.min(ask - tickSize, bid + tickSize)
        : Math.max(bid + tickSize, ask - tickSize);
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
      const attemptDepth = await bitgetGetMergeDepth(symbol, tradingMode);
      if (!attemptDepth.ok || attemptDepth.bids.length === 0 || attemptDepth.asks.length === 0) {
        continue;
      }

      const bid = parseFloat(attemptDepth.bids[0][0]);
      const ask = parseFloat(attemptDepth.asks[0][0]);
      const makerPrice = computeMakerPrice(bid, ask);
      const clientOid = createClientOid(symbol);
      const makerResp = await bitgetPlaceLimitOrder(symbol, side, size, makerPrice, 'post_only', clientOid, tradingMode);
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
        const marketResp = await bitgetPlaceMarketOrder(symbol, side, size, tradingMode);
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
        const iocResp = await bitgetPlaceLimitOrder(symbol, side, size, iocPrice, 'ioc', executionClientOid, tradingMode);
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
    const rawStopPrice = type === 'buy' ? entryPrice * (1 - slPercent) : entryPrice * (1 + slPercent);
    const stopPrice = bitgetNormalizePriceByContract(rawStopPrice, exchangeInfo);
    const slSide = type === 'buy' ? 'SELL' : 'BUY';
    const slResponse = await bitgetPlaceStopMarket(symbol, slSide as 'BUY' | 'SELL', stopPrice, filledSize, tradingMode);

    if (!bitgetOrderSuccess(slResponse)) {
      await bitgetClosePosition(symbol, side as 'BUY' | 'SELL', filledSize, tradingMode);
      const errDetail = `SL rechazado por Bitget (${tradingMode}) para ${symbol}. Rollback ejecutado.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail, detail: slResponse }, { status: 500 });
    }

    await prisma.position.create({
      data: {
        symbol,
        positionType: type,
        amount,
        quantity: filledSize,
        entryPrice,
        stopLoss: stopPrice,
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
      metadata: {
        symbol,
        tradingMode,
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
        vipMakerFee: vipFees.makerFeeRate,
        vipTakerFee: vipFees.takerFeeRate,
        realEntryFee,
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
      message: `Position opened in ${tradingMode} for ${symbol}`,
      executionMode,
      entryPrice,
      quantity: filledSize,
      costs: {
        expectedMakerFee,
        expectedSpreadCost,
        fundingRisk,
        realEntryFee,
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
