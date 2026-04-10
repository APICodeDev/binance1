import http from 'http';
import WebSocket from 'ws';

type ExchangeName = 'bybit' | 'binance' | 'bitget';
type BookSide = 'bid' | 'ask';
type TradeSide = 'buy' | 'sell';

type BookLevel = {
  price: number;
  size: number;
};

type NormalizedTrade = {
  exchange: ExchangeName;
  price: number;
  size: number;
  side: TradeSide;
  timestamp: number;
  id?: string;
};

type ExchangeBookState = {
  exchange: ExchangeName;
  symbol: string;
  bids: Map<number, number>;
  asks: Map<number, number>;
  bestBid: number | null;
  bestAsk: number | null;
  lastUpdateTs: number | null;
  status: 'connecting' | 'open' | 'closed' | 'error';
  lastError?: string;
};

type SymbolState = {
  symbol: string;
  exchanges: Record<ExchangeName, ExchangeBookState>;
  trades: NormalizedTrade[];
  heatmapFrames: Array<{
    ts: number;
    mid: number;
    buckets: Record<string, number>;
  }>;
  lastHeatmapCaptureTs: number | null;
  lastPrice: number | null;
  lastTradeTs: number | null;
  subscribedAt: number;
  activePreSignal: {
    actionable: boolean;
    bias: 'long' | 'short' | 'neutral';
    confidence: number;
    entryPrice: number | null;
    stopPrice: number | null;
    targetPrice: number | null;
    rewardRisk: number | null;
    invalidation: string | null;
    mode: 'ready' | 'watch' | 'active' | 'invalidated' | 'replaced';
    reasons: string[];
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    invalidatedAt: number | null;
    invalidationReason: string | null;
  } | null;
};

type ZoneSummary = {
  price: number;
  totalSize: number;
  totalNotional: number;
  exchangeCount: number;
  exchanges: ExchangeName[];
  distancePercent: number;
};

type AbsorptionSignal = {
  side: 'bullish' | 'bearish';
  price: number;
  confidence: number;
  absorbedVolume: number;
  tradeCount: number;
  note: string;
};

type FeedState = {
  key: string;
  exchange: ExchangeName;
  symbol: string;
  ws: WebSocket;
  heartbeat?: NodeJS.Timeout;
};

const PORT = Number.parseInt(process.env.BOOKMAP_WS_SERVICE_PORT || '8788', 10);
const HOST = process.env.BOOKMAP_WS_SERVICE_HOST || '127.0.0.1';
const TRADE_BUFFER_SIZE = Number.parseInt(process.env.BOOKMAP_TRADE_BUFFER_SIZE || '160', 10);
const MAX_LEVELS_PER_SIDE = Number.parseInt(process.env.BOOKMAP_MAX_LEVELS_PER_SIDE || '80', 10);
const SYMBOL_STALE_MS = Number.parseInt(process.env.BOOKMAP_STALE_MS || '15000', 10);
const HEATMAP_CAPTURE_INTERVAL_MS = Number.parseInt(process.env.BOOKMAP_CAPTURE_INTERVAL_MS || '1500', 10);
const HEATMAP_MAX_FRAMES = Number.parseInt(process.env.BOOKMAP_MAX_FRAMES || '48', 10);
const HEATMAP_ROW_COUNT = Number.parseInt(process.env.BOOKMAP_HEATMAP_ROWS || '36', 10);
const HEATMAP_VISIBLE_BAND_PERCENT = Number.parseFloat(process.env.BOOKMAP_VISIBLE_BAND_PERCENT || '0.18');
const ABSORPTION_LOOKBACK_TRADES = Number.parseInt(process.env.BOOKMAP_ABSORPTION_LOOKBACK_TRADES || '36', 10);
const PRESIGNAL_MIN_CONFIDENCE = Number.parseFloat(process.env.BOOKMAP_PRESIGNAL_MIN_CONFIDENCE || '0.68');
const PRESIGNAL_MAX_AGE_MS = Number.parseInt(process.env.BOOKMAP_PRESIGNAL_MAX_AGE_MS || '180000', 10);
const PRESIGNAL_REPLACE_CONFIDENCE_DELTA = Number.parseFloat(process.env.BOOKMAP_PRESIGNAL_REPLACE_CONFIDENCE_DELTA || '0.08');

const feeds = new Map<string, FeedState>();
const symbols = new Map<string, SymbolState>();

const bybitPublicUrl = 'wss://stream.bybit.com/v5/public/linear';
const bitgetPublicUrl = 'wss://ws.bitget.com/v2/ws/public';

const makeFeedKey = (exchange: ExchangeName, symbol: string) => `${exchange}:${symbol}`;

const getProductType = (symbol: string) => {
  if (symbol.endsWith('USDC')) return 'USDC-FUTURES';
  if (symbol.endsWith('USD')) return 'COIN-FUTURES';
  return 'USDT-FUTURES';
};

