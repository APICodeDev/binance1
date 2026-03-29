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
    console.log('MANUAL CLOSE REQUEST:', id);
    if (!id) return NextResponse.json({ error: true, message: 'ID required' }, { status: 400 });

    const pos = await prisma.position.findUnique({ where: { id: Number(id) } });
    if (!pos || pos.status !== 'open') {
      console.log('POSITION NOT FOUND OR ALREADY CLOSED:', id);
      return NextResponse.json({ error: true, message: 'Position not found or already closed (ID: ' + id + ')' }, { status: 404 });
    }

    const symbol = pos.symbol.toUpperCase();
    console.log('MANUAL CLOSE SYMBOL:', symbol, 'QUANTITY:', pos.quantity);
    const currentPrice = await binanceGetPrice(symbol);
    if (!currentPrice) return NextResponse.json({ error: true, message: 'Failed to fetch price' }, { status: 500 });
    
    // Fetch live commission for exit
    const exitComm = await binanceGetCommissionRate(symbol);
    const entryComm = (pos as any).commission ?? 0.0004;

    const closeSide = pos.positionType === 'buy' ? 'SELL' : 'BUY';
    await binanceCancelAllOrders(symbol);
    const closeResp = await binanceClosePosition(symbol, closeSide, pos.quantity);

    if (binanceOrderSuccess(closeResp)) {
      console.log('BINANCE CLOSE SUCCESS:', symbol);
      const entryCost = pos.entryPrice * pos.quantity * entryComm;
      const exitCost = currentPrice * pos.quantity * exitComm;

      const profitFiat = pos.positionType === 'buy'
        ? ((currentPrice - pos.entryPrice) * pos.quantity) - entryCost - exitCost
        : ((pos.entryPrice - currentPrice) * pos.quantity) - entryCost - exitCost;
      
      const profitPercent = (profitFiat / (pos.entryPrice * pos.quantity)) * 100;

      await (prisma.position.update as any)({
        where: { id: pos.id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          profitLossPercent: profitPercent,
          profitLossFiat: profitFiat,
        },
      });

      return NextResponse.json({ success: true, message: `Position ${symbol} ejected manually.` });
    } else {
      console.error('BINANCE CLOSE FAILED:', JSON.stringify(closeResp));
      return NextResponse.json({ error: true, message: 'Binance close failed', details: closeResp }, { status: 500 });
    }
  } catch (error: any) {
    console.error('MANUAL CLOSE ERROR:', error.message);
    return NextResponse.json({ error: true, message: error.message }, { status: 500 });
  }
}
