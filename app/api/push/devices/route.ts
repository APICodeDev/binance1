export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

const normalizeEnvironment = (value: unknown) => {
  const raw = String(value || '').toLowerCase();
  return raw === 'sandbox' ? 'sandbox' : 'production';
};

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await req.json().catch(() => null);
  const token = String(body?.token || '').trim();
  if (!token) {
    return fail(400, 'Device token is required');
  }

  const platform = String(body?.platform || 'ios').trim().toLowerCase();
  const environment = normalizeEnvironment(body?.environment);
  const appVersion = body?.appVersion ? String(body.appVersion) : null;
  const deviceName = body?.deviceName ? String(body.deviceName) : null;

  const device = await prisma.pushDevice.upsert({
    where: { token },
    update: {
      userId: auth.auth.user.id,
      platform,
      environment,
      appVersion,
      deviceName,
      isActive: true,
      lastSeenAt: new Date(),
    },
    create: {
      userId: auth.auth.user.id,
      token,
      platform,
      environment,
      appVersion,
      deviceName,
      isActive: true,
      lastSeenAt: new Date(),
    },
    select: {
      id: true,
      platform: true,
      environment: true,
      lastSeenAt: true,
    },
  });

  return ok(device, 'Push device registered');
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const { searchParams } = new URL(req.url);
  const token = String(searchParams.get('token') || '').trim();
  if (!token) {
    return fail(400, 'Device token is required');
  }

  await prisma.pushDevice.updateMany({
    where: {
      token,
      userId: auth.auth.user.id,
    },
    data: {
      isActive: false,
      lastSeenAt: new Date(),
    },
  });

  return ok(undefined, 'Push device disabled');
}
