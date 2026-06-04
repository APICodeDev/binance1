import http, { ServerResponse } from 'http';
import { Position } from '@prisma/client';
import { prisma } from '@/lib/db';
import { normalizePositionManagementMode } from '@/lib/positions';

type TradingMode = 'demo' | 'live';

type MarketSnapshot = {
  symbol: string;
  tradingMode: TradingMode;
  bestBid: number | null;
  bestAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  lastPrice: number | null;
  markPrice: number | null;
  timestamp: number;
  source: 'websocket';
};

type MarketEventPayload = {
  channel: 'books1' | 'ticker';
  snapshot: MarketSnapshot;
};

type EngineSubscriber = {
  id: number;
  res: ServerResponse;
};

type PositionMarketUpdate = {
  positionId: number;
  symbol: string;
  tradingMode: TradingMode;
  price: number;
  priceSource: 'mark_price' | 'last_price' | 'mid_price';
  profitPercent: number;
  profitFiat: number;
  stopLoss: number;
  takeProfit: number | null;
  candidateStopLoss: number | null;
  canImproveStop: boolean;
  managementMode: 'auto' | 'self' | 'strat';
  stratBreakEvenEnabled: boolean;
  stratTrailingEnabled: boolean;
  eventTimestamp: number;
};

const HOST = process.env.TRADE_ENGINE_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.TRADE_ENGINE_PORT || '8789', 10);
const MARKETDATA_URL = (process.env.BITGET_WS_SERVICE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const POSITION_REFRESH_MS = Number.parseInt(process.env.TRADE_ENGINE_POSITION_REFRESH_MS || '3000', 10);
const MARKET_STREAM_RECONNECT_MS = Number.parseInt(process.env.TRADE_ENGINE_MARKET_STREAM_RECONNECT_MS || '2000', 10);
const DEFAULT_COMMISSION = Number.parseFloat(process.env.TRADE_ENGINE_DEFAULT_COMMISSION || '0.0006');

const marketSnapshots = new Map<string, MarketSnapshot>();
const openPositions = new Map<number, Position>();
const positionsByMarketKey = new Map<string, Set<number>>();
const watchedMarketKeys = new Set<string>();
const engineSubscribers = new Map<number, EngineSubscriber>();
let nextSubscriberId = 1;
let lastReloadAt: number | null = null;
let lastMarketEventAt: number | null = null;
let lastWarning: string | null = null;

const makeMarketKey = (tradingMode: TradingMode, symbol: string) => `${tradingMode}:${symbol.toUpperCase()}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const writeSse = (res: ServerResponse, event: string, payload: unknown) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const emitEngineEvent = (event: string, payload: unknown) => {
  for (const subscriber of Array.from(engineSubscribers.values())) {
    writeSse(subscriber.res, event, payload);
  }
};

const getSelfManagedTrailingStep = (marketMovePercent: number) => {
  if (marketMovePercent < 1.25) {
    return null;
  }

  const lockedPercent = Math.floor((marketMovePercent - 0.25) + 1e-9);
  return lockedPercent >= 1 ? lockedPercent : null;
};

const resolveLivePrice = (snapshot: MarketSnapshot) => {
  if (snapshot.markPrice !== null && snapshot.markPrice > 0) {
    return { price: snapshot.markPrice, source: 'mark_price' as const };
  }

  if (snapshot.lastPrice !== null && snapshot.lastPrice > 0) {
    return { price: snapshot.lastPrice, source: 'last_price' as const };
  }

  if (snapshot.bestBid !== null && snapshot.bestAsk !== null && snapshot.bestBid > 0 && snapshot.bestAsk > 0) {
    return { price: (snapshot.bestBid + snapshot.bestAsk) / 2, source: 'mid_price' as const };
  }

  return null;
};

const computeCandidateStopLoss = (position: Position, currentPrice: number) => {
  const managementMode = normalizePositionManagementMode(position.managementMode);
  const stratBreakEvenEnabled = Boolean((position as any).stratBreakEvenEnabled);
  const stratTrailingEnabled = Boolean((position as any).stratTrailingEnabled);
  const effectiveSelfManaged = managementMode === 'self' || (managementMode === 'strat' && stratTrailingEnabled);
  const stratBreakEvenOnlyEnabled = managementMode === 'strat' && stratBreakEvenEnabled && !stratTrailingEnabled;
  const autoManaged = managementMode === 'auto';
  const commission = position.commission ?? DEFAULT_COMMISSION;
  const marketMovePercent = position.positionType === 'buy'
    ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

  if (position.positionType === 'buy') {
    if (effectiveSelfManaged) {
      const trailingStep = getSelfManagedTrailingStep(marketMovePercent);
      if (trailingStep !== null) {
        return position.entryPrice * (1 + (trailingStep / 100));
      }
      if (marketMovePercent >= 0.5) {
        return position.entryPrice * (1 + commission) / (1 - commission);
      }
      return null;
    }

    if (stratBreakEvenOnlyEnabled && marketMovePercent >= 0.5) {
      return position.entryPrice * (1 + commission) / (1 - commission);
    }

    if (autoManaged && marketMovePercent >= 1) {
      const crossedStep = Math.floor(marketMovePercent / 0.5) * 0.5;
      const crossedPrice = position.entryPrice * (1 + crossedStep / 100);
      return crossedPrice * (1 - 0.5 / 100);
    }

    if (autoManaged && marketMovePercent >= 0.5) {
      return position.entryPrice * (1 + commission) / (1 - commission);
    }

    return null;
  }

  if (effectiveSelfManaged) {
    const trailingStep = getSelfManagedTrailingStep(marketMovePercent);
    if (trailingStep !== null) {
      return position.entryPrice * (1 - (trailingStep / 100));
    }
    if (marketMovePercent >= 0.5) {
      return position.entryPrice * (1 - commission) / (1 + commission);
    }
    return null;
  }

  if (stratBreakEvenOnlyEnabled && marketMovePercent >= 0.5) {
    return position.entryPrice * (1 - commission) / (1 + commission);
  }

  if (autoManaged && marketMovePercent >= 1) {
    const crossedStep = Math.floor(marketMovePercent / 0.5) * 0.5;
    const crossedPrice = position.entryPrice * (1 - crossedStep / 100);
    return crossedPrice * (1 + 0.5 / 100);
  }

  if (autoManaged && marketMovePercent >= 0.5) {
    return position.entryPrice * (1 - commission) / (1 + commission);
  }

  return null;
};

const buildPositionMarketUpdate = (position: Position, snapshot: MarketSnapshot): PositionMarketUpdate | null => {
  const livePrice = resolveLivePrice(snapshot);
  if (!livePrice) {
    return null;
  }

  const currentPrice = livePrice.price;
  const commission = position.commission ?? DEFAULT_COMMISSION;
  const entryCost = position.entryPrice * position.quantity * commission;
  const exitCost = currentPrice * position.quantity * commission;
  const profitFiat = position.positionType === 'buy'
    ? ((currentPrice - position.entryPrice) * position.quantity) - entryCost - exitCost
    : ((position.entryPrice - currentPrice) * position.quantity) - entryCost - exitCost;
  const profitPercent = position.positionType === 'buy'
    ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  const candidateStopLoss = computeCandidateStopLoss(position, currentPrice);
  const canImproveStop = candidateStopLoss !== null && (
    (position.positionType === 'buy' && candidateStopLoss > position.stopLoss) ||
    (position.positionType === 'sell' && candidateStopLoss < position.stopLoss)
  );

  return {
    positionId: position.id,
    symbol: position.symbol.toUpperCase(),
    tradingMode: ((position as any).tradingMode || 'demo') as TradingMode,
    price: currentPrice,
    priceSource: livePrice.source,
    profitPercent,
    profitFiat,
    stopLoss: position.stopLoss,
    takeProfit: typeof position.takeProfit === 'number' ? position.takeProfit : null,
    candidateStopLoss,
    canImproveStop,
    managementMode: normalizePositionManagementMode(position.managementMode),
    stratBreakEvenEnabled: Boolean((position as any).stratBreakEvenEnabled),
    stratTrailingEnabled: Boolean((position as any).stratTrailingEnabled),
    eventTimestamp: snapshot.timestamp,
  };
};

const subscribeMarketKey = async (marketKey: string) => {
  if (watchedMarketKeys.has(marketKey)) {
    return;
  }

  const [mode, symbol] = marketKey.split(':');
  const params = new URLSearchParams({
    symbol,
    mode,
  });
  const response = await fetch(`${MARKETDATA_URL}/subscribe?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to subscribe ${marketKey}: ${response.status}`);
  }

  watchedMarketKeys.add(marketKey);
};

const rebuildPositionIndexes = (positions: Position[]) => {
  openPositions.clear();
  positionsByMarketKey.clear();

  for (const position of positions) {
    openPositions.set(position.id, position);
    const marketKey = makeMarketKey(((position as any).tradingMode || 'demo') as TradingMode, position.symbol);
    const current = positionsByMarketKey.get(marketKey) || new Set<number>();
    current.add(position.id);
    positionsByMarketKey.set(marketKey, current);
  }
};

const reloadOpenPositions = async () => {
  const positions = await prisma.position.findMany({
    where: { status: 'open' } as any,
    orderBy: { createdAt: 'desc' },
  });

  rebuildPositionIndexes(positions);
  for (const marketKey of Array.from(positionsByMarketKey.keys())) {
    await subscribeMarketKey(marketKey);
  }

  lastReloadAt = Date.now();
  emitEngineEvent('positions_reloaded', {
    openPositions: openPositions.size,
    watchedSymbols: positionsByMarketKey.size,
    at: lastReloadAt,
  });
};

const consumeMarketEvent = (payload: MarketEventPayload) => {
  const snapshot = payload.snapshot;
  const marketKey = makeMarketKey(snapshot.tradingMode, snapshot.symbol);
  marketSnapshots.set(marketKey, snapshot);
  lastMarketEventAt = Date.now();

  emitEngineEvent('market', payload);

  const relatedPositions = positionsByMarketKey.get(marketKey);
  if (!relatedPositions || relatedPositions.size === 0) {
    return;
  }

  for (const positionId of Array.from(relatedPositions)) {
    const position = openPositions.get(positionId);
    if (!position) {
      continue;
    }

    const update = buildPositionMarketUpdate(position, snapshot);
    if (!update) {
      continue;
    }

    emitEngineEvent('position_market_update', update);
  }
};

const parseSseChunk = (chunk: string) => {
  const lines = chunk.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message';
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join('\n'),
  };
};

const streamMarketMode = async (mode: TradingMode) => {
  while (true) {
    try {
      const response = await fetch(`${MARKETDATA_URL}/events?mode=${mode}`, {
        headers: {
          Accept: 'text/event-stream',
        },
        cache: 'no-store',
      });

      if (!response.ok || !response.body) {
        throw new Error(`Market stream ${mode} unavailable (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const parsed = parseSseChunk(chunk);
          if (!parsed || parsed.event !== 'market') {
            continue;
          }

          try {
            consumeMarketEvent(JSON.parse(parsed.data) as MarketEventPayload);
          } catch {
            continue;
          }
        }
      }

      throw new Error(`Market stream ${mode} closed`);
    } catch (error: any) {
      lastWarning = `market-stream-${mode}: ${error?.message || 'unknown error'}`;
      emitEngineEvent('warning', {
        mode,
        warning: lastWarning,
        at: Date.now(),
      });
      await sleep(MARKET_STREAM_RECONNECT_MS);
    }
  }
};

