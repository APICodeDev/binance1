export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { fail, ok } from '@/lib/apiResponse';
import { prisma } from '@/lib/db';
import { generateSessionToken, getApiTokenExpiry, hashToken } from '@/lib/tokens';

export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) {
    return auth.response;
  }

  const tokens = await prisma.apiToken.findMany({
    where: { userId: auth.auth.user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      lastFour: true,
      isActive: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
  });

  return ok({ tokens }, 'API tokens loaded');
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await req.json();
  const name = String(body.name || '').trim();
  if (!name) {
    return fail(400, 'Token name is required');
  }

  const rawToken = generateSessionToken();
  const token = await prisma.apiToken.create({
    data: {
      userId: auth.auth.user.id,
      name,
      tokenHash: hashToken(rawToken),
      lastFour: rawToken.slice(-4),
      expiresAt: getApiTokenExpiry(),
    },
  });

  await writeAuditLog({
    action: 'auth.api_token.created',
    userId: auth.auth.user.id,
    targetType: 'api_token',
    targetId: token.id,
    metadata: { name },
    req,
  });

  return ok({
    token: {
      id: token.id,
      name: token.name,
      value: rawToken,
      lastFour: token.lastFour,
      expiresAt: token.expiresAt,
    },
  }, 'API token created');
}

export async function DELETE(req: NextRequest) {
  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) {
    return auth.response;
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) {
    return fail(400, 'Token id is required');
  }

  const token = await prisma.apiToken.findFirst({
    where: { id, userId: auth.auth.user.id },
  });

  if (!token) {
    return fail(404, 'Token not found');
  }

  await prisma.apiToken.update({
    where: { id },
    data: { isActive: false },
  });

  await writeAuditLog({
    action: 'auth.api_token.revoked',
    userId: auth.auth.user.id,
    targetType: 'api_token',
    targetId: token.id,
    metadata: { name: token.name },
    req,
  });

  return ok(undefined, 'API token revoked');
}