const ensureSymbolState = (rawSymbol: string): SymbolState => {
  const symbol = rawSymbol.toUpperCase();
  const existing = symbols.get(symbol);
  if (existing) {
    return existing;
  }

  const makeExchange = (exchange: ExchangeName): ExchangeBookState => ({
    exchange,
    symbol,
    bids: new Map(),
    asks: new Map(),
    bestBid: null,
    bestAsk: null,
    lastUpdateTs: null,
    status: 'connecting',
  });

  const state: SymbolState = {
    symbol,
    exchanges: {
      bybit: makeExchange('bybit'),
      binance: makeExchange('binance'),
      bitget: makeExchange('bitget'),
    },
    trades: [],
    heatmapFrames: [],
    lastHeatmapCaptureTs: null,
    lastPrice: null,
    lastTradeTs: null,
    subscribedAt: Date.now(),
    activePreSignal: null,
  };

  symbols.set(symbol, state);
  return state;
};

const normalizeNumber = (value: unknown) => {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const updateBestPrices = (book: ExchangeBookState) => {
  const bidPrices = Array.from(book.bids.keys()).sort((a, b) => b - a);
  const askPrices = Array.from(book.asks.keys()).sort((a, b) => a - b);
  book.bestBid = bidPrices[0] ?? null;
  book.bestAsk = askPrices[0] ?? null;
};

const replaceBookSide = (book: ExchangeBookState, side: BookSide, levels: unknown[]) => {
  const target = side === 'bid' ? book.bids : book.asks;
  target.clear();

  if (!Array.isArray(levels)) {
    updateBestPrices(book);
    return;
  }

  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) {
      continue;
    }

    const price = normalizeNumber(level[0]);
    const size = normalizeNumber(level[1]);
    if (price === null || size === null || size <= 0) {
      continue;
    }

    target.set(price, size);
  }

  updateBestPrices(book);
};

const applyDeltaSide = (book: ExchangeBookState, side: BookSide, levels: unknown[]) => {
  const target = side === 'bid' ? book.bids : book.asks;
  if (!Array.isArray(levels)) {
    updateBestPrices(book);
    return;
  }

  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) {
      continue;
    }

    const price = normalizeNumber(level[0]);
    const size = normalizeNumber(level[1]);
    if (price === null || size === null) {
      continue;
    }

    if (size <= 0) {
      target.delete(price);
    } else {
      target.set(price, size);
    }
  }

  updateBestPrices(book);
};

const setBookTimestamp = (book: ExchangeBookState, ts?: number | null) => {
  book.lastUpdateTs = ts && Number.isFinite(ts) ? ts : Date.now();
  book.status = 'open';
  book.lastError = undefined;
};

const pushTrades = (state: SymbolState, incoming: NormalizedTrade[]) => {
  if (incoming.length === 0) {
    return;
  }

  state.trades.push(...incoming);
  if (state.trades.length > TRADE_BUFFER_SIZE) {
    state.trades.splice(0, state.trades.length - TRADE_BUFFER_SIZE);
  }

  const latest = incoming[incoming.length - 1];
  state.lastPrice = latest.price;
  state.lastTradeTs = latest.timestamp;
};

const getSortedLevels = (sideMap: Map<number, number>, side: BookSide) =>
  Array.from(sideMap.entries())
    .sort((a, b) => (side === 'bid' ? b[0] - a[0] : a[0] - b[0]))
    .slice(0, MAX_LEVELS_PER_SIDE)
    .map(([price, size]) => ({ price, size }));

const roundToStep = (value: number, step: number) => Math.round(value / step) * step;

const getSignalStep = (price: number) => {
  if (price >= 100000) return 25;
  if (price >= 10000) return 5;
  if (price >= 1000) return 1;
  if (price >= 100) return 0.1;
  if (price >= 1) return 0.01;
  return 0.0001;
};

const getZoneBucketStep = (price: number) => {
  if (price >= 100000) return 5;
  if (price >= 10000) return 1;
  if (price >= 1000) return 0.1;
  if (price >= 100) return 0.01;
  if (price >= 1) return 0.001;
  return 0.0001;
};

const getHeatmapStep = (price: number) => {
  if (price >= 100000) return 5;
  if (price >= 10000) return 1;
  if (price >= 1000) return 0.1;
  if (price >= 100) return 0.01;
  if (price >= 1) return 0.001;
  return 0.0001;
};

const getCompositeMid = (state: SymbolState) => {
  const pairs = (Object.keys(state.exchanges) as ExchangeName[])
    .map((exchange) => state.exchanges[exchange])
    .filter((book) => book.bestBid !== null && book.bestAsk !== null && book.lastUpdateTs !== null && (Date.now() - book.lastUpdateTs) <= SYMBOL_STALE_MS);

  if (pairs.length === 0) {
    return state.lastPrice || 0;
  }

  const bestBid = pairs.reduce((sum, book) => sum + (book.bestBid as number), 0) / pairs.length;
  const bestAsk = pairs.reduce((sum, book) => sum + (book.bestAsk as number), 0) / pairs.length;
  return (bestBid + bestAsk) / 2;
};

