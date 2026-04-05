export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ok } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const openCount = await prisma.position.count({ where: { status: 'open' } });
  const latestClosed = await prisma.position.findFirst({
    where: { status: 'closed' },
    orderBy: { closedAt: 'desc' },
    select: { closedAt: true, symbol: true, tradingMode: true },
  });

  return ok({
    openCount,
    latestClosed,
    timestamp: new Date().toISOString(),
  }, 'Sync status loaded');
}
