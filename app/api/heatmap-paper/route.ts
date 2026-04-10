export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { bitgetGetPrice } from '@/lib/bitget';

type TradingMode = 'demo' | 'live';

const resolveTradingMode = async (): Promise<TradingMode> => {
  const setting = await prisma.setting.findUnique({ where: { key: 'trading_mode' } });
  return (setting?.value || 'demo') === 'live' ? 'live' : 'demo';
};

const closePaperTrade = async (trade: any, exitPrice: number, exitReason: string) => {
  const profitLossFiat = trade.side === 'buy'
    ? (exitPrice - trade.entryPrice) * trade.quantity
    : (trade.entryPrice - exitPrice) * trade.quantity;
  const profitLossPercent = trade.side === 'buy'
    ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100
    : ((trade.entryPrice - exitPrice) / trade.entryPrice) * 100;

  return prisma.heatmapPaperTrade.update({
    where: { id: trade.id },
    data: {
      status: 'closed',
      exitPrice,
      exitReason,
      closedAt: new Date(),
      profitLossFiat,
      profitLossPercent,
    },
  });
};

const buildAnalytics = (history: any[]) => {
  const closedCount = history.length;
  const winCount = history.filter((trade) => (trade.profitLossFiat || 0) > 0).length;
  const lossCount = closedCount - winCount;
  const targetHits = history.filter((trade) => trade.exitReason === 'target').length;
  const stopHits = history.filter((trade) => trade.exitReason === 'stop').length;
  const averageDurationMs = closedCount > 0
    ? Math.round(history.reduce((sum, trade) => {
      if (!trade.closedAt) return sum;
      return sum + Math.max(0, new Date(trade.closedAt).getTime() - new Date(trade.createdAt).getTime());
    }, 0) / closedCount)
    : 0;

  const symbolMap = new Map<string, {
    total: number;
    wins: number;
    pnl: number;
  }>();
  const setupMap = new Map<string, {
    total: number;
    wins: number;
    pnl: number;
  }>();
  const confidenceBuckets = new Map<string, {
    total: number;
    wins: number;
    pnl: number;
  }>();

  const getSetupLabel = (trade: any) => {
    const reasons = Array.isArray(trade.reasons) ? trade.reasons.map((value: unknown) => String(value)) : [];
    const triggerReason = reasons.find((reason: string) => reason.toLowerCase().includes('trigger microestructural'));
    const absorptionReason = reasons.find((reason: string) => reason.toLowerCase().includes('absorcion'));
    const parts = [
      trade.side === 'buy' ? 'LONG' : 'SHORT',
      absorptionReason?.toLowerCase().includes('alcista')
        ? 'bullish-absorption'
        : absorptionReason?.toLowerCase().includes('bajista')
          ? 'bearish-absorption'
          : 'no-absorption-tag',
      triggerReason?.toLowerCase().includes('neutral')
        ? 'neutral-trigger'
        : triggerReason?.toLowerCase().includes('short')
          ? 'short-trigger'
          : triggerReason?.toLowerCase().includes('long')
            ? 'long-trigger'
            : 'unknown-trigger',
    ];
    return parts.join(' / ');
  };

  const getConfidenceBucket = (confidence: number) => {
    if (confidence >= 0.9) return '0.90-1.00';
    if (confidence >= 0.8) return '0.80-0.89';
    if (confidence >= 0.7) return '0.70-0.79';
    if (confidence >= 0.6) return '0.60-0.69';
    return '< 0.60';
  };

  history.forEach((trade) => {
    const current = symbolMap.get(trade.symbol) || { total: 0, wins: 0, pnl: 0 };
    current.total += 1;
    if ((trade.profitLossFiat || 0) > 0) {
      current.wins += 1;
    }
    current.pnl += trade.profitLossFiat || 0;
    symbolMap.set(trade.symbol, current);

    const setupLabel = getSetupLabel(trade);
    const setupCurrent = setupMap.get(setupLabel) || { total: 0, wins: 0, pnl: 0 };
    setupCurrent.total += 1;
    if ((trade.profitLossFiat || 0) > 0) {
      setupCurrent.wins += 1;
    }
    setupCurrent.pnl += trade.profitLossFiat || 0;
    setupMap.set(setupLabel, setupCurrent);

    const confidenceBucket = getConfidenceBucket(Number(trade.confidence || 0));
    const confidenceCurrent = confidenceBuckets.get(confidenceBucket) || { total: 0, wins: 0, pnl: 0 };
    confidenceCurrent.total += 1;
    if ((trade.profitLossFiat || 0) > 0) {
      confidenceCurrent.wins += 1;
    }
    confidenceCurrent.pnl += trade.profitLossFiat || 0;
    confidenceBuckets.set(confidenceBucket, confidenceCurrent);
  });

  const symbolPerformance = Array.from(symbolMap.entries())
    .map(([symbol, data]) => ({
      symbol,
      total: data.total,
      wins: data.wins,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
      pnl: data.pnl,
    }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 8);

  const setupPerformance = Array.from(setupMap.entries())
    .map(([setup, data]) => ({
      setup,
      total: data.total,
      wins: data.wins,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
      pnl: data.pnl,
    }))
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 8);

  const confidencePerformance = Array.from(confidenceBuckets.entries())
    .map(([bucket, data]) => ({
      bucket,
      total: data.total,
      wins: data.wins,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
      pnl: data.pnl,
    }))
    .sort((a, b) => b.bucket.localeCompare(a.bucket));

  return {
    closedCount,
    winCount,
    lossCount,
    winRate: closedCount > 0 ? (winCount / closedCount) * 100 : 0,
    targetHits,
    stopHits,
    averageDurationMs,
    symbolPerformance,
    setupPerformance,
    confidencePerformance,
  };
};

