export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { writeAuditLog } from '@/lib/audit';
import { fail } from '@/lib/apiResponse';
import { verifyPassword } from '@/lib/password';
import { AUTH_COOKIE_NAME, generateSessionToken, getSessionExpiry, hashToken } from '@/lib/tokens';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const identifier = String(body.identifier || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!identifier || !password) {
      return fail(400, 'Identifier and password are required');
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: identifier },
        ],
      },
    });

    if (!user || !user.isActive) {
      await writeAuditLog({ action: 'auth.login.failed', metadata: { identifier }, req });
      return fail(401, 'Invalid credentials');
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      await writeAuditLog({ action: 'auth.login.failed', userId: user.id, metadata: { identifier }, req });
      return fail(401, 'Invalid credentials');
    }

    const token = generateSessionToken();
    const expiresAt = getSessionExpiry();

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
        userAgent: req.headers.get('user-agent'),
        ipAddress: req.headers.get('x-forwarded-for'),
      },
    });

    await writeAuditLog({ action: 'auth.login.success', userId: user.id, targetType: 'session', targetId: session.id, req });

    const response = NextResponse.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
        },
        authType: 'session',
        sessionToken: token,
      },
    });

    response.cookies.set(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });

    return response;
  } catch (error: any) {
    return fail(500, error.message || 'Login failed');
  }
}
