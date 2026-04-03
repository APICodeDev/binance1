// app/api/positions/route.ts  
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
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

  const totalPnlRows = await prisma.position.aggregate({
    where: { status: 'closed', tradingMode: mode } as any,
    _sum: { profitLossFiat: true },
  });

  return NextResponse.json({
    open,
    history,
    totalPnl: totalPnlRows._sum?.profitLossFiat || 0,
    mode
  });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode');

  if (!mode) {
    return NextResponse.json({ error: true, message: 'Mode is required for deletion' }, { status: 400 });
  }

  await prisma.position.deleteMany({
    where: { status: 'closed', tradingMode: mode } as any,
  });
  return NextResponse.json({ success: true });
}
