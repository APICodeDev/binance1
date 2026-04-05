export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { ok } from '@/lib/apiResponse';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  return ok({
    user: auth.auth.user,
    authType: auth.auth.authType,
  }, 'Authenticated');
}
