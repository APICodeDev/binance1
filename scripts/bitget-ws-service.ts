import http, { ServerResponse } from 'http';
import WebSocket from 'ws';

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

type MarketEvent = {
  channel: 'books1' | 'ticker';
  snapshot: MarketSnapshot;
};

type Subscriber = {
  id: number;
  mode: TradingMode | null;
  res: ServerResponse;
  symbols: Set<string> | null;
};

const PORT = Number.parseInt(process.env.BITGET_WS_SERVICE_PORT || '8787', 10);
const HOST = process.env.BITGET_WS_SERVICE_HOST || '127.0.0.1';
const STALE_MS = Number.parseInt(process.env.BITGET_WS_STALE_MS || '5000', 10);
const BOOKS_CHANNEL = process.env.BITGET_WS_CHANNEL || 'books1';
const TICKER_CHANNEL = process.env.BITGET_WS_TICKER_CHANNEL || 'ticker';
const PING_INTERVAL_MS = 25000;
const PUBLIC_URLS: Record<TradingMode, string> = {
  demo: 'wss://wspap.bitget.com/v2/ws/public',
  live: 'wss://ws.bitget.com/v2/ws/public',
};

const snapshots = new Map<string, MarketSnapshot>();
const subscriptions = new Map<string, { ws: WebSocket; tradingMode: TradingMode; symbols: Set<string> }>();
const subscribers = new Map<number, Subscriber>();
let nextSubscriberId = 1;

const makeKey = (tradingMode: TradingMode, symbol: string) => `${tradingMode}:${symbol.toUpperCase()}`;

const getProductType = (symbol: string) => {
  if (symbol.endsWith('USDC')) return 'USDC-FUTURES';
  if (symbol.endsWith('USD')) return 'COIN-FUTURES';
  return 'USDT-FUTURES';
};

const parseLevel = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const [priceRaw, sizeRaw] = value;
  const price = Number.parseFloat(String(priceRaw));
  const size = Number.parseFloat(String(sizeRaw));
  if (!Number.isFinite(price) || !Number.isFinite(size)) {
    return null;
  }

  return { price, size };
};

