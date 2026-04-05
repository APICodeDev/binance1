// app/api/close/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { 
  bitgetGetPrice, 
  bitgetCancelAllOrders, 
  bitgetClosePosition, 
  bitgetFlashClosePosition,
  bitgetGetSinglePosition,
  bitgetOrderSuccess,
  bitgetGetCommissionRate
} from '@/lib/bitget';

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: true, message: 'ID required' }, { status: 400 });

    const pos = await prisma.position.findUnique({ where: { id: Number(id) } });
    if (!pos || pos.status !== 'open') {
      return NextResponse.json({ error: true, message: 'Position not found or already closed' }, { status: 404 });
    }

    const mode = ((pos as any).tradingMode || 'demo') as 'demo' | 'live';
    const symbol = pos.symbol.toUpperCase();
    
    const currentPrice = await bitgetGetPrice(symbol, mode);
    if (!currentPrice) return NextResponse.json({ error: true, message: 'Failed to fetch price' }, { status: 500 });
    
    const exitComm = await bitgetGetCommissionRate(symbol, mode);
    const entryComm = (pos as any).commission ?? 0.0004;

    const closeSide = pos.positionType === 'buy' ? 'SELL' : 'BUY';
    const holdSide = pos.positionType === 'buy' ? 'long' : 'short';
    await bitgetCancelAllOrders(symbol, mode);
    let closeResp = await bitgetFlashClosePosition(symbol, holdSide, mode);

    if (!bitgetOrderSuccess(closeResp)) {
      closeResp = await bitgetClosePosition(symbol, closeSide, pos.quantity, mode);
    }

    await bitgetCancelAllOrders(symbol, mode);

    if (bitgetOrderSuccess(closeResp)) {
      const verifySnapshot = await bitgetGetSinglePosition(symbol, mode);
      if (!verifySnapshot.ok) {
        return NextResponse.json({ error: true, message: 'Bitget close verification failed', details: verifySnapshot.errors }, { status: 502 });
      }

      const stillOpen = verifySnapshot.positions.some((rp: any) => rp.symbol && parseFloat(rp.positionAmt) !== 0);
      if (stillOpen) {
        return NextResponse.json({ error: true, message: 'Position still open on Bitget after close attempt', details: closeResp }, { status: 409 });
      }

      const entryCost = pos.entryPrice * pos.quantity * entryComm;
      const exitCost = currentPrice * pos.quantity * exitComm;

      const profitFiat = pos.positionType === 'buy'
        ? ((currentPrice - pos.entryPrice) * pos.quantity) - entryCost - exitCost
        : ((pos.entryPrice - currentPrice) * pos.quantity) - entryCost - exitCost;
      
      const profitPercent = pos.positionType === 'buy'
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

      await prisma.position.update({
        where: { id: pos.id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          profitLossPercent: profitPercent,
          profitLossFiat: profitFiat,
        },
      });

      await writeAuditLog({
        action: 'position.close.manual',
        userId: auth.auth.user.id,
        targetType: 'position',
        targetId: String(pos.id),
        metadata: { symbol, mode },
        req,
      });

      return NextResponse.json({ success: true, message: `Position ejected in ${mode}.` });
    } else {
      return NextResponse.json({ error: true, message: 'Bitget close failed', details: closeResp }, { status: 500 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: true, message: error.message }, { status: 500 });
  }
}
