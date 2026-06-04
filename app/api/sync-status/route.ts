export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ok } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

const TRADE_ENGINE_URL = (process.env.TRADE_ENGINE_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const MARKETDATA_URL = (process.env.BITGET_WS_SERVICE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

async function fetchJson(url: string) {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: null,
      };
    }

    return {
      ok: true,
      status: response.status,
      data: await response.json(),
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      data: {
        message: error?.message || 'unavailable',
      },
    };
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const [openCount, latestClosed, tradeEngineHealth, marketdataHealth] = await Promise.all([
    prisma.position.count({ where: { status: 'open' } }),
    prisma.position.findFirst({
      where: { status: 'closed' },
      orderBy: { closedAt: 'desc' },
      select: { closedAt: true, symbol: true, tradingMode: true },
    }),
    fetchJson(`${TRADE_ENGINE_URL}/health`),
    fetchJson(`${MARKETDATA_URL}/health`),
  ]);

  return ok({
    openCount,
    latestClosed,
    services: {
      tradeEngine: {
        reachable: tradeEngineHealth.ok,
        status: tradeEngineHealth.status,
        data: tradeEngineHealth.data,
      },
      marketdata: {
        reachable: marketdataHealth.ok,
        status: marketdataHealth.status,
        data: marketdataHealth.data,
      },
    },
    timestamp: new Date().toISOString(),
  }, 'Sync status loaded');
}
