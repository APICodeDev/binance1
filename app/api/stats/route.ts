export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ok } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

type ClosedPosition = {
  symbol: string;
  origin: string | null;
  tradingMode: string;
  profitLossFiat: number | null;
  createdAt: Date;
  closedAt: Date | null;
};

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function buildModeStats(positions: ClosedPosition[]) {
  const wins = positions.filter((position) => (position.profitLossFiat || 0) > 0);
  const losses = positions.filter((position) => (position.profitLossFiat || 0) <= 0);
  const total = positions.length;
  const profitAmount = wins.reduce((sum, position) => sum + Math.max(0, position.profitLossFiat || 0), 0);
  const lossAmount = losses.reduce((sum, position) => sum + Math.abs(Math.min(0, position.profitLossFiat || 0)), 0);
  const pnlBase = profitAmount + lossAmount;

  const sourceMap = new Map<string, {
    totalCount: number;
    winCount: number;
    totalDurationMs: number;
    winDurationMs: number;
  }>();
  const symbolMap = new Map<string, {
    totalCount: number;
    winCount: number;
    profitAmount: number;
  }>();
  const weekdayBuckets = Array.from({ length: 7 }, (_, index) => ({
    label: WEEKDAY_LABELS[index],
    count: 0,
  }));
  const hourBuckets = Array.from({ length: 24 }, (_, index) => ({
    label: index.toString().padStart(2, '0'),
    count: 0,
  }));

  positions.forEach((position) => {
    const source = (position.origin || 'UNKNOWN').toUpperCase();
    const current = sourceMap.get(source) || {
      totalCount: 0,
      winCount: 0,
      totalDurationMs: 0,
      winDurationMs: 0,
    };
    const durationMs = position.closedAt
      ? Math.max(0, new Date(position.closedAt).getTime() - new Date(position.createdAt).getTime())
      : 0;
    const isWin = (position.profitLossFiat || 0) > 0;

    current.totalCount += 1;
    current.totalDurationMs += durationMs;
    if (isWin) {
      current.winCount += 1;
      current.winDurationMs += durationMs;
    }

    sourceMap.set(source, current);

    const symbol = position.symbol.toUpperCase();
    const currentSymbol = symbolMap.get(symbol) || {
      totalCount: 0,
      winCount: 0,
      profitAmount: 0,
    };
    currentSymbol.totalCount += 1;
    if (isWin) {
      currentSymbol.winCount += 1;
    }
    currentSymbol.profitAmount += position.profitLossFiat || 0;
    symbolMap.set(symbol, currentSymbol);

    const openedAt = new Date(position.createdAt);
    weekdayBuckets[openedAt.getDay()].count += 1;
    hourBuckets[openedAt.getHours()].count += 1;
  });

  const sourceByCount = Array.from(sourceMap.entries())
    .map(([source, item]) => ({
      source,
      totalCount: item.totalCount,
      winCount: item.winCount,
      effectivenessPercent: item.totalCount > 0 ? (item.winCount / item.totalCount) * 100 : 0,
    }))
    .sort((a, b) => b.effectivenessPercent - a.effectivenessPercent);

  const sourceByDuration = Array.from(sourceMap.entries())
    .map(([source, item]) => ({
      source,
      totalDurationMs: item.totalDurationMs,
      winDurationMs: item.winDurationMs,
      effectivenessPercent: item.totalDurationMs > 0 ? (item.winDurationMs / item.totalDurationMs) * 100 : 0,
    }))
    .sort((a, b) => b.effectivenessPercent - a.effectivenessPercent);

  const symbolByWins = Array.from(symbolMap.entries())
    .map(([symbol, item]) => ({
      symbol,
      totalCount: item.totalCount,
      winCount: item.winCount,
      effectivenessPercent: item.totalCount > 0 ? (item.winCount / item.totalCount) * 100 : 0,
    }))
    .sort((a, b) => b.winCount - a.winCount || b.effectivenessPercent - a.effectivenessPercent);

  const symbolByProfit = Array.from(symbolMap.entries())
    .map(([symbol, item]) => ({
      symbol,
      totalCount: item.totalCount,
      profitAmount: item.profitAmount,
    }))
    .sort((a, b) => b.profitAmount - a.profitAmount);

  return {
    closedCount: total,
    successCount: wins.length,
    failedCount: losses.length,
    successPercent: total > 0 ? (wins.length / total) * 100 : 0,
    failedPercent: total > 0 ? (losses.length / total) * 100 : 0,
    profitAmount,
    lossAmount,
    profitPercent: pnlBase > 0 ? (profitAmount / pnlBase) * 100 : 0,
    lossPercent: pnlBase > 0 ? (lossAmount / pnlBase) * 100 : 0,
    sourceByCount,
    sourceByDuration,
    symbolByWins,
    symbolByProfit,
    tradesByWeekday: weekdayBuckets,
    tradesByHour: hourBuckets,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const closedPositions = await prisma.position.findMany({
    where: { status: 'closed' },
    select: {
      symbol: true,
      origin: true,
      tradingMode: true,
      profitLossFiat: true,
      createdAt: true,
      closedAt: true,
    },
  });

  const demoPositions = closedPositions.filter((position) => position.tradingMode === 'demo');
  const livePositions = closedPositions.filter((position) => position.tradingMode === 'live');

  return ok({
    demo: buildModeStats(demoPositions),
    live: buildModeStats(livePositions),
    timestamp: new Date().toISOString(),
  }, 'Statistics loaded');
}