const removeSubscriber = (id: number) => {
  const subscriber = engineSubscribers.get(id);
  if (!subscriber) {
    return;
  }

  engineSubscribers.delete(id);
  try {
    subscriber.res.end();
  } catch {
    return;
  }
};

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end('Missing URL');
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      marketdataUrl: MARKETDATA_URL,
      openPositions: openPositions.size,
      watchedSymbols: positionsByMarketKey.size,
      snapshots: marketSnapshots.size,
      subscribers: engineSubscribers.size,
      lastReloadAt,
      lastMarketEventAt,
      lastWarning,
    }));
    return;
  }

  if (url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      openPositions: Array.from(openPositions.values()).map((position) => ({
        id: position.id,
        symbol: position.symbol,
        tradingMode: (position as any).tradingMode || 'demo',
        managementMode: normalizePositionManagementMode(position.managementMode),
        stratBreakEvenEnabled: Boolean((position as any).stratBreakEvenEnabled),
        stratTrailingEnabled: Boolean((position as any).stratTrailingEnabled),
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
      })),
      watchedSymbols: Array.from(positionsByMarketKey.keys()),
      lastReloadAt,
      lastMarketEventAt,
      lastWarning,
    }));
    return;
  }

  if (url.pathname === '/reload-positions') {
    try {
      await reloadOpenPositions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        openPositions: openPositions.size,
        watchedSymbols: positionsByMarketKey.size,
        lastReloadAt,
      }));
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        message: error?.message || 'Failed to reload positions',
      }));
    }
    return;
  }

  if (url.pathname === '/events') {
    const subscriberId = nextSubscriberId++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    engineSubscribers.set(subscriberId, { id: subscriberId, res });
    writeSse(res, 'ready', {
      subscriberId,
      openPositions: openPositions.size,
      watchedSymbols: positionsByMarketKey.size,
    });

    req.on('close', () => {
      removeSubscriber(subscriberId);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, message: 'Not found' }));
});

async function main() {
  await reloadOpenPositions();
  setInterval(() => {
    reloadOpenPositions().catch((error: any) => {
      lastWarning = `reload-positions: ${error?.message || 'unknown error'}`;
      emitEngineEvent('warning', {
        warning: lastWarning,
        at: Date.now(),
      });
    });
  }, POSITION_REFRESH_MS).unref();

  void streamMarketMode('demo');
  void streamMarketMode('live');

  server.listen(PORT, HOST, () => {
    console.log(`Trade engine running on http://${HOST}:${PORT}`);
  });
}

const shutdown = async (signal: string) => {
  console.log(`Shutting down trade engine (${signal})`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
