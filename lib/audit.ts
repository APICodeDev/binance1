import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';

type AuditLogInput = {
  action: string;
  userId?: number | null;
  targetType?: string;
  targetId?: string;
  metadata?: unknown;
  req?: NextRequest;
};

export async function writeAuditLog(input: AuditLogInput) {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        userId: input.userId ?? null,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: input.metadata as any,
        ipAddress: input.req?.headers.get('x-forwarded-for') || null,
        userAgent: input.req?.headers.get('user-agent') || null,
      },
    });
  } catch (error) {
    console.error('Failed to write audit log', error);
  }
}
