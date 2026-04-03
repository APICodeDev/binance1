// app/api/close/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { 
  binanceGetPrice, 
  binanceCancelAllOrders, 
  binanceClosePosition, 
  binanceOrderSuccess,
  binanceGetCommissionRate
} from '@/lib/binance';

export async function POST(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: true, message: 'ID required' }, { status: 400 });

    const pos = await prisma.position.findUnique({ where: { id: Number(id) } });
    if (!pos || pos.status !== 'open') {
      return NextResponse.json({ error: true, message: 'Position not found or already closed' }, { status: 404 });
    }

    const mode = ((pos as any).tradingMode || 'demo') as 'demo' | 'live';
    const symbol = pos.symbol.toUpperCase();
    
    const currentPrice = await binanceGetPrice(symbol, mode);
    if (!currentPrice) return NextResponse.json({ error: true, message: 'Failed to fetch price' }, { status: 500 });
    
    const exitComm = await binanceGetCommissionRate(symbol, mode);
    const entryComm = (pos as any).commission ?? 0.0004;

    const closeSide = pos.positionType === 'buy' ? 'SELL' : 'BUY';
    await binanceCancelAllOrders(symbol, mode);
    const closeResp = await binanceClosePosition(symbol, closeSide, pos.quantity, mode);

    if (binanceOrderSuccess(closeResp)) {
      const entryCost = pos.entryPrice * pos.quantity * entryComm;
      const exitCost = currentPrice * pos.quantity * exitComm;

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

      return NextResponse.json({ success: true, message: `Position ejected in ${mode}.` });
    } else {
      return NextResponse.json({ error: true, message: 'Binance close failed', details: closeResp }, { status: 500 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: true, message: error.message }, { status: 500 });
  }
}
