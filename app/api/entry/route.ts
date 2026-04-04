// app/api/entry/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { 
  bitgetGetPrice, 
  bitgetPlaceMarketOrder, 
  bitgetPlaceStopMarket, 
  bitgetOrderSuccess, 
  bitgetClosePosition, 
  bitgetCancelAllOrders, 
  bitgetGetExchangeInfo, 
  bitgetGetCommissionRate, 
  formatQuantity,
  bitgetNormalizeSymbol
} from '@/lib/bitget';

type TradingMode = 'demo' | 'live';

export async function POST(req: NextRequest) {
  try {
    let data;
    try {
      const rawText = await req.text();
      data = JSON.parse(rawText);
    } catch (parseError) {
      return NextResponse.json({ error: true, message: 'Invalid JSON syntax from webhook.' }, { status: 400 });
    }
    const symbol = bitgetNormalizeSymbol(data.symbol || '');
    let amount = parseFloat(data.amount) || 0;
    const type = (data.type || '').toLowerCase();
    const origin = data.origin ? String(data.origin) : null;
    const timeframe = data.timeframe ? String(data.timeframe) : null;
    const incomingQuantity = parseFloat(data.quantity || data.contracts) || 0;

    // Check bot configuration
    const botEnabled = await prisma.setting.findUnique({ where: { key: 'bot_enabled' } });
    if (botEnabled?.value === '0') {
      return NextResponse.json({ success: true, message: 'Bot disabled' });
    }

    // Fetch active trading mode
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

    // USDC/USDT Logic for LIVE mode
    if (tradingMode === 'live') {
      if (symbol.endsWith('USDT')) {
        const errDetail = `Modo LIVE detectado: El par ${symbol} (USDT) no está permitido. Solo se admite USDC.`;
        await saveLastEntryError(errDetail, symbol, type);
        return NextResponse.json({ 
          error: true, 
          message: 'USDT symbols are forbidden in LIVE mode. Use USDC pairs.',
          detail: errDetail 
        }, { status: 400 });
      }
      if (!symbol.endsWith('USDC')) {
        const errDetail = `Modo LIVE detectado: El par ${symbol} debe ser un par USDC.`;
        await saveLastEntryError(errDetail, symbol, type);
        return NextResponse.json({ 
          error: true, 
          message: 'Only USDC pairs are allowed in LIVE mode.',
          detail: errDetail 
        }, { status: 400 });
      }
    }

    // Logic for entry/change of direction (within same mode)
    const existing = await prisma.position.findFirst({
      where: { symbol, status: 'open', tradingMode } as any,
    });

    if (existing) {
      if (existing.positionType === type) {
        console.log(`[ENTRY] [${tradingMode}] Ignoring signal for ${symbol}: Position in direction ${type} is already open.`);
        return NextResponse.json({ 
          success: true, 
          message: `Ignorada (${tradingMode}): Ya existe una posición abierta en dirección ${type} para ${symbol}.` 
        });
      } else {
        console.log(`[ENTRY] [${tradingMode}] Changing direction for ${symbol}: Closing ${existing.positionType} to open ${type}.`);
        
        // 1. Cancel SL and any other orders first
        await bitgetCancelAllOrders(symbol, tradingMode);
        
        // 2. Close the actual position
        const closeSide = existing.positionType === 'buy' ? 'SELL' : 'BUY';
        const closeResp = await bitgetClosePosition(symbol, closeSide as 'BUY' | 'SELL', existing.quantity, tradingMode);

        if (bitgetOrderSuccess(closeResp)) {
          const currentPrice = (await bitgetGetPrice(symbol, tradingMode)) || existing.entryPrice;
          const comm = await bitgetGetCommissionRate(symbol, tradingMode);
          const entryCost = existing.entryPrice * existing.quantity * ((existing as any).commission ?? 0.0004);
          const exitCost = currentPrice * existing.quantity * comm;

          const profitFiat = existing.positionType === 'buy'
            ? ((currentPrice - existing.entryPrice) * existing.quantity) - entryCost - exitCost
            : ((existing.entryPrice - currentPrice) * existing.quantity) - entryCost - exitCost;
          
          const profitPercent = (profitFiat / (existing.entryPrice * existing.quantity)) * 100;

          await prisma.position.update({
            where: { id: existing.id },
            data: {
              status: 'closed',
              closedAt: new Date(),
              profitLossPercent: profitPercent,
              profitLossFiat: profitFiat,
            },
          });
          console.log(`[ENTRY] [${tradingMode}] Previous position ${symbol} closed successfully.`);
        } else {
          const errDetail = `Error al cerrar posición previa de ${symbol} en ${tradingMode} para cambio de dirección.`;
          await saveLastEntryError(errDetail, symbol, type);
          return NextResponse.json({ error: true, message: errDetail, detail: closeResp }, { status: 500 });
        }
      }
    }

    // Open new position
    const price = await bitgetGetPrice(symbol, tradingMode);
    if (!price) {
      const errDetail = `No se pudo obtener el precio de ${symbol} desde Bitget (${tradingMode}).`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail }, { status: 500 });
    }

    const exchangeInfo = await bitgetGetExchangeInfo(symbol, tradingMode);
    const commission = await bitgetGetCommissionRate(symbol, tradingMode);
    
    let quantityRaw = 0;
    if (incomingQuantity > 0) {
      quantityRaw = incomingQuantity;
    } else {
      quantityRaw = amount / price;
    }
    
    if (isNaN(quantityRaw) || quantityRaw <= 0) {
      const errDetail = `Invalid quantity calculated: ${quantityRaw}. Amount: ${amount}, Price: ${price}`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: 'Calculation error' }, { status: 500 });
    }

    const quantityFormatted = parseFloat(formatQuantity(quantityRaw, exchangeInfo));
    const side = type === 'buy' ? 'BUY' : 'SELL';

    // Ensure clean slate before opening
    await bitgetCancelAllOrders(symbol, tradingMode);

    const orderResponse = await bitgetPlaceMarketOrder(symbol, side, quantityFormatted, tradingMode);

    if (!bitgetOrderSuccess(orderResponse)) {
      const binanceMsg = orderResponse?.msg || orderResponse?.message || JSON.stringify(orderResponse);
      const binanceCode = orderResponse?.code ?? 'N/A';
      const errDetail = `Bitget (${tradingMode}) rechazó la orden MARKET ${side} ${quantityFormatted} ${symbol}. Código: ${binanceCode} — ${binanceMsg}`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: 'Failed to open position', detail: errDetail, bitget: orderResponse }, { status: 500 });
    }

    const entryPrice = parseFloat(orderResponse.avgPrice) || price;

    // Place SL
    const slPercent = 1.2 / 100;
    const stopPrice = type === 'buy' ? entryPrice * (1 - slPercent) : entryPrice * (1 + slPercent);
    const slSide = type === 'buy' ? 'SELL' : 'BUY';

    const slResponse = await bitgetPlaceStopMarket(symbol, slSide as 'BUY' | 'SELL', stopPrice, quantityFormatted, tradingMode);

    if (!bitgetOrderSuccess(slResponse)) {
      // Rollback
      await bitgetClosePosition(symbol, side as 'BUY' | 'SELL', quantityFormatted, tradingMode);
      const slMsg = slResponse?.msg || slResponse?.message || JSON.stringify(slResponse);
      const slCode = slResponse?.code ?? 'N/A';
      const errDetail = `SL rechazado por Bitget (${tradingMode}) para ${symbol}. Rollback ejecutado.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: 'Failed to place SL, rolled back', detail: errDetail, bitget: slResponse }, { status: 500 });
    }

    // Save to DB
    await prisma.position.create({
      data: {
        symbol,
        positionType: type,
        amount,
        quantity: quantityFormatted,
        entryPrice,
        stopLoss: stopPrice,
        status: 'open',
        tradingMode,
        origin,
        timeframe,
        commission: commission as any,
      },
    } as any);

    // Clear last entry error on success
    await prisma.setting.upsert({
      where: { key: 'last_entry_error' },
      update: { value: '' },
      create: { key: 'last_entry_error', value: '' },
    });

    return NextResponse.json({ success: true, message: `Position opened in ${tradingMode} for ${symbol}` });
  } catch (error: any) {
    const errDetail = `Excepción inesperada: ${error.message}`;
    try { await saveLastEntryError(errDetail, 'N/A', 'N/A'); } catch (_) {}
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
  } catch (e) {
    console.error('Could not save last_entry_error:', e);
  }
}
