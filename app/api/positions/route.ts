// app/api/positions/route.ts  
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { fail, ok } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { attachTakeProfitUpgradeMeta } from '@/lib/positionSignals';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const { searchParams } = new URL(req.url);
  let mode = searchParams.get('mode');

  // If no mode provided, fetch current from settings
  if (!mode) {
    const setting = await prisma.setting.findUnique({ where: { key: 'trading_mode' } });
    mode = setting?.value || 'demo';
  }

  const open = await prisma.position.findMany({
    where: { status: 'open', tradingMode: mode } as any,
    orderBy: { createdAt: 'desc' },
  });

  const history = await prisma.position.findMany({
    where: { status: 'closed', tradingMode: mode } as any,
    orderBy: { closedAt: 'desc' },
    take: 50,
  });

  const [openWithTpMeta, historyWithTpMeta] = await Promise.all([
    attachTakeProfitUpgradeMeta(open as any),
    attachTakeProfitUpgradeMeta(history as any),
  ]);

  const totalPnlRows = await prisma.position.aggregate({
    where: { status: 'closed', tradingMode: mode } as any,
    _sum: { profitLossFiat: true },
  });

  return NextResponse.json({
    open: openWithTpMeta,
    history: historyWithTpMeta,
    totalPnl: totalPnlRows._sum?.profitLossFiat || 0,
    mode
  });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode');

  if (!mode) {
    return fail(400, 'Mode is required for deletion');
  }

  await prisma.position.deleteMany({
    where: { status: 'closed', tradingMode: mode } as any,
  });
  return ok(undefined, 'History cleared');
}
