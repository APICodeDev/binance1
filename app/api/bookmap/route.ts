export const dynamic = 'force-dynamic';

import axios from 'axios';
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';

const BOOKMAP_SERVICE_URL = (process.env.BOOKMAP_WS_SERVICE_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');

type ExchangeName = 'bybit' | 'binance' | 'bitget';

const getBitgetProductType = (symbol: string) => {
  if (symbol.endsWith('USDC')) return 'USDC-FUTURES';
  if (symbol.endsWith('USD')) return 'COIN-FUTURES';
  return 'USDT-FUTURES';
};

const parseNumber = (value: unknown) => {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const buildZoneList = (
  side: 'support' | 'resistance',
  entries: Array<{ exchange: ExchangeName; price: number; size: number }>,
  mid: number
) => {
  const grouped = new Map<string, {
    price: number;
    totalSize: number;
    totalNotional: number;
    exchanges: Set<ExchangeName>;
  }>();

  for (const entry of entries) {
    const bucket = entry.price >= 1000 ? Math.round(entry.price) : Number(entry.price.toFixed(2));
    const key = bucket.toFixed(8);
    const current = grouped.get(key) || {
      price: bucket,
      totalSize: 0,
      totalNotional: 0,
      exchanges: new Set<ExchangeName>(),
    };

    current.totalSize += entry.size;
    current.totalNotional += entry.price * entry.size;
    current.exchanges.add(entry.exchange);
    grouped.set(key, current);
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.totalNotional - a.totalNotional)
    .slice(0, 5)
    .map((zone) => ({
      price: Number(zone.price.toFixed(8)),
      totalSize: Number(zone.totalSize.toFixed(6)),
      totalNotional: Number(zone.totalNotional.toFixed(2)),
      exchangeCount: zone.exchanges.size,
      exchanges: Array.from(zone.exchanges.values()),
      distancePercent: mid > 0 ? Number((Math.abs(zone.price - mid) / mid * 100).toFixed(4)) : 0,
      side,
    }));
};

async function buildFallbackSummary(symbol: string) {
  const [bybitOrderbook, bybitTrades, binanceDepth, binanceTrades, bitgetDepth] = await Promise.all([
    axios.get('https://api.bybit.com/v5/market/orderbook', {
      params: { category: 'linear', symbol, limit: 25 },
      timeout: 3500,
    }),
    axios.get('https://api.bybit.com/v5/market/recent-trade', {
      params: { category: 'linear', symbol, limit: 30 },
      timeout: 3500,
    }),
    axios.get('https://fapi.binance.com/fapi/v1/depth', {
      params: { symbol, limit: 20 },
      timeout: 3500,
    }),
    axios.get('https://fapi.binance.com/fapi/v1/trades', {
      params: { symbol, limit: 30 },
      timeout: 3500,
    }),
    axios.get('https://api.bitget.com/api/v2/mix/market/merge-depth', {
      params: { symbol, productType: getBitgetProductType(symbol), limit: 15 },
      timeout: 3500,
    }),
  ]);

  const bybitBook = bybitOrderbook.data?.result || {};
  const bybitBid = parseNumber(bybitBook?.b?.[0]?.[0]);
  const bybitAsk = parseNumber(bybitBook?.a?.[0]?.[0]);
  const bybitTs = parseNumber(bybitBook?.ts) || Date.now();

  const binanceBook = binanceDepth.data || {};
  const binanceBid = parseNumber(binanceBook?.bids?.[0]?.[0]);
  const binanceAsk = parseNumber(binanceBook?.asks?.[0]?.[0]);
  const binanceTs = parseNumber(binanceBook?.E) || Date.now();

  const bitgetBook = bitgetDepth.data?.data || {};
  const bitgetBid = parseNumber(bitgetBook?.bids?.[0]?.[0]);
  const bitgetAsk = parseNumber(bitgetBook?.asks?.[0]?.[0]);
  const bitgetTs = parseNumber(bitgetBook?.ts) || Date.now();

  const bidValues = [bybitBid, binanceBid, bitgetBid].filter((value): value is number => value !== null);
  const askValues = [bybitAsk, binanceAsk, bitgetAsk].filter((value): value is number => value !== null);
  const compositeBestBid = bidValues.length ? bidValues.reduce((sum, value) => sum + value, 0) / bidValues.length : null;
  const compositeBestAsk = askValues.length ? askValues.reduce((sum, value) => sum + value, 0) / askValues.length : null;
  const mid = compositeBestBid !== null && compositeBestAsk !== null ? (compositeBestBid + compositeBestAsk) / 2 : 0;

  const bybitRecentTrades = Array.isArray(bybitTrades.data?.result?.list) ? bybitTrades.data.result.list : [];
  const binanceRecentTrades = Array.isArray(binanceTrades.data) ? binanceTrades.data : [];
  const recentTrades = [
    ...bybitRecentTrades.slice(0, 12).map((trade: any) => ({
      exchange: 'bybit' as const,
      price: parseNumber(trade?.price) || 0,
      size: parseNumber(trade?.size) || 0,
      side: String(trade?.side || '').toLowerCase() === 'sell' ? 'sell' as const : 'buy' as const,
      timestamp: parseNumber(trade?.time) || Date.now(),
    })),
    ...binanceRecentTrades.slice(0, 12).map((trade: any) => ({
      exchange: 'binance' as const,
      price: parseNumber(trade?.price) || 0,
      size: parseNumber(trade?.qty) || 0,
      side: trade?.isBuyerMaker ? 'sell' as const : 'buy' as const,
      timestamp: parseNumber(trade?.time) || Date.now(),
    })),
  ]
    .filter((trade) => trade.price > 0 && trade.size > 0)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-20);

  const buyVolume = recentTrades.filter((trade) => trade.side === 'buy').reduce((sum, trade) => sum + trade.size, 0);
  const sellVolume = recentTrades.filter((trade) => trade.side === 'sell').reduce((sum, trade) => sum + trade.size, 0);
  const imbalance = buyVolume + sellVolume > 0 ? (buyVolume - sellVolume) / (buyVolume + sellVolume) : 0;

  const supportEntries = [
    ...(Array.isArray(bybitBook?.b) ? bybitBook.b.slice(0, 12).map((level: any[]) => ({ exchange: 'bybit' as const, price: parseNumber(level?.[0]) || 0, size: parseNumber(level?.[1]) || 0 })) : []),
    ...(Array.isArray(binanceBook?.bids) ? binanceBook.bids.slice(0, 12).map((level: any[]) => ({ exchange: 'binance' as const, price: parseNumber(level?.[0]) || 0, size: parseNumber(level?.[1]) || 0 })) : []),
    ...(Array.isArray(bitgetBook?.bids) ? bitgetBook.bids.slice(0, 12).map((level: any[]) => ({ exchange: 'bitget' as const, price: parseNumber(level?.[0]) || 0, size: parseNumber(level?.[1]) || 0 })) : []),
  ].filter((entry) => entry.price > 0 && entry.size > 0);

  const resistanceEntries = [
    ...(Array.isArray(bybitBook?.a) ? bybitBook.a.slice(0, 12).map((level: any[]) => ({ exchange: 'bybit' as const, price: parseNumber(level?.[0]) || 0, size: parseNumber(level?.[1]) || 0 })) : []),
    ...(Array.isArray(binanceBook?.asks) ? binanceBook.asks.slice(0, 12).map((level: any[]) => ({ exchange: 'binance' as const, price: parseNumber(level?.[0]) || 0, size: parseNumber(level?.[1]) || 0 })) : []),
    ...(Array.isArray(bitgetBook?.asks) ? bitgetBook.asks.slice(0, 12).map((level: any[]) => ({ exchange: 'bitget' as const, price: parseNumber(level?.[0]) || 0, size: parseNumber(level?.[1]) || 0 })) : []),
  ].filter((entry) => entry.price > 0 && entry.size > 0);

  const supports = buildZoneList('support', supportEntries, mid);
  const resistances = buildZoneList('resistance', resistanceEntries, mid);
  const nearestSupport = supports[0] || null;
  const nearestResistance = resistances[0] || null;
  const bias = imbalance > 0.12 ? 'long' : imbalance < -0.12 ? 'short' : 'neutral';

  return {
    ok: true,
    symbol,
    asOf: Date.now(),
    degraded: true,
    source: 'rest-fallback',
    lastPrice: recentTrades[recentTrades.length - 1]?.price || compositeBestAsk || compositeBestBid,
    lastTradeTs: recentTrades[recentTrades.length - 1]?.timestamp || null,
    composite: {
      bestBid: compositeBestBid !== null ? Number(compositeBestBid.toFixed(8)) : null,
      bestAsk: compositeBestAsk !== null ? Number(compositeBestAsk.toFixed(8)) : null,
      mid: Number(mid.toFixed(8)),
      spreadBps: compositeBestBid !== null && compositeBestAsk !== null && mid > 0
        ? Number((Math.max(0, ((compositeBestAsk - compositeBestBid) / mid) * 10_000)).toFixed(2))
        : null,
    },
    exchanges: [
      {
        exchange: 'bybit',
        status: 'rest-fallback',
        bestBid: bybitBid,
        bestAsk: bybitAsk,
        spreadBps: bybitBid !== null && bybitAsk !== null ? Number((((bybitAsk - bybitBid) / ((bybitBid + bybitAsk) / 2)) * 10_000).toFixed(2)) : null,
        lastUpdateAgeMs: Math.max(0, Date.now() - bybitTs),
        isFresh: true,
      },
      {
        exchange: 'binance',
        status: 'rest-fallback',
        bestBid: binanceBid,
        bestAsk: binanceAsk,
        spreadBps: binanceBid !== null && binanceAsk !== null ? Number((((binanceAsk - binanceBid) / ((binanceBid + binanceAsk) / 2)) * 10_000).toFixed(2)) : null,
        lastUpdateAgeMs: Math.max(0, Date.now() - binanceTs),
        isFresh: true,
      },
      {
        exchange: 'bitget',
        status: 'rest-fallback',
        bestBid: bitgetBid,
        bestAsk: bitgetAsk,
        spreadBps: bitgetBid !== null && bitgetAsk !== null ? Number((((bitgetAsk - bitgetBid) / ((bitgetBid + bitgetAsk) / 2)) * 10_000).toFixed(2)) : null,
        lastUpdateAgeMs: Math.max(0, Date.now() - bitgetTs),
        isFresh: true,
      },
    ],
    tape: {
      buyVolume: Number(buyVolume.toFixed(6)),
      sellVolume: Number(sellVolume.toFixed(6)),
      imbalance: Number(imbalance.toFixed(4)),
      recentTrades,
    },
    zones: {
      supports,
      resistances,
    },
    heatmap: {
      rows: [],
      columns: [],
      mids: [],
      cells: [],
      maxIntensity: 0,
      step: 0,
    },
    heatmapTrades: [],
    absorptionSignals: [],
    preSignal: {
      actionable: false,
      bias: 'neutral',
      confidence: Number((0.35 + Math.min(0.55, Math.abs(imbalance))).toFixed(2)),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      rewardRisk: null,
      invalidation: null,
      mode: 'watch',
      reasons: ['Modo degradado REST sin confirmacion ejecutable completa'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now(),
      invalidatedAt: null,
      invalidationReason: null,
    },
    trigger: {
      bias,
      confidence: Number((0.35 + Math.min(0.55, Math.abs(imbalance))).toFixed(2)),
      reason: nearestSupport || nearestResistance
        ? `Modo degradado REST. ${bias === 'long' ? 'Sesgo comprador' : bias === 'short' ? 'Sesgo vendedor' : 'Sin sesgo claro'} con zonas agregadas disponibles.`
        : 'Modo degradado REST sin zonas suficientemente claras todavia.',
      referencePrice: bias === 'long' ? nearestSupport?.price || null : bias === 'short' ? nearestResistance?.price || null : null,
    },
  };
}

export async function GET(req: NextRequest) {
  const authResult = await requireAuth(req);
  if (!authResult.ok) {
    return authResult.response;
  }

  const symbol = String(req.nextUrl.searchParams.get('symbol') || 'ETHUSDT').toUpperCase();

  try {
    await axios.get(`${BOOKMAP_SERVICE_URL}/subscribe`, {
      params: { symbol },
      timeout: 1800,
    });

    const response = await axios.get(`${BOOKMAP_SERVICE_URL}/summary`, {
      params: { symbol },
      timeout: 2200,
    });

    return ok(response.data);
  } catch (error: any) {
    try {
      const fallback = await buildFallbackSummary(symbol);
      return ok(fallback, 'Bookmap fallback loaded');
    } catch (fallbackError: any) {
      const detail = fallbackError?.response?.data?.message || fallbackError?.message || error?.response?.data?.message || error?.message || 'Bookmap service unavailable';
      return fail(503, 'Unable to load bookmap summary', detail);
    }
  }
}
