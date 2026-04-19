export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ok } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

type PositionStatsRow = {
  symbol: string;
  origin: string | null;
  positionType: string;
  status: string;
  tradingMode: string;
  entryPrice: number;
  requestedEntryPrice: number | null;
  profitLossFiat: number | null;
  createdAt: Date;
  closedAt: Date | null;
};

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function buildModeStats(closedPositions: PositionStatsRow[], allPositions: PositionStatsRow[]) {
  const wins = closedPositions.filter((position) => (position.profitLossFiat || 0) > 0);
  const losses = closedPositions.filter((position) => (position.profitLossFiat || 0) <= 0);
  const total = closedPositions.length;
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

  closedPositions.forEach((position) => {
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

  const entryDeltaRows = allPositions.filter((position) =>
    Number.isFinite(position.requestedEntryPrice) &&
    (position.requestedEntryPrice || 0) > 0 &&
    Number.isFinite(position.entryPrice) &&
    position.entryPrice > 0
  );

  const entryDeltaSummary = entryDeltaRows.reduce((acc, position) => {
    const requestedEntryPrice = Number(position.requestedEntryPrice || 0);
    const rawPercent = ((position.entryPrice - requestedEntryPrice) / requestedEntryPrice) * 100;
    const signedPercent = position.positionType === 'sell' ? rawPercent : -rawPercent;

    if (signedPercent >= 0) {
      acc.favorablePercentTotal += signedPercent;
    } else {
      acc.unfavorablePercentTotal += Math.abs(signedPercent);
    }

    acc.signedPercentTotal += signedPercent;
    acc.absolutePercentTotal += Math.abs(signedPercent);
    return acc;
  }, {
    favorablePercentTotal: 0,
    unfavorablePercentTotal: 0,
    signedPercentTotal: 0,
    absolutePercentTotal: 0,
  });

  const entryDeltaCount = entryDeltaRows.length;

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
    entryExecutionDelta: {
      sampleCount: entryDeltaCount,
      favorablePercentTotal: entryDeltaSummary.favorablePercentTotal,
      unfavorablePercentTotal: entryDeltaSummary.unfavorablePercentTotal,
      averageSignedPercent: entryDeltaCount > 0 ? entryDeltaSummary.signedPercentTotal / entryDeltaCount : 0,
      averageAbsPercent: entryDeltaCount > 0 ? entryDeltaSummary.absolutePercentTotal / entryDeltaCount : 0,
    },
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const positions = await prisma.position.findMany({
    select: {
      symbol: true,
      origin: true,
      positionType: true,
      status: true,
      tradingMode: true,
      entryPrice: true,
      requestedEntryPrice: true,
      profitLossFiat: true,
      createdAt: true,
      closedAt: true,
    },
  });

  const demoPositions = positions.filter((position) => position.tradingMode === 'demo');
  const livePositions = positions.filter((position) => position.tradingMode === 'live');
  const demoClosedPositions = demoPositions.filter((position) => position.status === 'closed');
  const liveClosedPositions = livePositions.filter((position) => position.status === 'closed');

  return ok({
    demo: buildModeStats(demoClosedPositions, demoPositions),
    live: buildModeStats(liveClosedPositions, livePositions),
    timestamp: new Date().toISOString(),
  }, 'Statistics loaded');
}
