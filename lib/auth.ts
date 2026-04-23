import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { AUTH_COOKIE_NAME, hashToken } from '@/lib/tokens';

type AuthContext = {
  user: {
    id: number;
    email: string;
    username: string | null;
    role: string;
    isActive: boolean;
  };
  sessionId?: string;
  apiTokenId?: string;
  authType: 'session' | 'api-token';
};

export async function getAuthContext(req: NextRequest): Promise<AuthContext | null> {
  const bearer = req.headers.get('authorization');
  const bearerToken = bearer?.startsWith('Bearer ') ? bearer.slice(7).trim() : null;
  const cookieToken = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  const rawToken = bearerToken || cookieToken;

  if (!rawToken) {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  if (bearerToken) {
    const apiToken = await prisma.apiToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (apiToken) {
      if ((apiToken.expiresAt && apiToken.expiresAt.getTime() <= Date.now()) || !apiToken.isActive || !apiToken.user.isActive) {
        await prisma.apiToken.update({
          where: { id: apiToken.id },
          data: { isActive: false },
        }).catch(() => undefined);
        return null;
      }

      await prisma.apiToken.update({
        where: { id: apiToken.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => undefined);

      return {
        user: {
          id: apiToken.user.id,
          email: apiToken.user.email,
          username: apiToken.user.username,
          role: apiToken.user.role,
          isActive: apiToken.user.isActive,
        },
        apiTokenId: apiToken.id,
        authType: 'api-token',
      };
    }

    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session) {
      return null;
    }

    if (session.expiresAt.getTime() <= Date.now() || !session.user.isActive) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }

    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => undefined);

    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        username: session.user.username,
        role: session.user.role,
        isActive: session.user.isActive,
      },
      sessionId: session.id,
      authType: 'session',
    };
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now() || !session.user.isActive) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  await prisma.session.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => undefined);

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      username: session.user.username,
      role: session.user.role,
      isActive: session.user.isActive,
    },
    sessionId: session.id,
    authType: 'session',
  };
}

export async function requireAuth(req: NextRequest) {
  const auth = await getAuthContext(req);
  if (!auth) {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, message: 'Authentication required' }, { status: 401 }),
    };
  }

  return {
    ok: true as const,
    auth,
  };
}

export async function requireRole(req: NextRequest, roles: string[]) {
  const result = await requireAuth(req);
  if (!result.ok) {
    return result;
  }

  if (!roles.includes(result.auth.user.role)) {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, message: 'Insufficient permissions' }, { status: 403 }),
    };
  }

  return result;
}
