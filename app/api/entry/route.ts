// app/api/entry/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { 
  binanceGetPrice, 
  binancePlaceMarketOrder, 
  binancePlaceStopMarket, 
  binanceOrderSuccess, 
  binanceClosePosition, 
  binanceCancelAllOrders, 
  binanceGetExchangeInfo, 
  binanceGetCommissionRate, 
  formatQuantity,
  binanceNormalizeSymbol
} from '@/lib/binance';

export async function POST(req: NextRequest) {
  try {
    let data;
    try {
      const rawText = await req.text();
      data = JSON.parse(rawText);
    } catch (parseError) {
      return NextResponse.json({ error: true, message: 'Invalid JSON syntax from webhook.' }, { status: 400 });
    }
    const symbol = binanceNormalizeSymbol(data.symbol || '');
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

    const customAmountSetting = await prisma.setting.findUnique({ where: { key: 'custom_amount' } });
    const customAmount = parseFloat(String(customAmountSetting?.value || '0').replace(/[^0-9.]/g, ''));
    if (customAmount > 0) {
      amount = customAmount;
    }

    // Safety check for outrageous amounts (e.g. phone numbers pasted by mistake)
    if (amount > 1000000) {
      const errDetail = `Amount ${amount} USDT seems way too high. Limit is 1,000,000 for safety.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: 'Invest amount exceeded safety limits.' }, { status: 400 });
    }

    if (!symbol || (amount <= 0 && incomingQuantity <= 0) || !['buy', 'sell'].includes(type)) {
      return NextResponse.json({ error: true, message: 'Invalid parameters' }, { status: 400 });
    }

    // Logic for entry/change of direction
    const existing = await prisma.position.findFirst({
      where: { symbol, status: 'open' },
    });

    if (existing) {
      if (existing.positionType === type) {
        return NextResponse.json({ success: true, message: 'Position already open' });
      } else {
        // Change direction: Close current and continue
        const currentPrice = await binanceGetPrice(symbol);
        if (currentPrice) {
          await binanceCancelAllOrders(symbol);
          const closeSide = existing.positionType === 'buy' ? 'SELL' : 'BUY';
          const closeResp = await binanceClosePosition(symbol, closeSide as 'BUY' | 'SELL', existing.quantity);

          if (binanceOrderSuccess(closeResp)) {
            const comm = await binanceGetCommissionRate(symbol);
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
          } else {
            return NextResponse.json({ error: true, message: 'Failed to close previous position' }, { status: 500 });
          }
        }
      }
    }

    // Open new position
    const price = await binanceGetPrice(symbol);
    if (!price) {
      const errDetail = `No se pudo obtener el precio de ${symbol} desde Binance.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: errDetail }, { status: 500 });
    }

    const exchangeInfo = await binanceGetExchangeInfo(symbol);
    const commission = await binanceGetCommissionRate(symbol);
    
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

    // Ensure clean slate before opening: cancel any previous orders (orphan or intentional)
    await binanceCancelAllOrders(symbol);

    const orderResponse = await binancePlaceMarketOrder(symbol, side, quantityFormatted);

    if (!binanceOrderSuccess(orderResponse)) {
      const binanceMsg = orderResponse?.msg || orderResponse?.message || JSON.stringify(orderResponse);
      const binanceCode = orderResponse?.code ?? 'N/A';
      const errDetail = `Binance rechazó la orden MARKET ${side} ${quantityFormatted} ${symbol}. Código: ${binanceCode} — ${binanceMsg}`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: 'Failed to open position', detail: errDetail, binance: orderResponse }, { status: 500 });
    }

    const entryPrice = parseFloat(orderResponse.avgPrice) || price;

    // Place SL
    const slPercent = 1.2 / 100;
    const stopPrice = type === 'buy' ? entryPrice * (1 - slPercent) : entryPrice * (1 + slPercent);
    const slSide = type === 'buy' ? 'SELL' : 'BUY';

    const slResponse = await binancePlaceStopMarket(symbol, slSide as 'BUY' | 'SELL', stopPrice, quantityFormatted);

    if (!binanceOrderSuccess(slResponse)) {
      // Rollback
      await binanceClosePosition(symbol, side as 'BUY' | 'SELL', quantityFormatted);
      const slMsg = slResponse?.msg || slResponse?.message || JSON.stringify(slResponse);
      const slCode = slResponse?.code ?? 'N/A';
      const errDetail = `SL rechazado por Binance para ${symbol}. Código: ${slCode} — ${slMsg}. Rollback ejecutado.`;
      await saveLastEntryError(errDetail, symbol, type);
      return NextResponse.json({ error: true, message: 'Failed to place SL, rolled back', detail: errDetail, binance: slResponse }, { status: 500 });
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

    return NextResponse.json({ success: true, message: `Position # opened for ${symbol}` });
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
