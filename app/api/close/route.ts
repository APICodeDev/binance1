// app/api/close/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { closeTrackedPosition } from '@/lib/positions';

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

    const closeResult = await closeTrackedPosition(pos);
    if (!closeResult.ok) {
      return NextResponse.json({ error: true, message: closeResult.message, details: closeResult.details }, { status: closeResult.status });
    }

    await writeAuditLog({
      action: 'position.close.manual',
      userId: auth.auth.user.id,
      targetType: 'position',
      targetId: String(pos.id),
      metadata: { symbol: closeResult.symbol, mode: closeResult.tradingMode },
      req,
    });

    return NextResponse.json({ success: true, message: `Position ejected in ${closeResult.tradingMode}.` });
  } catch (error: any) {
    return NextResponse.json({ error: true, message: error.message }, { status: 500 });
  }
}
