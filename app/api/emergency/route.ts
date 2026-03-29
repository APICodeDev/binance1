// app/api/emergency/route.ts
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { 
  binanceGetPrice, 
  binanceCancelAllOrders, 
  binanceClosePosition, 
  binanceOrderSuccess 
} from '@/lib/binance';

export async function POST() {
  const openPositions = await prisma.position.findMany({ where: { status: 'open' } });
  const results: string[] = [];

  for (const pos of openPositions) {
    const symbol = pos.symbol.toUpperCase();
    const currentPrice = await binanceGetPrice(symbol);
    if (!currentPrice) {
      results.push(`Error fetching price for ${symbol}`);
      continue;
    }

    const closeSide = pos.positionType === 'buy' ? 'SELL' : 'BUY';
    await binanceCancelAllOrders(symbol);
    const closeResp = await binanceClosePosition(symbol, closeSide, pos.quantity);

    if (binanceOrderSuccess(closeResp)) {
        const profitPercent = pos.positionType === 'buy'
            ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
        const profitFiat = pos.positionType === 'buy'
            ? (currentPrice - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - currentPrice) * pos.quantity;

      await prisma.position.update({
        where: { id: pos.id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          profitLossPercent: profitPercent,
          profitLossFiat: profitFiat,
        },
      });
      results.push(`Successfully closed #${pos.id} (${symbol})`);
    } else {
      results.push(`Failed to close #${pos.id} (${symbol})`);
    }
  }

  return NextResponse.json({ success: true, results });
}
