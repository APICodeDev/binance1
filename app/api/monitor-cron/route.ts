export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { fail } from '@/lib/apiResponse';
import { runMonitor } from '@/app/api/monitor/route';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const cronSecret = process.env.CRON_SECRET || '';

  if (!cronSecret || bearerToken !== cronSecret) {
    return fail(401, 'Invalid cron secret');
  }

  return runMonitor(req);
}
