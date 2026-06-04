export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { fail } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';

const TRADE_ENGINE_URL = (process.env.TRADE_ENGINE_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const { searchParams } = new URL(req.url);
  const upstreamUrl = `${TRADE_ENGINE_URL}/events${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'text/event-stream',
      },
      cache: 'no-store',
    });

    if (!upstream.ok || !upstream.body) {
      return fail(502, 'Trade engine stream unavailable', {
        status: upstream.status,
      });
    }

    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    return fail(502, 'Trade engine stream unavailable', error?.message || 'unknown error');
  }
}