const parseOptionalNumber = (value: unknown) => {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const writeSse = (res: ServerResponse, event: string, payload: unknown) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const getSnapshotPayload = (snapshot: MarketSnapshot, channel: 'books1' | 'ticker'): MarketEvent => ({
  channel,
  snapshot,
});

const broadcastEvent = (event: string, payload: MarketEvent) => {
  for (const subscriber of Array.from(subscribers.values())) {
    if (subscriber.mode && subscriber.mode !== payload.snapshot.tradingMode) {
      continue;
    }

    if (subscriber.symbols && !subscriber.symbols.has(payload.snapshot.symbol)) {
      continue;
    }

    writeSse(subscriber.res, event, payload);
  }
};

const buildSubscribeArgs = (symbol: string) => ([
  {
    instType: getProductType(symbol),
    channel: BOOKS_CHANNEL,
    instId: symbol,
  },
  {
    instType: getProductType(symbol),
    channel: TICKER_CHANNEL,
    instId: symbol,
  },
]);

const updateSnapshot = (
  tradingMode: TradingMode,
  symbol: string,
  patch: Partial<MarketSnapshot>,
  channel: 'books1' | 'ticker'
) => {
  const key = makeKey(tradingMode, symbol);
  const previous = snapshots.get(key);
  const next: MarketSnapshot = {
    symbol,
    tradingMode,
    bestBid: previous?.bestBid ?? null,
    bestAsk: previous?.bestAsk ?? null,
    bidSize: previous?.bidSize ?? null,
    askSize: previous?.askSize ?? null,
    lastPrice: previous?.lastPrice ?? null,
    markPrice: previous?.markPrice ?? null,
    timestamp: previous?.timestamp ?? Date.now(),
    source: 'websocket',
    ...patch,
  };

  if (next.lastPrice === null && next.bestBid !== null && next.bestAsk !== null) {
    next.lastPrice = (next.bestBid + next.bestAsk) / 2;
  }

  snapshots.set(key, next);
  broadcastEvent('market', getSnapshotPayload(next, channel));
};

const applyBooksUpdate = (tradingMode: TradingMode, symbol: string, payload: any) => {
  const bestBid = parseLevel(payload?.bids?.[0]);
  const bestAsk = parseLevel(payload?.asks?.[0]);
  if (!bestBid || !bestAsk) {
    return;
  }

  updateSnapshot(tradingMode, symbol, {
    bestBid: bestBid.price,
    bestAsk: bestAsk.price,
    bidSize: bestBid.size,
    askSize: bestAsk.size,
    lastPrice: (bestBid.price + bestAsk.price) / 2,
    timestamp: Number.parseInt(String(payload?.ts || payload?.timestamp || Date.now()), 10) || Date.now(),
  }, 'books1');
};

const applyTickerUpdate = (tradingMode: TradingMode, symbol: string, payload: any) => {
  const lastPrice = parseOptionalNumber(payload?.lastPr ?? payload?.lastPrice);
  const markPrice = parseOptionalNumber(payload?.markPrice);
  const bidPrice = parseOptionalNumber(payload?.bidPr ?? payload?.bidPrice);
  const askPrice = parseOptionalNumber(payload?.askPr ?? payload?.askPrice);
  const bidSize = parseOptionalNumber(payload?.bidSz ?? payload?.bidSize);
  const askSize = parseOptionalNumber(payload?.askSz ?? payload?.askSize);

  updateSnapshot(tradingMode, symbol, {
    bestBid: bidPrice,
    bestAsk: askPrice,
    bidSize,
    askSize,
    lastPrice,
    markPrice,
    timestamp: Number.parseInt(String(payload?.ts || payload?.timestamp || Date.now()), 10) || Date.now(),
  }, 'ticker');
};

const ensureSocket = (tradingMode: TradingMode) => {
  const existing = subscriptions.get(tradingMode);
  if (existing && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) {
    return existing;
  }

  const ws = new WebSocket(PUBLIC_URLS[tradingMode]);
  const socketState = { ws, tradingMode, symbols: existing?.symbols || new Set<string>() };
  subscriptions.set(tradingMode, socketState);

  ws.on('open', () => {
    ws.send('ping');
    if (socketState.symbols.size > 0) {
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: Array.from(socketState.symbols).flatMap((symbol) => buildSubscribeArgs(symbol)),
      }));
    }
  });

  ws.on('message', (buffer) => {
    const raw = buffer.toString();
    if (raw === 'pong') {
      return;
    }

    try {
      const message = JSON.parse(raw);
      const arg = message?.arg;
      const data = Array.isArray(message?.data) ? message.data : [];
      if (!arg?.instId || !arg?.channel || data.length === 0) {
        return;
      }

      const symbol = String(arg.instId).toUpperCase();
      const channel = String(arg.channel).toLowerCase();

      if (channel === BOOKS_CHANNEL.toLowerCase()) {
        applyBooksUpdate(tradingMode, symbol, data[0] || {});
        return;
      }

      if (channel === TICKER_CHANNEL.toLowerCase()) {
        applyTickerUpdate(tradingMode, symbol, data[0] || {});
      }
    } catch {
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    setTimeout(() => ensureSocket(tradingMode), 2000);
  });

  ws.on('error', () => {
    clearInterval(heartbeat);
    try {
      ws.close();
    } catch {
      return;
    }
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('ping');
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();

  return socketState;
};

const subscribeSymbol = (symbol: string, tradingMode: TradingMode) => {
  const normalized = symbol.toUpperCase();
  const socketState = ensureSocket(tradingMode);
  if (socketState.symbols.has(normalized)) {
    return;
  }

  socketState.symbols.add(normalized);
  if (socketState.ws.readyState === WebSocket.OPEN) {
    socketState.ws.send(JSON.stringify({
      op: 'subscribe',
      args: buildSubscribeArgs(normalized),
    }));
  }
};

const removeSubscriber = (id: number) => {
  const subscriber = subscribers.get(id);
  if (!subscriber) {
    return;
  }

  subscribers.delete(id);
  try {
    subscriber.res.end();
  } catch {
    return;
  }
};

const parseSymbolsFilter = (raw: string | null) => {
  if (!raw) {
    return null;
  }

  const values = raw
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);

  return values.length > 0 ? new Set(values) : null;
};

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400).end('Missing URL');
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      booksChannel: BOOKS_CHANNEL,
      tickerChannel: TICKER_CHANNEL,
      snapshots: snapshots.size,
      subscribers: subscribers.size,
      modes: Array.from(subscriptions.keys()),
      staleMs: STALE_MS,
    }));
    return;
  }

  if (url.pathname === '/subscribe') {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
    const tradingMode = (url.searchParams.get('mode') || 'demo') === 'live' ? 'live' : 'demo';
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'symbol is required' }));
      return;
    }

    subscribeSymbol(symbol, tradingMode);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, symbol, tradingMode }));
    return;
  }

  if (url.pathname === '/snapshot') {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
    const tradingMode = (url.searchParams.get('mode') || 'demo') === 'live' ? 'live' : 'demo';
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'symbol is required' }));
      return;
    }

    subscribeSymbol(symbol, tradingMode);
    const snapshot = snapshots.get(makeKey(tradingMode, symbol));
    const isFresh = snapshot ? (Date.now() - snapshot.timestamp) <= STALE_MS : false;

    res.writeHead(snapshot && isFresh ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: Boolean(snapshot && isFresh),
      snapshot: snapshot || null,
      stale: snapshot ? !isFresh : true,
    }));
    return;
  }

  if (url.pathname === '/events') {
    const modeParam = url.searchParams.get('mode');
    const mode = modeParam === 'live' || modeParam === 'demo' ? modeParam : null;
    const symbols = parseSymbolsFilter(url.searchParams.get('symbols'));
    const subscriberId = nextSubscriberId++;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    subscribers.set(subscriberId, {
      id: subscriberId,
      mode,
      res,
      symbols,
    });

    writeSse(res, 'ready', {
      mode,
      symbols: symbols ? Array.from(symbols) : null,
      subscriberId,
    });

    req.on('close', () => {
      removeSubscriber(subscriberId);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, message: 'Not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`Bitget WS market data service running on http://${HOST}:${PORT}`);
});
