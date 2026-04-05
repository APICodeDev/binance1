export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { fail, ok } from '@/lib/apiResponse';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) {
    return auth.response;
  }

  const { searchParams } = new URL(req.url);
  const takeParam = Number(searchParams.get('take') || '30');
  const take = Number.isFinite(takeParam) ? Math.min(Math.max(takeParam, 1), 100) : 30;

  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        user: {
          select: {
            email: true,
            username: true,
            role: true,
          },
        },
      },
    });

    return ok({
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        metadata: log.metadata,
        createdAt: log.createdAt,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        user: log.user
          ? {
              email: log.user.email,
              username: log.user.username,
              role: log.user.role,
            }
          : null,
      })),
    }, 'Audit logs loaded');
  } catch (error) {
    return fail(500, 'Unable to load audit logs');
  }
}
