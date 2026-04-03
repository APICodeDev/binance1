// app/api/emergency/route.ts
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { 
  binanceGetPrice, 
  binanceCancelAllOrders, 
  binanceClosePosition, 
  binanceOrderSuccess,
  binanceGetCommissionRate
} from '@/lib/binance';

export async function POST() {
  const openPositions = await prisma.position.findMany({ where: { status: 'open' } });
  const results: string[] = [];

  for (const pos of openPositions) {
    const mode = ((pos as any).tradingMode || 'demo') as 'demo' | 'live';
    const symbol = pos.symbol.toUpperCase();
    const currentPrice = await binanceGetPrice(symbol, mode);
    if (!currentPrice) {
      results.push(`Error fetching price for ${symbol} in ${mode}`);
      continue;
    }

    const comm = await binanceGetCommissionRate(symbol, mode);
    const entryComm = (pos as any).commission ?? 0.0004;

    const closeSide = pos.positionType === 'buy' ? 'SELL' : 'BUY';
    await binanceCancelAllOrders(symbol, mode);
    const closeResp = await binanceClosePosition(symbol, closeSide, pos.quantity, mode);

    if (binanceOrderSuccess(closeResp)) {
      const entryCost = pos.entryPrice * pos.quantity * entryComm;
      const exitCost = currentPrice * pos.quantity * comm;

      const profitFiat = pos.positionType === 'buy'
        ? ((currentPrice - pos.entryPrice) * pos.quantity) - entryCost - exitCost
        : ((pos.entryPrice - currentPrice) * pos.quantity) - entryCost - exitCost;
      
      const profitPercent = (profitFiat / (pos.entryPrice * pos.quantity)) * 100;

      await prisma.position.update({
        where: { id: pos.id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          profitLossPercent: profitPercent,
          profitLossFiat: profitFiat,
        },
      });
      results.push(`Successfully closed #${pos.id} (${symbol}) in ${mode}`);
    } else {
      results.push(`Failed to close #${pos.id} (${symbol}) in ${mode}`);
    }
  }

  return NextResponse.json({ success: true, results });
}
