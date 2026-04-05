export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAuthContext } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { AUTH_COOKIE_NAME, hashToken } from '@/lib/tokens';

export async function POST(req: NextRequest) {
  const auth = await getAuthContext(req);
  const rawToken = req.cookies.get(AUTH_COOKIE_NAME)?.value;

  if (rawToken) {
    await prisma.session.deleteMany({
      where: { tokenHash: hashToken(rawToken) },
    }).catch(() => undefined);
  }

  if (auth) {
    await writeAuditLog({ action: 'auth.logout', userId: auth.user.id, targetType: 'session', targetId: auth.sessionId, req });
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: new Date(0),
    path: '/',
  });
  return response;
}
