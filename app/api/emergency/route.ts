// app/api/emergency/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { closeTrackedPosition } from '@/lib/positions';

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
    const closeResult = await closeTrackedPosition(pos);

    if (closeResult.ok) {
      results.push(`Successfully closed #${pos.id} (${symbol}) in ${mode}`);
    } else {
      results.push(`Failed to close #${pos.id} (${symbol}) in ${mode}: ${closeResult.message}`);
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
