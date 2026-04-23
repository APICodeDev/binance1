// app/api/emergency/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { 
  bitgetBuildPositionContext,
  bitgetGetPrice, 
  bitgetCancelAllOrders, 
  bitgetClosePosition, 
  bitgetGetPositionMode,
  bitgetOrderSuccess,
  bitgetGetCommissionRate
} from '@/lib/bitget';

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) {
    return auth.response;
  }

  const openPositions = await prisma.position.findMany({ where: { status: 'open' } });
  const results: string[] = [];

  for (const pos of openPositions) {
    const mode = ((pos as any).tradingMode || 'demo') as 'demo' | 'live';
    const symbol = pos.symbol.toUpperCase();
    const currentPrice = await bitgetGetPrice(symbol, mode);
    if (!currentPrice) {
      results.push(`Error fetching price for ${symbol} in ${mode}`);
      continue;
    }

    const comm = await bitgetGetCommissionRate(symbol, mode);
    const entryComm = (pos as any).commission ?? 0.0004;
    const positionMode = await bitgetGetPositionMode(symbol, mode) || 'one_way_mode';
    const positionContext = bitgetBuildPositionContext(pos.positionType as 'buy' | 'sell', positionMode);

    await bitgetCancelAllOrders(symbol, mode);
    const closeResp = await bitgetClosePosition(symbol, positionContext.closeSide, pos.quantity, mode, positionContext.closeTradeSide);

    if (bitgetOrderSuccess(closeResp)) {
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

  await writeAuditLog({
    action: 'positions.emergency_close',
    userId: auth.auth.user.id,
    targetType: 'position',
    metadata: { count: openPositions.length, results },
    req,
  });

  return NextResponse.json({ success: true, results });
}