const captureHeatmapFrame = (state: SymbolState) => {
  const now = Date.now();
  if (state.lastHeatmapCaptureTs !== null && (now - state.lastHeatmapCaptureTs) < HEATMAP_CAPTURE_INTERVAL_MS) {
    return;
  }

  const mid = getCompositeMid(state);
  if (!Number.isFinite(mid) || mid <= 0) {
    return;
  }

  const step = getHeatmapStep(mid);
  const bandDistance = mid * (HEATMAP_VISIBLE_BAND_PERCENT / 100);
  const minPrice = mid - bandDistance;
  const maxPrice = mid + bandDistance;
  const buckets: Record<string, number> = {};

  for (const exchange of Object.keys(state.exchanges) as ExchangeName[]) {
    const book = state.exchanges[exchange];
    const levels = [
      ...getSortedLevels(book.bids, 'bid').slice(0, 24),
      ...getSortedLevels(book.asks, 'ask').slice(0, 24),
    ];

    for (const level of levels) {
      if (level.price < minPrice || level.price > maxPrice) {
        continue;
      }

      const bucketPrice = roundToStep(level.price, step);
      const key = bucketPrice.toFixed(8);
      buckets[key] = (buckets[key] || 0) + (level.price * level.size);
    }
  }

  state.heatmapFrames.push({
    ts: now,
    mid,
    buckets,
  });

  if (state.heatmapFrames.length > HEATMAP_MAX_FRAMES) {
    state.heatmapFrames.splice(0, state.heatmapFrames.length - HEATMAP_MAX_FRAMES);
  }

  state.lastHeatmapCaptureTs = now;
};

const buildHeatmap = (state: SymbolState, mid: number) => {
  const frames = state.heatmapFrames.slice(-HEATMAP_MAX_FRAMES);
  if (frames.length === 0 || mid <= 0) {
    return {
      rows: [] as number[],
      columns: [] as number[],
      mids: [] as number[],
      cells: [] as number[][],
      maxIntensity: 0,
      step: 0,
    };
  }

  const step = getHeatmapStep(mid);
  const halfRows = Math.floor(HEATMAP_ROW_COUNT / 2);
  const centerBucket = roundToStep(mid, step);
  const rows = Array.from({ length: HEATMAP_ROW_COUNT }, (_, index) => centerBucket + ((halfRows - index) * step))
    .map((price) => Number(price.toFixed(8)));
  const columns = frames.map((frame) => frame.ts);
  const mids = frames.map((frame) => Number(frame.mid.toFixed(8)));

  let maxIntensity = 0;
  const cells = rows.map((price) => {
    const key = price.toFixed(8);
    return frames.map((frame) => {
      const value = frame.buckets[key] || 0;
      if (value > maxIntensity) {
        maxIntensity = value;
      }
      return value;
    });
  });

  const normalizedCells = maxIntensity > 0
    ? cells.map((row) => row.map((value) => Number((value / maxIntensity).toFixed(4))))
    : cells.map((row) => row.map(() => 0));

  return {
    rows,
    columns,
    mids,
    cells: normalizedCells,
    maxIntensity: Number(maxIntensity.toFixed(2)),
    step,
  };
};

const ensureFeed = (exchange: ExchangeName, rawSymbol: string) => {
  const symbol = rawSymbol.toUpperCase();
  const key = makeFeedKey(exchange, symbol);
  const existing = feeds.get(key);
  if (existing && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) {
    return existing;
  }

  const state = ensureSymbolState(symbol);
  const book = state.exchanges[exchange];
  book.status = 'connecting';

  const ws = createExchangeSocket(exchange, symbol);
  const feed: FeedState = { key, exchange, symbol, ws };
  feeds.set(key, feed);
  return feed;
};

const createExchangeSocket = (exchange: ExchangeName, symbol: string) => {
  if (exchange === 'bybit') {
    return createBybitSocket(symbol);
  }

  if (exchange === 'binance') {
    return createBinanceSocket(symbol);
  }

  return createBitgetSocket(symbol);
};

const createBybitSocket = (symbol: string) => {
  const state = ensureSymbolState(symbol);
  const book = state.exchanges.bybit;
  const ws = new WebSocket(bybitPublicUrl);

  ws.on('open', () => {
    book.status = 'open';
    ws.send(JSON.stringify({
      op: 'subscribe',
      args: [`orderbook.50.${symbol}`, `publicTrade.${symbol}`],
    }));

    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20_000);
    heartbeat.unref();

    const feed = feeds.get(makeFeedKey('bybit', symbol));
    if (feed) {
      feed.heartbeat = heartbeat;
    }
  });

  ws.on('message', (buffer) => {
    const raw = buffer.toString();
    let payload: any;

    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    if (payload?.op === 'ping' || payload?.ret_msg === 'pong' || payload?.success === true && payload?.op === 'subscribe') {
      return;
    }

    if (typeof payload?.topic === 'string' && payload.topic.startsWith('orderbook.')) {
      const data = payload?.data || {};
      const messageType = payload?.type === 'delta' ? 'delta' : 'snapshot';
      if (messageType === 'snapshot') {
        replaceBookSide(book, 'bid', data.b || []);
        replaceBookSide(book, 'ask', data.a || []);
      } else {
        applyDeltaSide(book, 'bid', data.b || []);
        applyDeltaSide(book, 'ask', data.a || []);
      }
      setBookTimestamp(book, normalizeNumber(payload?.cts) || normalizeNumber(payload?.ts));
      return;
    }

    if (typeof payload?.topic === 'string' && payload.topic.startsWith('publicTrade.')) {
      const trades = Array.isArray(payload?.data) ? payload.data : [];
      pushTrades(
        state,
        trades
          .map((trade: any) => {
            const price = normalizeNumber(trade?.p);
            const size = normalizeNumber(trade?.v);
            const timestamp = normalizeNumber(trade?.T);
            if (price === null || size === null || timestamp === null) {
              return null;
            }

            return {
              exchange: 'bybit' as const,
              price,
              size,
              side: String(trade?.S || '').toLowerCase() === 'sell' ? 'sell' : 'buy',
              timestamp,
              id: String(trade?.i || ''),
            };
          })
          .filter(Boolean) as NormalizedTrade[]
      );
    }
  });

  ws.on('error', (error) => {
    book.status = 'error';
    book.lastError = error.message;
  });

  ws.on('close', () => {
    book.status = 'closed';
    const feed = feeds.get(makeFeedKey('bybit', symbol));
    if (feed?.heartbeat) {
      clearInterval(feed.heartbeat);
    }
    setTimeout(() => ensureFeed('bybit', symbol), 2_000);
  });

  return ws;
};

