import http from 'http';
import WebSocket from 'ws';

type TradingMode = 'demo' | 'live';

type OrderBookSnapshot = {
  symbol: string;
  tradingMode: TradingMode;
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  timestamp: number;
  source: 'websocket';
};

const PORT = Number.parseInt(process.env.BITGET_WS_SERVICE_PORT || '8787', 10);
const HOST = process.env.BITGET_WS_SERVICE_HOST || '127.0.0.1';
const STALE_MS = Number.parseInt(process.env.BITGET_WS_STALE_MS || '5000', 10);
const CHANNEL = process.env.BITGET_WS_CHANNEL || 'books1';
const PING_INTERVAL_MS = 25000;
const PUBLIC_URLS: Record<TradingMode, string> = {
  demo: 'wss://wspap.bitget.com/v2/ws/public',
  live: 'wss://ws.bitget.com/v2/ws/public',
};

const snapshots = new Map<string, OrderBookSnapshot>();
const subscriptions = new Map<string, { ws: WebSocket; tradingMode: TradingMode; symbols: Set<string> }>();

const makeKey = (tradingMode: TradingMode, symbol: string) => `${tradingMode}:${symbol.toUpperCase()}`;

const getProductType = (symbol: string) => {
  if (symbol.endsWith('USDC')) return 'USDC-FUTURES';
  if (symbol.endsWith('USD')) return 'COIN-FUTURES';
  return 'USDT-FUTURES';
};

const parseLevels = (value: unknown) => {
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

const upsertSnapshot = (tradingMode: TradingMode, symbol: string, bids: unknown[], asks: unknown[], ts?: unknown) => {
  const bestBid = parseLevels(bids?.[0]);
  const bestAsk = parseLevels(asks?.[0]);
  if (!bestBid || !bestAsk) {
    return;
  }

  snapshots.set(makeKey(tradingMode, symbol), {
    symbol,
    tradingMode,
    bestBid: bestBid.price,
    bestAsk: bestAsk.price,
    bidSize: bestBid.size,
    askSize: bestAsk.size,
    timestamp: Number.parseInt(String(ts || Date.now()), 10) || Date.now(),
    source: 'websocket',
  });
};

const ensureSocket = (tradingMode: TradingMode) => {
  const existing = subscriptions.get(tradingMode);
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
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
        args: Array.from(socketState.symbols).map((symbol) => ({
          instType: getProductType(symbol),
          channel: CHANNEL,
          instId: symbol,
        })),
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
      if (!arg?.instId || data.length === 0) {
        return;
      }

      const symbol = String(arg.instId).toUpperCase();
      const payload = data[0] || {};
      upsertSnapshot(tradingMode, symbol, payload.bids || [], payload.asks || [], payload.ts || payload.timestamp);
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
      args: [{
        instType: getProductType(normalized),
        channel: CHANNEL,
        instId: normalized,
      }],
    }));
  }
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
      channel: CHANNEL,
      snapshots: snapshots.size,
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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, message: 'Not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`Bitget WS market data service running on http://${HOST}:${PORT}`);
});
