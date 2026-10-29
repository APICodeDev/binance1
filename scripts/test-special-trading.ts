import assert from 'node:assert/strict';
import axios from 'axios';
import { NextRequest } from 'next/server';

// Isolated repository: no .env loading, no production database and no private
// network calls. --public-market permits only Kraken public GET market data.
const publicMarket = process.argv.includes('--public-market');
process.env.KRAKEN_LIVE_TRADING_ENABLED = '0';
process.env.DATABASE_URL = '';
process.env.KRAKEN_FUTURES_API_URL_LIVE = 'https://futures.kraken.com';
process.env.KRAKEN_PAPER_TAKER_FEE = '0.0002';
for (const key of ['KRAKEN_LIVE_API_KEY', 'KRAKEN_LIVE_API_SECRET', 'KRAKEN_FUTURES_API_KEY', 'KRAKEN_FUTURES_API_SECRET']) delete process.env[key];
const settings = new Map<string, string>([['trading_mode', 'demo']]);
const positions: any[] = [];
const logs: any[] = [];
let nextId = 1;
let marketPrice = 50000;
let publicCalls = 0;
let failCommit = false;
const matches = (row: any, where: any = {}): boolean => Object.entries(where).every(([key, value]: any) =>
  value && typeof value === 'object' ? value.in?.includes(row[key]) : row[key] === value);
const uniqueError = () => Object.assign(new Error('duplicate key'), { code: 'P2002' });
const db: any = {
  setting: {
    findUnique: async ({ where }: any) => settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
    findMany: async ({ where }: any = {}) => Array.from(settings.entries()).map(([key, value]) => ({ key, value })).filter((row) => matches(row, where)),
    create: async ({ data }: any) => { if (settings.has(data.key)) throw uniqueError(); settings.set(data.key, data.value); return data; },
    upsert: async ({ where, create, update }: any) => { const value = settings.has(where.key) ? update.value : create.value; settings.set(where.key, value); return { key: where.key, value }; },
    updateMany: async ({ where, data }: any) => { if (settings.get(where.key) !== where.value) return { count: 0 }; settings.set(where.key, data.value); return { count: 1 }; },
    deleteMany: async ({ where }: any) => { let count = 0; for (const [key, value] of Array.from(settings.entries())) if (matches({ key, value }, where)) { settings.delete(key); count++; } return { count }; },
  },
  position: {
    findMany: async ({ where }: any = {}) => positions.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    findUnique: async ({ where }: any) => positions.find((row) => row.id === where.id) || null,
    findUniqueOrThrow: async ({ where }: any) => { const row = positions.find((p) => p.id === where.id); assert.ok(row); return row; },
    create: async ({ data }: any) => { const row = { id: nextId++, status: 'open', createdAt: new Date(), profitLossFiat: 0, profitLossPercent: 0, ...data }; positions.push(row); return { ...row }; },
    update: async ({ where, data }: any) => { const row = positions.find((p) => p.id === where.id); assert.ok(row); Object.assign(row, data); return { ...row }; },
    aggregate: async () => ({ _sum: { profitLossFiat: 0 } }),
  },
  auditLog: {
    create: async ({ data }: any) => { const log = { ...data, createdAt: new Date() }; logs.push(log); return log; },
    findMany: async ({ where }: any = {}) => logs.filter((row) => matches(row, where)),
  },
  apiToken: {
    findUnique: async () => ({ id: 'test', isActive: true, user: { id: 1, isActive: true, role: 'admin', email: 'test@example.invalid' } }),
    update: async () => ({}),
  },
  $transaction: async (run: any) => {
    if (failCommit) throw new Error('simulated database commit failure');
    const savedSettings = new Map(settings), savedPositions = structuredClone(positions), savedLogs = structuredClone(logs);
    try { return await run(db); }
    catch (error) { settings.clear(); savedSettings.forEach((v, k) => settings.set(k, v)); positions.splice(0, positions.length, ...savedPositions); logs.splice(0, logs.length, ...savedLogs); throw error; }
  },
};
(globalThis as any).prisma = db;
const originalAdapter = axios.getAdapter(axios.defaults.adapter);
axios.defaults.adapter = async (config) => {
  const url = new URL(config.url!);
  assert.equal(url.origin, 'https://futures.kraken.com');
  assert.equal(config.method, 'get');
  assert.equal(config.headers.get('APIKey'), undefined, 'Private credentials must never be sent');
  assert.ok(['/derivatives/api/v3/instruments', '/derivatives/api/v3/tickers'].includes(url.pathname), `Forbidden network request: ${url.pathname}`);
  publicCalls++;
  if (publicMarket) return originalAdapter(config);
  const data = url.pathname.endsWith('/instruments')
    ? { result: 'success', instruments: [{ symbol: 'PF_XBTUSD', type: 'flexible_futures', contractSize: 1, contractValueTradePrecision: 4, tickSize: 1, tradeable: true, maxPositionSize: 1200 }] }
    : { result: 'success', tickers: [{ symbol: 'PF_XBTUSD', last: marketPrice, bid: marketPrice - 1, ask: marketPrice + 1 }] };
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};

