// app/api/positions/route.ts  
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
  const open = await prisma.position.findMany({
    where: { status: 'open' },
    orderBy: { createdAt: 'desc' },
  });

  const history = await prisma.position.findMany({
    where: { status: 'closed' },
    orderBy: { closedAt: 'desc' },
    take: 50,
  });

  const totalPnlRows = await prisma.position.aggregate({
    where: { status: 'closed' },
    _sum: { profitLossFiat: true },
  });

  return NextResponse.json({
    open,
    history,
    totalPnl: totalPnlRows._sum.profitLossFiat || 0,
  });
}

export async function DELETE() {
  await prisma.position.deleteMany({
    where: { status: 'closed' },
  });
  return NextResponse.json({ success: true });
}