const syncOpenTrades = async (mode: TradingMode) => {
  const openTrades = await prisma.heatmapPaperTrade.findMany({
    where: { status: 'open', tradingMode: mode },
    orderBy: { createdAt: 'desc' },
  });

  for (const trade of openTrades) {
    const currentPrice = await bitgetGetPrice(trade.symbol, mode);
    if (!currentPrice) {
      continue;
    }

    if (trade.side === 'buy') {
      if (currentPrice <= trade.stopPrice) {
        await closePaperTrade(trade, currentPrice, 'stop');
        continue;
      }
      if (currentPrice >= trade.targetPrice) {
        await closePaperTrade(trade, currentPrice, 'target');
      }
      continue;
    }

    if (currentPrice >= trade.stopPrice) {
      await closePaperTrade(trade, currentPrice, 'stop');
      continue;
    }
    if (currentPrice <= trade.targetPrice) {
      await closePaperTrade(trade, currentPrice, 'target');
    }
  }
};

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const mode = await resolveTradingMode();
  await syncOpenTrades(mode);

  const open = await prisma.heatmapPaperTrade.findMany({
    where: { status: 'open', tradingMode: mode },
    orderBy: { createdAt: 'desc' },
  });

  const history = await prisma.heatmapPaperTrade.findMany({
    where: { status: 'closed', tradingMode: mode },
    orderBy: { closedAt: 'desc' },
    take: 100,
  });

  const aggregates = await prisma.heatmapPaperTrade.aggregate({
    where: { status: 'closed', tradingMode: mode },
    _sum: { profitLossFiat: true },
    _count: { id: true },
  });

  const wins = history.filter((trade) => (trade.profitLossFiat || 0) > 0).length;

  return ok({
    mode,
    open,
    history,
    summary: {
      closedCount: aggregates._count.id || 0,
      totalPnl: aggregates._sum.profitLossFiat || 0,
      winCount: wins,
      lossCount: (aggregates._count.id || 0) - wins,
    },
    analytics: buildAnalytics(history),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return fail(400, 'Invalid payload');
  }

  const symbol = String(body.symbol || '').toUpperCase();
  const side = String(body.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
  const amount = Number.parseFloat(String(body.amount || '0'));
  const entryPrice = Number.parseFloat(String(body.entryPrice || '0'));
  const stopPrice = Number.parseFloat(String(body.stopPrice || '0'));
  const targetPrice = Number.parseFloat(String(body.targetPrice || '0'));
  const confidence = Number.parseFloat(String(body.confidence || '0'));
  const reasons = Array.isArray(body.reasons) ? body.reasons : [];
  const mode = await resolveTradingMode();

  if (!symbol || amount <= 0 || entryPrice <= 0 || stopPrice <= 0 || targetPrice <= 0) {
    return fail(400, 'Missing required paper trade fields');
  }

  const existing = await prisma.heatmapPaperTrade.findFirst({
    where: {
      symbol,
      side,
      tradingMode: mode,
      status: 'open',
    },
  });

  if (existing) {
    return fail(409, 'There is already an open paper trade for this symbol and direction');
  }

  const quantity = amount / entryPrice;

  const created = await prisma.heatmapPaperTrade.create({
    data: {
      symbol,
      side,
      amount,
      quantity,
      entryPrice,
      stopPrice,
      targetPrice,
      tradingMode: mode,
      confidence,
      source: 'Heatmap',
      timeframe: 'OrderBook',
      reasons,
    },
  });

  return ok({ trade: created }, 'Heatmap paper trade created');
}