const createBinanceSocket = (symbol: string) => {
  const lower = symbol.toLowerCase();
  const state = ensureSymbolState(symbol);
  const book = state.exchanges.binance;
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${lower}@depth20@100ms/${lower}@aggTrade`);

  ws.on('open', () => {
    book.status = 'open';
  });

  ws.on('message', (buffer) => {
    const raw = buffer.toString();
    let payload: any;

    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const stream = String(payload?.stream || '');
    const data = payload?.data || {};

    if (stream.includes('@depth')) {
      replaceBookSide(book, 'bid', data.b || []);
      replaceBookSide(book, 'ask', data.a || []);
      setBookTimestamp(book, normalizeNumber(data?.E) || normalizeNumber(data?.T));
      return;
    }

    if (stream.includes('@aggTrade')) {
      const price = normalizeNumber(data?.p);
      const size = normalizeNumber(data?.q);
      const timestamp = normalizeNumber(data?.T);
      if (price === null || size === null || timestamp === null) {
        return;
      }

      pushTrades(state, [{
        exchange: 'binance',
        price,
        size,
        side: data?.m ? 'sell' : 'buy',
        timestamp,
        id: String(data?.a || ''),
      }]);
    }
  });

  ws.on('error', (error) => {
    book.status = 'error';
    book.lastError = error.message;
  });

  ws.on('close', () => {
    book.status = 'closed';
    setTimeout(() => ensureFeed('binance', symbol), 2_000);
  });

  return ws;
};

const createBitgetSocket = (symbol: string) => {
  const state = ensureSymbolState(symbol);
  const book = state.exchanges.bitget;
  const ws = new WebSocket(bitgetPublicUrl);

  ws.on('open', () => {
    book.status = 'open';
    ws.send(JSON.stringify({
      op: 'subscribe',
      args: [
        {
          instType: getProductType(symbol),
          channel: 'books15',
          instId: symbol,
        },
        {
          instType: getProductType(symbol),
          channel: 'trade',
          instId: symbol,
        },
      ],
    }));

    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('ping');
      }
    }, 25_000);
    heartbeat.unref();

    const feed = feeds.get(makeFeedKey('bitget', symbol));
    if (feed) {
      feed.heartbeat = heartbeat;
    }
  });

  ws.on('message', (buffer) => {
    const raw = buffer.toString();
    if (raw === 'pong') {
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const channel = String(payload?.arg?.channel || '');
    if (channel === 'books15' || channel === 'books') {
      const entry = Array.isArray(payload?.data) ? payload.data[0] : null;
      if (!entry) {
        return;
      }
      replaceBookSide(book, 'bid', entry.bids || []);
      replaceBookSide(book, 'ask', entry.asks || []);
      setBookTimestamp(book, normalizeNumber(entry?.ts) || normalizeNumber(payload?.ts));
      return;
    }

    if (channel === 'trade') {
      const trades = Array.isArray(payload?.data) ? payload.data : [];
      pushTrades(
        state,
        trades
          .map((trade: any) => {
            const price = normalizeNumber(trade?.price);
            const size = normalizeNumber(trade?.size);
            const timestamp = normalizeNumber(trade?.ts);
            if (price === null || size === null || timestamp === null) {
              return null;
            }

            return {
              exchange: 'bitget' as const,
              price,
              size,
              side: String(trade?.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy',
              timestamp,
              id: String(trade?.tradeId || ''),
            };
          })
          .filter(Boolean) as NormalizedTrade[]
      );
    }
  });

  ws.on('error', (error) => {
    book.status = 'error';
    book.lastError = error.message;
  });

  ws.on('close', () => {
    book.status = 'closed';
    const feed = feeds.get(makeFeedKey('bitget', symbol));
    if (feed?.heartbeat) {
      clearInterval(feed.heartbeat);
    }
    setTimeout(() => ensureFeed('bitget', symbol), 2_000);
  });

  return ws;
};

const subscribeSymbol = (symbol: string) => {
  const normalized = symbol.toUpperCase();
  ensureSymbolState(normalized);
  ensureFeed('bybit', normalized);
  ensureFeed('binance', normalized);
  ensureFeed('bitget', normalized);
};

const levelDistancePercent = (price: number, mid: number) => (mid > 0 ? Math.abs((price - mid) / mid) * 100 : 0);

const buildZones = (state: SymbolState, side: BookSide, mid: number): ZoneSummary[] => {
  const buckets = new Map<string, {
    side: BookSide;
    price: number;
    totalSize: number;
    totalNotional: number;
    exchanges: Set<ExchangeName>;
  }>();

  (Object.keys(state.exchanges) as ExchangeName[]).forEach((exchange) => {
    const book = state.exchanges[exchange];
    const levels = getSortedLevels(side === 'bid' ? book.bids : book.asks, side);
    for (const level of levels) {
      if (mid > 0 && levelDistancePercent(level.price, mid) > 1.2) {
        continue;
      }

      const step = getZoneBucketStep(level.price);
      const bucketPrice = roundToStep(level.price, step);
      const bucketKey = `${side}:${bucketPrice.toFixed(8)}`;
      const current = buckets.get(bucketKey) || {
        side,
        price: bucketPrice,
        totalSize: 0,
        totalNotional: 0,
        exchanges: new Set<ExchangeName>(),
      };

      current.totalSize += level.size;
      current.totalNotional += level.price * level.size;
      current.exchanges.add(exchange);
      buckets.set(bucketKey, current);
    }
  });

  return Array.from(buckets.values())
    .sort((a, b) => b.totalNotional - a.totalNotional)
    .slice(0, 6)
    .map((zone) => ({
      price: Number(zone.price.toFixed(8)),
      totalSize: Number(zone.totalSize.toFixed(6)),
      totalNotional: Number(zone.totalNotional.toFixed(2)),
      exchangeCount: zone.exchanges.size,
      exchanges: Array.from(zone.exchanges.values()),
      distancePercent: Number(levelDistancePercent(zone.price, mid).toFixed(4)),
    }));
};

const findNearestRowIndex = (rows: number[], price: number) => {
  let nearestRow = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const distance = Math.abs(rows[rowIndex] - price);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestRow = rowIndex;
    }
  }
  return nearestRow;
};

const buildHeatmapTradeOverlay = (
  rows: number[],
  columns: number[],
  trades: NormalizedTrade[],
) => {
  if (rows.length === 0 || columns.length === 0) {
    return [];
  }

  const firstTs = columns[0];
  const lastTs = columns[columns.length - 1];

  return trades
    .filter((trade) => trade.timestamp >= firstTs && trade.timestamp <= lastTs)
    .slice(-40)
    .map((trade) => {
      let nearestColumn = 0;
      let nearestColumnDistance = Number.POSITIVE_INFINITY;
      for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
        const distance = Math.abs(columns[columnIndex] - trade.timestamp);
        if (distance < nearestColumnDistance) {
          nearestColumnDistance = distance;
          nearestColumn = columnIndex;
        }
      }

      return {
        exchange: trade.exchange,
        side: trade.side,
        price: Number(trade.price.toFixed(8)),
        size: Number(trade.size.toFixed(6)),
        timestamp: trade.timestamp,
        columnIndex: nearestColumn,
        rowIndex: findNearestRowIndex(rows, trade.price),
      };
    });
};

const buildAbsorptionSignals = (
  state: SymbolState,
  supports: ZoneSummary[],
  resistances: ZoneSummary[],
  lastPrice: number,
) : AbsorptionSignal[] => {
  const trades = state.trades.slice(-ABSORPTION_LOOKBACK_TRADES);
  const bullishSignals = supports
    .map((zone) => {
      const nearTrades = trades.filter((trade) => trade.side === 'sell' && Math.abs((trade.price - zone.price) / zone.price) * 100 <= 0.08);
      const absorbedVolume = nearTrades.reduce((sum, trade) => sum + trade.size, 0);
      const held = lastPrice >= zone.price;
      if (!held || nearTrades.length < 3 || absorbedVolume <= 0) {
        return null;
      }

      const score = Math.min(0.98, 0.28 + zone.exchangeCount * 0.12 + Math.min(0.4, absorbedVolume / 50));
      return {
        side: 'bullish' as const,
        price: zone.price,
        confidence: Number(score.toFixed(2)),
        absorbedVolume: Number(absorbedVolume.toFixed(4)),
        tradeCount: nearTrades.length,
        note: `Ventas agresivas absorbidas sobre soporte ${zone.price.toFixed(4)} sin perdida clara del nivel.`,
      };
    })
    .filter((signal): signal is {
      side: 'bullish';
      price: number;
      confidence: number;
      absorbedVolume: number;
      tradeCount: number;
      note: string;
    } => Boolean(signal));

  const bearishSignals = resistances
    .map((zone) => {
      const nearTrades = trades.filter((trade) => trade.side === 'buy' && Math.abs((trade.price - zone.price) / zone.price) * 100 <= 0.08);
      const absorbedVolume = nearTrades.reduce((sum, trade) => sum + trade.size, 0);
      const held = lastPrice <= zone.price;
      if (!held || nearTrades.length < 3 || absorbedVolume <= 0) {
        return null;
      }

      const score = Math.min(0.98, 0.28 + zone.exchangeCount * 0.12 + Math.min(0.4, absorbedVolume / 50));
      return {
        side: 'bearish' as const,
        price: zone.price,
        confidence: Number(score.toFixed(2)),
        absorbedVolume: Number(absorbedVolume.toFixed(4)),
        tradeCount: nearTrades.length,
        note: `Compras agresivas absorbidas bajo resistencia ${zone.price.toFixed(4)} sin ruptura limpia.`,
      };
    })
    .filter((signal): signal is {
      side: 'bearish';
      price: number;
      confidence: number;
      absorbedVolume: number;
      tradeCount: number;
      note: string;
    } => Boolean(signal));

  return [...bullishSignals, ...bearishSignals]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
};

const buildPreSignal = ({
  lastPrice,
  mid,
  step,
  trigger,
  absorptionSignals,
  supports,
  resistances,
}: {
  lastPrice: number;
  mid: number;
  step: number;
  trigger: ReturnType<typeof buildTrigger>;
  absorptionSignals: AbsorptionSignal[];
  supports: ZoneSummary[];
  resistances: ZoneSummary[];
}) => {
  const bullishAbsorption = absorptionSignals.find((signal) => signal.side === 'bullish');
  const bearishAbsorption = absorptionSignals.find((signal) => signal.side === 'bearish');
  const topSupport = supports[0] || null;
  const topResistance = resistances[0] || null;
  const reasons: string[] = [];

  if (trigger.bias === 'long') {
    reasons.push('Trigger microestructural con sesgo long');
  } else if (trigger.bias === 'short') {
    reasons.push('Trigger microestructural con sesgo short');
  } else {
    reasons.push('Trigger neutral');
  }

  if (bullishAbsorption) {
    reasons.push(`Absorcion alcista en ${bullishAbsorption.price.toFixed(4)}`);
  }

  if (bearishAbsorption) {
    reasons.push(`Absorcion bajista en ${bearishAbsorption.price.toFixed(4)}`);
  }

  let bias: 'long' | 'short' | 'neutral' = 'neutral';
  let confidence = trigger.confidence;
  let entryPrice: number | null = null;
  let stopPrice: number | null = null;
  let targetPrice: number | null = null;
  let invalidation: string | null = null;

  if (
    bullishAbsorption &&
    topSupport &&
    (trigger.bias === 'long' || trigger.bias === 'neutral') &&
    Math.abs((lastPrice - topSupport.price) / lastPrice) * 100 <= 0.2
  ) {
    bias = 'long';
    confidence = Math.min(0.99, Math.max(trigger.confidence, bullishAbsorption.confidence));
    entryPrice = Number((Math.max(lastPrice, topSupport.price)).toFixed(8));
    stopPrice = Number((topSupport.price - (step * 2)).toFixed(8));
    const candidateTarget = topResistance
      ? Number((topResistance.price - step).toFixed(8))
      : Number((entryPrice + (step * 6)).toFixed(8));
    targetPrice = candidateTarget > entryPrice
      ? candidateTarget
      : Number((entryPrice + (step * 4)).toFixed(8));
    invalidation = `Pierde ${topSupport.price.toFixed(4)} con continuidad vendedora`;
  } else if (
    bearishAbsorption &&
    topResistance &&
    (trigger.bias === 'short' || trigger.bias === 'neutral') &&
    Math.abs((topResistance.price - lastPrice) / lastPrice) * 100 <= 0.2
  ) {
    bias = 'short';
    confidence = Math.min(0.99, Math.max(trigger.confidence, bearishAbsorption.confidence));
    entryPrice = Number((Math.min(lastPrice, topResistance.price)).toFixed(8));
    stopPrice = Number((topResistance.price + (step * 2)).toFixed(8));
    const candidateTarget = topSupport
      ? Number((topSupport.price + step).toFixed(8))
      : Number((entryPrice - (step * 6)).toFixed(8));
    targetPrice = candidateTarget < entryPrice
      ? candidateTarget
      : Number((entryPrice - (step * 4)).toFixed(8));
    invalidation = `Recupera ${topResistance.price.toFixed(4)} con continuidad compradora`;
  }

  const actionable = bias !== 'neutral' && confidence >= PRESIGNAL_MIN_CONFIDENCE && entryPrice !== null && stopPrice !== null && targetPrice !== null;
  const rewardRisk = actionable && entryPrice !== null && stopPrice !== null && targetPrice !== null
    ? Number((Math.abs(targetPrice - entryPrice) / Math.max(step, Math.abs(entryPrice - stopPrice))).toFixed(2))
    : null;

  return {
    actionable,
    bias,
    confidence: Number(confidence.toFixed(2)),
    entryPrice,
    stopPrice,
    targetPrice,
    rewardRisk,
    invalidation,
    mode: actionable ? 'ready' : 'watch',
    reasons,
  };
};

const reconcilePreSignal = (
  state: SymbolState,
  candidate: ReturnType<typeof buildPreSignal>,
  lastPrice: number,
) => {
  const now = Date.now();
  const existing = state.activePreSignal;

  const invalidateExisting = (reason: string) => {
    if (!existing) {
      return null;
    }

    const invalidated = {
      ...existing,
      actionable: false,
      mode: 'invalidated' as const,
      updatedAt: now,
      invalidatedAt: now,
      invalidationReason: reason,
    };
    state.activePreSignal = invalidated;
    return invalidated;
  };

  if (existing) {
    if (existing.expiresAt <= now) {
      invalidateExisting('La pre-senal caduco por tiempo');
    } else if (existing.bias === 'long' && existing.stopPrice !== null && lastPrice <= existing.stopPrice) {
      invalidateExisting('El precio perdio el stop de la pre-senal long');
    } else if (existing.bias === 'short' && existing.stopPrice !== null && lastPrice >= existing.stopPrice) {
      invalidateExisting('El precio invalido el stop de la pre-senal short');
    }
  }

  const current = state.activePreSignal;
  if (candidate.actionable) {
    if (!current || current.mode === 'invalidated' || current.mode === 'replaced' || current.bias === 'neutral') {
      const created = {
        ...candidate,
        mode: 'active' as const,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + PRESIGNAL_MAX_AGE_MS,
        invalidatedAt: null,
        invalidationReason: null,
      };
      state.activePreSignal = created;
      return created;
    }

    if (current.bias === candidate.bias) {
      const refreshed = {
        ...current,
        ...candidate,
        mode: 'active' as const,
        updatedAt: now,
        expiresAt: now + PRESIGNAL_MAX_AGE_MS,
        invalidatedAt: null,
        invalidationReason: null,
      };
      state.activePreSignal = refreshed;
      return refreshed;
    }

    if (candidate.confidence >= (current.confidence + PRESIGNAL_REPLACE_CONFIDENCE_DELTA)) {
      const replaced = {
        ...candidate,
        mode: 'active' as const,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + PRESIGNAL_MAX_AGE_MS,
        invalidatedAt: null,
        invalidationReason: `Reemplazada por nueva pre-senal ${candidate.bias} con mayor confianza`,
      };
      state.activePreSignal = replaced;
      return replaced;
    }

    return current;
  }

  if (current && current.mode === 'active' && current.expiresAt > now) {
    return current;
  }

  return candidate.actionable ? candidate : {
    ...candidate,
    mode: 'watch' as const,
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
    invalidatedAt: null,
    invalidationReason: null,
  };
};

const buildTrigger = (state: SymbolState, mid: number, supports: ReturnType<typeof buildZones>, resistances: ReturnType<typeof buildZones>) => {
  const recentTrades = state.trades.slice(-30);
  const buyVolume = recentTrades.filter((trade) => trade.side === 'buy').reduce((sum, trade) => sum + trade.size, 0);
  const sellVolume = recentTrades.filter((trade) => trade.side === 'sell').reduce((sum, trade) => sum + trade.size, 0);
  const imbalance = buyVolume + sellVolume > 0 ? (buyVolume - sellVolume) / (buyVolume + sellVolume) : 0;
  const lastPrice = state.lastPrice || mid;

  const nearestSupport = supports
    .slice()
    .sort((a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price))[0];
  const nearestResistance = resistances
    .slice()
    .sort((a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price))[0];

  const supportDistance = nearestSupport ? Math.abs((lastPrice - nearestSupport.price) / lastPrice) * 100 : Number.POSITIVE_INFINITY;
  const resistanceDistance = nearestResistance ? Math.abs((nearestResistance.price - lastPrice) / lastPrice) * 100 : Number.POSITIVE_INFINITY;

  if (nearestSupport && supportDistance <= 0.12 && imbalance > 0.18 && nearestSupport.exchangeCount >= 2) {
    return {
      bias: 'long' as const,
      confidence: Number(Math.min(0.95, 0.45 + imbalance + nearestSupport.exchangeCount * 0.08).toFixed(2)),
      reason: `Precio cerca de soporte agregado ${nearestSupport.price.toFixed(4)} con agresion compradora reciente.`,
      referencePrice: nearestSupport.price,
    };
  }

  if (nearestResistance && resistanceDistance <= 0.12 && imbalance < -0.18 && nearestResistance.exchangeCount >= 2) {
    return {
      bias: 'short' as const,
      confidence: Number(Math.min(0.95, 0.45 + Math.abs(imbalance) + nearestResistance.exchangeCount * 0.08).toFixed(2)),
      reason: `Precio cerca de resistencia agregada ${nearestResistance.price.toFixed(4)} con agresion vendedora reciente.`,
      referencePrice: nearestResistance.price,
    };
  }

  return {
    bias: 'neutral' as const,
    confidence: Number((0.2 + Math.abs(imbalance) * 0.25).toFixed(2)),
    reason: 'Sin rebote confirmado todavia. Esperando confluencia de zona y tape.',
    referencePrice: null,
  };
};

const buildSummary = (rawSymbol: string) => {
  const symbol = rawSymbol.toUpperCase();
  const state = symbols.get(symbol);
  if (!state) {
    return null;
  }

  const exchangeSummaries = (Object.keys(state.exchanges) as ExchangeName[]).map((exchange) => {
    const book = state.exchanges[exchange];
    const bidLevels = getSortedLevels(book.bids, 'bid').slice(0, 12);
    const askLevels = getSortedLevels(book.asks, 'ask').slice(0, 12);
    const bestBid = bidLevels[0]?.price ?? null;
    const bestAsk = askLevels[0]?.price ?? null;
    const spreadBps = bestBid && bestAsk ? ((bestAsk - bestBid) / ((bestBid + bestAsk) / 2)) * 10_000 : null;
    const lastUpdateAgeMs = book.lastUpdateTs ? Math.max(0, Date.now() - book.lastUpdateTs) : null;

    return {
      exchange,
      status: book.status,
      lastError: book.lastError || null,
      bestBid,
      bestAsk,
      spreadBps: spreadBps !== null ? Number(spreadBps.toFixed(2)) : null,
      lastUpdateTs: book.lastUpdateTs,
      lastUpdateAgeMs,
      isFresh: lastUpdateAgeMs !== null && lastUpdateAgeMs <= SYMBOL_STALE_MS,
      bidLevels,
      askLevels,
    };
  });

  const freshExchanges = exchangeSummaries.filter((item) => item.isFresh && item.bestBid !== null && item.bestAsk !== null);
  const sourceExchanges = freshExchanges.length > 0
    ? freshExchanges
    : exchangeSummaries.filter((item) => item.bestBid !== null && item.bestAsk !== null);
  const validBestBids = sourceExchanges.map((item) => item.bestBid as number);
  const validBestAsks = sourceExchanges.map((item) => item.bestAsk as number);
  const compositeBestBid = validBestBids.length > 0
    ? validBestBids.reduce((sum, value) => sum + value, 0) / validBestBids.length
    : null;
  const compositeBestAsk = validBestAsks.length > 0
    ? validBestAsks.reduce((sum, value) => sum + value, 0) / validBestAsks.length
    : null;
  const mid = compositeBestBid !== null && compositeBestAsk !== null ? (compositeBestBid + compositeBestAsk) / 2 : (state.lastPrice || 0);
  const supports = buildZones(state, 'bid', mid);
  const resistances = buildZones(state, 'ask', mid);
  const trigger = buildTrigger(state, mid, supports, resistances);
  captureHeatmapFrame(state);
  const heatmap = buildHeatmap(state, mid);

  const recentTrades = state.trades
    .slice(-20)
    .map((trade) => ({
      exchange: trade.exchange,
      price: trade.price,
      size: Number(trade.size.toFixed(6)),
      side: trade.side,
      timestamp: trade.timestamp,
    }));

  const buyVolume = recentTrades.filter((trade) => trade.side === 'buy').reduce((sum, trade) => sum + trade.size, 0);
  const sellVolume = recentTrades.filter((trade) => trade.side === 'sell').reduce((sum, trade) => sum + trade.size, 0);
  const imbalance = buyVolume + sellVolume > 0 ? (buyVolume - sellVolume) / (buyVolume + sellVolume) : 0;
  const heatmapTrades = buildHeatmapTradeOverlay(heatmap.rows, heatmap.columns, state.trades);
  const lastPrice = state.lastPrice || mid;
  const absorptionSignals = buildAbsorptionSignals(state, supports, resistances, lastPrice);
  const preSignalCandidate = buildPreSignal({
    lastPrice,
    mid,
    step: getSignalStep(lastPrice || mid || 1),
    trigger,
    absorptionSignals,
    supports,
    resistances,
  });
  const preSignal = reconcilePreSignal(state, preSignalCandidate, lastPrice);

  return {
    ok: true,
    symbol,
    asOf: Date.now(),
    lastPrice: state.lastPrice,
    lastTradeTs: state.lastTradeTs,
    composite: {
      bestBid: compositeBestBid !== null ? Number(compositeBestBid.toFixed(8)) : null,
      bestAsk: compositeBestAsk !== null ? Number(compositeBestAsk.toFixed(8)) : null,
      mid: Number(mid.toFixed(8)),
      spreadBps: compositeBestBid !== null && compositeBestAsk !== null
        ? Number((Math.max(0, ((compositeBestAsk - compositeBestBid) / mid) * 10_000)).toFixed(2))
        : null,
    },
    exchanges: exchangeSummaries,
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
    heatmap,
    heatmapTrades,
    absorptionSignals,
    preSignal,
    trigger,
  };
};

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: 'Missing URL' }));
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      feeds: feeds.size,
      symbols: symbols.size,
      port: PORT,
    }));
    return;
  }

  if (url.pathname === '/subscribe') {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'symbol is required' }));
      return;
    }

    subscribeSymbol(symbol);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, symbol }));
    return;
  }

  if (url.pathname === '/summary') {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'symbol is required' }));
      return;
    }

    subscribeSymbol(symbol);
    const summary = buildSummary(symbol);
    const status = summary ? 200 : 404;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary || { ok: false, message: 'symbol not ready yet' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, message: 'Not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`Bookmap WS service running on http://${HOST}:${PORT}`);
});
