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
  formatQuantity 
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
    const symbol = (data.symbol || '').toUpperCase();
    let amount = parseFloat(data.amount) || 0;
    const type = (data.type || '').toLowerCase();
    const origin = data.origin ? String(data.origin) : null;
    const timeframe = data.timeframe ? String(data.timeframe) : null;

    // Check bot configuration
    const botEnabled = await prisma.setting.findUnique({ where: { key: 'bot_enabled' } });
    if (botEnabled?.value === '0') {
      return NextResponse.json({ success: true, message: 'Bot disabled' });
    }

    const customAmountSetting = await prisma.setting.findUnique({ where: { key: 'custom_amount' } });
    const customAmount = parseFloat(customAmountSetting?.value || '0');
    if (customAmount > 0) {
      amount = customAmount;
    }

    if (!symbol || amount <= 0 || !['buy', 'sell'].includes(type)) {
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
    if (!price) return NextResponse.json({ error: true, message: 'Failed to fetch price' }, { status: 500 });

    const exchangeInfo = await binanceGetExchangeInfo(symbol);
    const commission = await binanceGetCommissionRate(symbol);
    const quantityRaw = amount / price;
    const quantityFormatted = parseFloat(formatQuantity(quantityRaw, exchangeInfo));

    const side = type === 'buy' ? 'BUY' : 'SELL';
    const orderResponse = await binancePlaceMarketOrder(symbol, side, quantityFormatted);

    if (!binanceOrderSuccess(orderResponse)) {
      return NextResponse.json({ error: true, message: 'Failed to open position', details: orderResponse }, { status: 500 });
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
      return NextResponse.json({ error: true, message: 'Failed to place SL, rolled back' }, { status: 500 });
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

    return NextResponse.json({ success: true, message: `Position # opened for ${symbol}` });
  } catch (error: any) {
    return NextResponse.json({ error: true, message: error.message }, { status: 500 });
  }
}
