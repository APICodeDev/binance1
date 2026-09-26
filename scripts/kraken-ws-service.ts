import http, { ServerResponse } from 'http';
import WebSocket from 'ws';

type TradingMode = 'demo' | 'live';
type Snapshot = { symbol: string; tradingMode: TradingMode; bestBid: number | null; bestAsk: number | null; bidSize: number | null; askSize: number | null; lastPrice: number | null; markPrice: number | null; timestamp: number; source: 'websocket' };
type Subscriber = { mode: TradingMode | null; symbols: Set<string> | null; res: ServerResponse };

const PORT = Number.parseInt(process.env.KRAKEN_WS_SERVICE_PORT || '8787', 10);
const HOST = process.env.KRAKEN_WS_SERVICE_HOST || '127.0.0.1';
const STALE_MS = Number.parseInt(process.env.KRAKEN_WS_STALE_MS || '5000', 10);
const DEBUG = process.env.KRAKEN_WS_DEBUG === '1';
// Kraken's derivatives demo host was retired. Paper mode consumes the same
// public market-data feed as live; only private order execution is simulated.
const PUBLIC_WS_URL = process.env.KRAKEN_PAPER_MARKET_WS_URL || 'wss://futures.kraken.com/ws/v1';
const URLS: Record<TradingMode, string> = { demo: PUBLIC_WS_URL, live: PUBLIC_WS_URL };
const snapshots = new Map<string, Snapshot>();
const sockets = new Map<TradingMode, { ws: WebSocket; symbols: Set<string> }>();
const subscribers = new Map<number, Subscriber>();
let nextSubscriberId = 1;