async function main() {
  const { POST } = await import('@/app/api/entry/route');
  const kraken = await import('@/lib/kraken');
  const protection = await import('@/lib/positions');
  const request = (data: any) => new NextRequest('http://localhost/api/entry', { method: 'POST', headers: { authorization: 'Bearer isolated-test', 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const base = { type: 'buy', symbol: 'BTCUSD', origin: 'API-IK-Grid', timeframe: '5', mode: 'special', amount: 1000 };
  const send = async (overrides: any = {}) => { const response = await POST(request({ ...base, ...overrides })); return { status: response.status, body: await response.json() }; };
  const orders = () => JSON.parse(settings.get('kraken_paper_orders') || '[]');
  const open = () => positions.find((position) => position.status === 'open');
  const positionsApi = await import('@/app/api/positions/route');
  const readPositions = async () => {
    const response = await positionsApi.GET(new NextRequest('http://localhost/api/positions?mode=demo', { headers: { authorization: 'Bearer isolated-test' } }));
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal(protection.normalizePositionManagementMode('SPECIAL'), 'special');
  assert.equal(protection.isBreakEvenEffectivelyEnabled({ managementMode: 'special', manualBreakEvenEnabled: true }), false);
  assert.equal(protection.isTrailingEffectivelyEnabled({ managementMode: 'special', manualTrailingOverride: true }), false);
  assert.equal(kraken.krakenOrderSuccess({ result: 'success', sendStatus: { status: 'insufficientAvailableFunds' } }), false);
  assert.equal(kraken.krakenNormalizeSizeByContract(0.02009, { sizeMultiplier: 0.0001, volumePlace: 4, minTradeNum: 0.0001 }), 0.02);
  assert.equal(kraken.krakenNormalizeSizeByContract(0.00001, { sizeMultiplier: 0.0001, volumePlace: 4 }), 0);
  assert.equal(kraken.krakenNormalizeSizeByContract(1900, { contractValueTradePrecision: -3 }), 1000);
  assert.equal(kraken.krakenNormalizeSizeByContract(999, { contractValueTradePrecision: -3 }), 0);
  assert.equal((await send({ amount: 0.000001 })).status, 400);
  assert.equal((await send({ type: 'hold' })).status, 400);
  assert.equal((await send({ symbol: 'PI_XBTUSD' })).status, 400);
  assert.equal(orders().length, 0);
  const first = await send({ signal_id: 'entry-1', symbol: 'KRAKEN:BTCUSD.P' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(open().quantity > 0 && open().quantity < 1);
  assert.equal(open().managementMode, 'special');
  assert.equal(open().stopLoss, 0);
  assert.equal(open().takeProfit, null);
  assert.equal((await send({ signal_id: 'entry-1' })).body.duplicate, true);
  assert.equal(orders().length, 1);
  assert.equal((await readPositions()).open[0].specialEntryCount, 1, 'Initial and duplicate signals must not show extra entries');
  assert.equal((await send({ origin: 'Another' })).status, 409);
  assert.equal((await send({ timeframe: '15' })).status, 409);
  assert.equal((await send({ mode: 'trend', type: 'close' })).status, 200);
  assert.equal(open().status, 'open');
  marketPrice = 48000;
  assert.equal((await send({ signal_id: 'entry-2', stoploss: 100, takeprofit: 90000, entryPrice: 1 })).status, 200);
  assert.equal((await readPositions()).open[0].specialEntryCount, 2, 'Second filled entry must display +1');
  marketPrice = 47000;
  const simultaneous = await Promise.all([3, 4, 5].map((i) => send({ signal_id: `entry-${i}` })));
  simultaneous.forEach((result) => assert.equal(result.status, 200, JSON.stringify(result.body)));
  assert.equal(positions.filter((p) => p.status === 'open').length, 1);
  assert.equal(orders().length, 5);
  assert.equal((await readPositions()).open[0].specialEntryCount, 5, 'Concurrent entries must display +4');
  const totalQuantity = orders().reduce((sum: number, o: any) => sum + o.filledSize, 0);
  const averagePrice = orders().reduce((sum: number, o: any) => sum + o.filledSize * o.averagePrice, 0) / totalQuantity;
  assert.ok(Math.abs(open().quantity - totalQuantity) < 1e-10);
  assert.ok(Math.abs(open().entryPrice - averagePrice) < 1e-8);
  assert.equal((await send({ signal_id: 'entry-6' })).status, 409);
  assert.equal(orders().length, 5);
  const controls = await import('@/app/api/positions/strat-controls/route');
  assert.equal((await controls.POST(request({ id: open().id, breakEvenEnabled: true }))).status, 409);
  assert.equal((await controls.POST(request({ id: open().id, timeoutHours: 3 }))).status, 200);
  assert.equal(open().timeoutHours, 3);
  const timeout = await import('@/lib/positionTimeout');
  const expired = { createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000), timeoutHours: 3 };
  assert.equal(timeout.shouldClosePositionForTimeout(expired, 10), false, 'Expired winners remain open');
  assert.equal(timeout.shouldClosePositionForTimeout(expired, -0.01), true, 'Expired losers close immediately');
  const monitor = await import('@/app/api/monitor/route');
  const monitored = await monitor.runMonitor(new NextRequest('http://localhost/api/monitor?mode=demo'), 1);
  assert.equal((await monitored.json()).data.snapshot.open[0].specialEntryCount, 5, 'Live polling must preserve the count after a rejected sixth entry');
  assert.equal(orders().length, 5, 'Monitor must not create protections or close special');
  settings.set('bot_enabled', '0');
  marketPrice = 51000;
  const close = await send({ type: 'close', signal_id: 'close-1' });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  assert.equal(open(), undefined);
  assert.equal(orders().length, 6);
  const closingOrder = orders()[5];
  assert.equal(closingOrder.side, 'sell');
  assert.equal(closingOrder.reduceOnly, true);
  assert.equal(closingOrder.size, totalQuantity);
  assert.ok(orders().every((o: any) => o.orderType === 'mkt' && !o.stopPrice && !o.limitPrice));
  assert.equal((await send({ type: 'close', signal_id: 'close-1' })).body.duplicate, true);
  assert.equal((await send({ signal_id: 'entry-7' })).body.message, 'Bot disabled');
  settings.set('bot_enabled', '1');
  assert.equal((await send({ signal_id: 'entry-7' })).status, 200);
  const reopened = await readPositions();
  assert.equal(reopened.open[0].specialEntryCount, 1, 'New position resets the counter');
  assert.equal(reopened.history[0].specialEntryCount, 5, 'Closed position keeps its own count after reopening the contract');
  const manual = await protection.closeTrackedPosition({ ...open() });
  assert.equal(manual.ok, true);
  assert.equal(open(), undefined);
  const shortEntry = await send({ type: 'sell', signal_id: 'short-entry' });
  assert.equal(shortEntry.status, 200, JSON.stringify(shortEntry.body));
  assert.equal(open().positionType, 'sell');
  const reversed = await send({ type: 'buy', signal_id: 'reverse-to-long' });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body));
  assert.equal(reversed.body.reversed, true);
  assert.equal(open().positionType, 'buy');
  assert.equal(positions.filter((p) => p.status === 'open').length, 1);
  assert.equal((await send({ type: 'close', signal_id: 'close-after-reverse' })).status, 200);
  assert.equal(open(), undefined);
  // A process/db failure after a simulated fill must never double the exposure.
  failCommit = true;
  const failed = await send({ signal_id: 'commit-failure' });
  assert.equal(failed.status, 500);
  failCommit = false;
  const before = orders().length;
  assert.equal((await send({ signal_id: 'commit-failure' })).status, 409);
  assert.equal(orders().length, before);
  assert.ok(settings.has('special_pending:demo:PF_XBTUSD'));
  assert.ok(!settings.has('entry_execution_lock'));
  // Exercise the live API shapes with an entirely local exchange fixture.
  // This adapter NEVER delegates private calls to a network adapter.
  const marketAdapter = axios.defaults.adapter as any;
  let net = 0, fillFraction = 1, reject = false, mockOrderId = 0;
  const mockFills: any[] = [];
  axios.defaults.adapter = async (config) => {
    const url = new URL(config.url!);
    if (['/derivatives/api/v3/instruments', '/derivatives/api/v3/tickers'].includes(url.pathname)) return marketAdapter(config);
    let data: any;
    if (url.pathname.endsWith('/openpositions')) data = { result: 'success', openPositions: net ? [{ symbol: 'PF_XBTUSD', size: net, side: 'long', price: marketPrice }] : [] };
    else if (url.pathname.endsWith('/openorders')) data = { result: 'success', openOrders: [] };
    else if (url.pathname.endsWith('/fills')) data = { result: 'success', fills: mockFills };
    else if (url.pathname.endsWith('/sendorder')) {
      assert.equal(config.method, 'post');
      assert.equal(url.searchParams.get('orderType'), 'mkt');
      const size = Number(url.searchParams.get('size'));
      if (reject) data = { result: 'success', sendStatus: { status: 'insufficientAvailableFunds' } };
      else {
        const closing = url.searchParams.get('side') === 'sell';
        if (closing) assert.equal(url.searchParams.get('reduceOnly'), 'true');
        const filled = Number((size * fillFraction).toFixed(8));
        net += closing ? -filled : filled;
        const orderId = `fixture-${++mockOrderId}`;
        mockFills.push({ order_id: orderId, size: filled, price: marketPrice });
        data = { result: 'success', sendStatus: { status: 'placed', order_id: orderId } };
      }
    } else throw new Error(`Unexpected mocked private endpoint ${url.pathname}`);
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  process.env.KRAKEN_LIVE_TRADING_ENABLED = '1';
  process.env.KRAKEN_LIVE_API_KEY = 'fixture-not-a-real-key';
  process.env.KRAKEN_LIVE_API_SECRET = Buffer.from('fixture-not-a-real-secret').toString('base64');
  settings.set('trading_mode', 'live');
  fillFraction = 0.5;
  assert.equal((await send({ signal_id: 'mock-partial-buy' })).status, 200);
  const livePosition = positions.find((p) => p.tradingMode === 'live');
  const originalLiveQuantity = livePosition.quantity;
  assert.equal(livePosition.quantity, net, 'Only actual filled size is booked');
  reject = true;
  assert.equal((await send({ signal_id: 'mock-reject' })).status, 502);
  assert.equal(livePosition.quantity, net);
  assert.ok(!settings.has('special_pending:live:PF_XBTUSD'), 'Explicit rejection releases intent');
  reject = false;
  assert.equal((await send({ type: 'close', signal_id: 'mock-close' })).status, 409);
  assert.equal(livePosition.status, 'open');
  assert.equal(livePosition.quantity, net);
  assert.equal((await send({ signal_id: 'buy-during-close' })).status, 409);
  fillFraction = 1;
  marketPrice += 100;
  assert.equal((await send({ type: 'close', signal_id: 'mock-close' })).status, 200);
  assert.ok(Math.abs(net) < 1e-10);
  assert.equal(livePosition.status, 'closed');
  assert.equal(livePosition.quantity, originalLiveQuantity);
  assert.ok(Math.abs(livePosition.exitPrice - (marketPrice - 50)) < 1e-8, 'History uses the weighted price of all partial exits');
  process.env.KRAKEN_LIVE_TRADING_ENABLED = '0';
  console.log('Local Kraken response fixtures: partial buy, explicit rejection, partial close, residual close PASS');
  console.log(JSON.stringify({ result: 'PASS', publicMarket, publicCalls, simulatedOrders: orders().length, privateNetworkCalls: 0, database: 'isolated in-memory', scenarios: ['entry HTTP route', 'five entries', 'concurrent buys', 'weighted average', 'duplicate signal', 'sixth rejected', 'minimum size', 'origin/timeframe isolation', 'no SL/TP protections', 'individual timeout', 'winner timeout hold', 'loser timeout close', 'close while bot disabled', 'reduce-only full close', 'long/short reversal', 'manual close', 'crash blocks resubmission'] }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