const appSymbol = (raw: string) => { const value = raw.toUpperCase().replace(/[\/-]/g, ''); if (/^(PF|PI|FF)_/.test(value)) return value; const base = value.replace(/USDT$|USDC$|USD$/, '').replace(/^BTC$/, 'XBT'); return `PF_${base}USD`; };
const key = (mode: TradingMode, symbol: string) => `${mode}:${symbol}`;
const number = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const level = (value: any) => Array.isArray(value) ? { price: number(value[0]), size: number(value[1]) } : { price: number(value?.price), size: number(value?.qty ?? value?.size) };
const bestLevel = (values: unknown, side: 'bid' | 'ask') => {
  const levels = Array.isArray(values) ? values.map(level).filter((item) => item.price !== null) : [];
  levels.sort((left, right) => side === 'bid' ? (right.price as number) - (left.price as number) : (left.price as number) - (right.price as number));
  return levels[0] || { price: null, size: null };
};
const emit = (res: ServerResponse, event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
const broadcast = (snapshot: Snapshot) => { for (const subscriber of Array.from(subscribers.values())) { if (subscriber.mode && subscriber.mode !== snapshot.tradingMode) continue; if (subscriber.symbols && !subscriber.symbols.has(snapshot.symbol)) continue; emit(subscriber.res, 'market', { channel: 'kraken', snapshot }); } };
const update = (mode: TradingMode, symbol: string, patch: Partial<Snapshot>) => { const previous = snapshots.get(key(mode, symbol)); const next = { symbol, tradingMode: mode, bestBid: patch.bestBid ?? previous?.bestBid ?? null, bestAsk: patch.bestAsk ?? previous?.bestAsk ?? null, bidSize: patch.bidSize ?? previous?.bidSize ?? null, askSize: patch.askSize ?? previous?.askSize ?? null, lastPrice: patch.lastPrice ?? previous?.lastPrice ?? null, markPrice: patch.markPrice ?? previous?.markPrice ?? null, timestamp: patch.timestamp ?? previous?.timestamp ?? Date.now(), source: 'websocket' as const }; if (next.lastPrice === null && next.bestBid !== null && next.bestAsk !== null) next.lastPrice = (next.bestBid + next.bestAsk) / 2; snapshots.set(key(mode, symbol), next); broadcast(next); };

const subscribe = (ws: WebSocket, symbols: Set<string>) => { if (DEBUG) console.log('subscribe', Array.from(symbols)); for (const feed of ['book', 'ticker']) ws.send(JSON.stringify({ event: 'subscribe', feed, product_ids: Array.from(symbols) })); };
const ensureSocket = (mode: TradingMode) => { const current = sockets.get(mode); if (current && (current.ws.readyState === WebSocket.OPEN || current.ws.readyState === WebSocket.CONNECTING)) return current; const ws = new WebSocket(URLS[mode]); const state = { ws, symbols: current?.symbols || new Set<string>() }; sockets.set(mode, state); ws.on('open', () => subscribe(ws, state.symbols)); ws.on('message', (buffer) => { try { const message = JSON.parse(buffer.toString()); if (DEBUG && message.feed !== 'book') console.log('message', message); const symbol = String(message.product_id || message.product_ids?.[0] || '').toUpperCase(); if (!symbol) return; const data = message.data || message; const bid = bestLevel(data.bids, 'bid'); const ask = bestLevel(data.asks, 'ask'); const patch = { bestBid: number(data.bid) ?? bid.price, bestAsk: number(data.ask) ?? ask.price, bidSize: number(data.bid_size) ?? bid.size, askSize: number(data.ask_size) ?? ask.size, lastPrice: number(data.last ?? data.last_price), markPrice: number(data.markPrice ?? data.mark_price), timestamp: number(data.timestamp ?? data.ts) || Date.now() }; if (DEBUG && message.feed === 'ticker') console.log('computed', symbol, patch); update(mode, symbol, patch); } catch (error) { if (DEBUG) console.error('message parse error', error); } }); ws.on('close', () => setTimeout(() => ensureSocket(mode), 2000)); ws.on('error', (error) => { if (DEBUG) console.error('socket error', error); try { ws.close(); } catch { /* already closed */ } }); return state; };
const subscribeSymbol = (symbol: string, mode: TradingMode) => { const native = appSymbol(symbol); const state = ensureSocket(mode); if (state.symbols.has(native)) return native; state.symbols.add(native); if (state.ws.readyState === WebSocket.OPEN) subscribe(state.ws, new Set([native])); return native; };
const symbolsFilter = (value: string | null) => value ? new Set(value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)) : null;

const server = http.createServer((req, res) => { if (!req.url) return res.writeHead(400).end('Missing URL'); const url = new URL(req.url, `http://${HOST}:${PORT}`); const mode: TradingMode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo'; const rawSymbol = String(url.searchParams.get('symbol') || '').toUpperCase(); if (url.pathname === '/health') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, snapshots: snapshots.size, subscribers: subscribers.size })); if (url.pathname === '/subscribe' || url.pathname === '/snapshot') { if (!rawSymbol) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, message: 'symbol is required' })); const native = subscribeSymbol(rawSymbol, mode); const snapshot = snapshots.get(key(mode, native)); const fresh = Boolean(snapshot && Date.now() - snapshot.timestamp <= STALE_MS); if (url.pathname === '/subscribe') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, symbol: native, tradingMode: mode })); return res.writeHead(fresh ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: fresh, snapshot: snapshot || null, stale: !fresh })); } if (url.pathname === '/events') { const id = nextSubscriberId++; const subscriber = { mode: url.searchParams.get('mode') === 'live' ? 'live' as const : url.searchParams.get('mode') === 'demo' ? 'demo' as const : null, symbols: symbolsFilter(url.searchParams.get('symbols')), res }; res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write(': connected\n\n'); subscribers.set(id, subscriber); emit(res, 'ready', { subscriberId: id }); req.on('close', () => { subscribers.delete(id); try { res.end(); } catch { /* ignored */ } }); return; } res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, message: 'Not found' })); });
server.listen(PORT, HOST, () => console.log(`Kraken WS market data service running on http://${HOST}:${PORT}`));
