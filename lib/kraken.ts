import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '@/lib/db';

type TradingMode = 'demo' | 'live';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const LIVE_URL = (process.env.KRAKEN_FUTURES_API_URL_LIVE || process.env.KRAKEN_API_URL_REAL || 'https://futures.kraken.com').replace(/\/$/, '');
// Kraken retired the old derivatives demo host in July 2026. Paper mode is
// therefore app-local and uses Kraken's live public market-data endpoints.
const PAPER_MARKET_URL = LIVE_URL;
const WS_SERVICE_URL = (process.env.KRAKEN_WS_SERVICE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const PROTECTION_VERIFY_DELAYS_MS = [300, 600, 1200, 1500, 2000];
const DEFAULT_PAPER_FEE = 0.0002;
const DEFAULT_LIVE_FEE = 0.0004;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const credentialsFor = (mode: TradingMode) => ({
  apiKey: mode === 'live'
    ? process.env.KRAKEN_LIVE_API_KEY || process.env.KRAKEN_FUTURES_API_KEY || ''
    : '',
  secret: mode === 'live'
    ? process.env.KRAKEN_LIVE_API_SECRET || process.env.KRAKEN_FUTURES_API_SECRET || ''
    : '',
});

const parseFeeRate = (value: unknown) => {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const getDefaultKrakenFeeRate = (tradingMode: TradingMode) => tradingMode === 'live' ? DEFAULT_LIVE_FEE : DEFAULT_PAPER_FEE;

const getConfiguredFee = (mode: TradingMode, side: 'maker' | 'taker') => {
  const prefix = mode === 'live' ? 'KRAKEN_LIVE' : 'KRAKEN_PAPER';
  const candidates = [process.env[`${prefix}_${side.toUpperCase()}_FEE`], process.env[`KRAKEN_${side.toUpperCase()}_FEE`]];
  for (const candidate of candidates) {
    const fee = parseFeeRate(candidate);
    if (fee !== null) return fee;
  }
  return getDefaultKrakenFeeRate(mode);
};

const encodeParams = (params: Record<string, any>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(key, String(item)));
    else search.append(key, typeof value === 'boolean' ? String(value) : String(value));
  }
  return search.toString();
};

/** Kraken Futures v3 Authent: base64(HMAC-SHA512(base64decode(secret), SHA256(postData+nonce+path))). */
export const createKrakenFuturesSignature = (path: string, postData: string, nonce: string, secret: string) => {
  const signaturePath = path.startsWith('/derivatives') ? path.replace(/^\/derivatives/, '') : path;
  const digest = crypto.createHash('sha256').update(`${postData}${nonce}${signaturePath}`).digest();
  return crypto.createHmac('sha512', Buffer.from(secret, 'base64')).update(digest).digest('base64');
};

const enrichResponse = (payload: any) => {
  if (typeof payload === 'string') return { result: 'error', error: 'Kraken devolvio una respuesta no JSON o una redireccion inesperada' };
  if (!payload || typeof payload !== 'object') return { result: 'error', error: 'Invalid Kraken response' };
  if (payload.result !== 'success') return payload;
  const order = payload.sendStatus?.orderEvents?.find((event: any) => event?.order)?.order || payload.sendStatus?.order;
  const orderId = payload.sendStatus?.order_id || order?.orderId || payload.cancelStatus?.order_id;
  return {
    ...payload,
    code: '00000',
    msg: 'success',
    data: orderId ? { orderId, orderIdStr: orderId, ...(order || {}) } : (payload.data ?? payload),
    orderId,
    avgPrice: order?.averagePrice || order?.price || order?.limitPrice || undefined,
  };
};

const krakenRequest = async (endpoint: string, params: Record<string, any> = {}, method: HttpMethod = 'GET', signed = false, tradingMode: TradingMode = 'demo') => {
  const { apiKey, secret } = credentialsFor(tradingMode);
  const postData = encodeParams(params);
  const nonce = Date.now().toString();
  if (signed && tradingMode === 'demo') {
    return { result: 'error', error: 'Paper mode never calls private Kraken endpoints' };
  }
  const baseUrl = tradingMode === 'live' ? LIVE_URL : PAPER_MARKET_URL;
  const url = postData ? `${baseUrl}${endpoint}?${postData}` : `${baseUrl}${endpoint}`;
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (signed) {
    if (!apiKey || !secret) return { result: 'error', error: `Missing Kraken ${tradingMode} API credentials` };
    headers.APIKey = apiKey;
    headers.Authent = createKrakenFuturesSignature(endpoint, postData, nonce, secret);
    headers.Nonce = nonce;
  }

  try {
    const response = await axios({ method, url, headers, timeout: 15000, maxRedirects: 0 });
    return enrichResponse(response.data);
  } catch (error: any) {
    const responseData = error?.response?.data;
    const detail = typeof responseData === 'string'
      ? { result: 'error', error: `Kraken HTTP ${error?.response?.status || 0}: non-JSON response or redirect` }
      : responseData || { result: 'error', error: error?.message || 'Kraken request failed' };
    console.error(`Kraken API Error (${tradingMode}): ${method} ${endpoint}`, detail);
    return enrichResponse(detail);
  }
};

const baseFromAppSymbol = (symbol: string) => {
  const raw = String(symbol || '').toUpperCase().replace(/[\/-]/g, '');
  if (/^(PF|PI|FF)_/.test(raw)) {
    const match = raw.match(/^[A-Z]+_([A-Z0-9]+?)(?:USD|USDT|USDC)(?:_.+)?$/);
    return (match?.[1] || raw.replace(/^[A-Z]+_/, '').replace(/USD.*$/, '')).replace(/^XBT$/, 'BTC');
  }
  return raw.replace(/USDT$|USDC$|USD$/, '').replace(/^XBT$/, 'BTC');
};

const toKrakenContractSymbol = (symbol: string) => {
  const raw = String(symbol || '').toUpperCase().replace(/[\/-]/g, '');
  if (/^(PF|PI|FF)_/.test(raw)) return raw;
  return `PF_${baseFromAppSymbol(raw).replace(/^BTC$/, 'XBT')}USD`;
};

export const krakenNormalizeSymbol = (symbol: string): string => {
  const base = baseFromAppSymbol(symbol);
  return base ? `${base}USDT` : '';
};

export type KrakenPositionMode = 'one_way_mode' | 'hedge_mode';
export type KrakenProtectionKind = 'stop' | 'take_profit';

export const krakenBuildPositionContext = (positionType: 'buy' | 'sell', _positionMode: KrakenPositionMode) => ({
  openSide: (positionType === 'buy' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
  closeSide: (positionType === 'buy' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
  holdSide: (positionType === 'buy' ? 'long' : 'short') as 'long' | 'short',
  leverageHoldSide: (positionType === 'buy' ? 'long' : 'short') as 'long' | 'short',
  openTradeSide: undefined,
  closeTradeSide: undefined,
  flashCloseHoldSide: (positionType === 'buy' ? 'long' : 'short') as 'long' | 'short',
});

export const krakenOrderSuccess = (resp: any) => Boolean(resp && typeof resp === 'object' && (resp.result === 'success' || resp.code === '00000'));

const getTicker = async (symbol: string, mode: TradingMode) => {
  const resp = await krakenRequest('/derivatives/api/v3/tickers', {}, 'GET', false, mode);
  return resp?.tickers?.find((ticker: any) => ticker.symbol === toKrakenContractSymbol(symbol)) || null;
};

export const krakenGetPrice = async (symbol: string, tradingMode: TradingMode = 'demo'): Promise<number | false> => {
  const ticker = await getTicker(symbol, tradingMode);
  const price = Number(ticker?.last ?? ticker?.markPrice);
  return Number.isFinite(price) && price > 0 ? price : false;
};

type PaperOrder = {
  orderId: string;
  clientOid?: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderType: string;
  size: number;
  filledSize: number;
  limitPrice?: number;
  stopPrice?: number;
  triggerSignal?: string;
  rangeRate?: number;
  reduceOnly?: boolean;
  status: 'open' | 'filled' | 'cancelled';
  averagePrice?: number;
  createdAt: string;
  updatedAt: string;
};

const PAPER_ORDERS_SETTING_KEY = 'kraken_paper_orders';
const PAPER_BALANCE_SETTING_KEY = 'kraken_paper_balance_usd';

const readPaperOrders = async (): Promise<PaperOrder[]> => {
  const setting = await prisma.setting.findUnique({ where: { key: PAPER_ORDERS_SETTING_KEY } });
  if (!setting?.value) return [];
  try {
    const parsed = JSON.parse(setting.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writePaperOrders = async (orders: PaperOrder[]) => {
  await prisma.setting.upsert({
    where: { key: PAPER_ORDERS_SETTING_KEY },
    update: { value: JSON.stringify(orders.slice(-500)) },
    create: { key: PAPER_ORDERS_SETTING_KEY, value: JSON.stringify(orders.slice(-500)) },
  });
};

const planTypeForOrderType = (orderType: unknown) => {
  const normalized = String(orderType || '').toLowerCase();
  if (normalized === 'stp' || normalized === 'stop') return 'normal_plan';
  if (normalized === 'take_profit') return 'profit_plan';
  return 'normal';
};

const paperOrderResponse = (order: PaperOrder) => ({
  result: 'success',
  code: '00000',
  msg: 'paper order simulated with Kraken public market data',
  data: {
    orderId: order.orderId,
    orderIdStr: order.orderId,
    order_id: order.orderId,
    symbol: order.symbol,
    side: order.side,
    orderType: order.orderType,
    planType: planTypeForOrderType(order.orderType),
    triggerPrice: order.stopPrice,
    size: order.size,
    filledQty: order.filledSize,
    baseVolume: order.filledSize,
    priceAvg: order.averagePrice,
    avgPrice: order.averagePrice,
    state: order.status,
    status: order.status,
    stopPrice: order.stopPrice,
    limitPrice: order.limitPrice,
    reduceOnly: order.reduceOnly,
    rangeRate: undefined,
  },
  orderId: order.orderId,
});

const paperOrderFromParams = async (params: Record<string, any>): Promise<PaperOrder> => {
  const nativeSymbol = String(params.symbol || '');
  const orderType = String(params.orderType || 'mkt');
  const size = Number(params.size || 0);
  const marketPrice = await getTicker(nativeSymbol, 'demo');
  const bid = Number(marketPrice?.bid || marketPrice?.bidPrice || marketPrice?.last || marketPrice?.markPrice);
  const ask = Number(marketPrice?.ask || marketPrice?.askPrice || marketPrice?.last || marketPrice?.markPrice);
  const side = String(params.side || 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy';
  const isTrigger = ['stp', 'take_profit', 'trailing_stop'].includes(orderType);
  const fillPrice = orderType === 'mkt' || orderType === 'ioc'
    ? (side === 'buy' ? ask : bid)
    : Number(params.limitPrice || params.stopPrice || (side === 'buy' ? ask : bid));
  const now = new Date().toISOString();
  const order: PaperOrder = {
    orderId: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    clientOid: params.cliOrdId,
    symbol: nativeSymbol,
    side,
    orderType,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    filledSize: isTrigger ? 0 : (Number.isFinite(size) && size > 0 ? size : 0),
    limitPrice: Number.isFinite(Number(params.limitPrice)) ? Number(params.limitPrice) : undefined,
    stopPrice: Number.isFinite(Number(params.stopPrice)) ? Number(params.stopPrice) : undefined,
    triggerSignal: params.triggerSignal,
    rangeRate: Number.isFinite(Number(params.trailingStopMaxDeviation)) ? Number(params.trailingStopMaxDeviation) : undefined,
    reduceOnly: Boolean(params.reduceOnly),
    status: isTrigger ? 'open' : 'filled',
    averagePrice: Number.isFinite(fillPrice) && fillPrice > 0 ? fillPrice : undefined,
    createdAt: now,
    updatedAt: now,
  };
  const orders = await readPaperOrders();
  orders.push(order);
  await writePaperOrders(orders);
  return order;
};

const sendOrder = async (params: Record<string, any>, mode: TradingMode) => {
  if (mode === 'demo') return paperOrderResponse(await paperOrderFromParams(params));
  if (process.env.KRAKEN_LIVE_TRADING_ENABLED !== '1') {
    return { result: 'error', error: 'Live trading is disabled. Set KRAKEN_LIVE_TRADING_ENABLED=1 explicitly.' };
  }
  return krakenRequest('/derivatives/api/v3/sendorder', params, 'POST', true, mode);
};

export const krakenPlaceMarketOrder = async (symbol: string, side: 'BUY' | 'SELL', quantity: number, tradingMode: TradingMode = 'demo', _tradeSide?: 'open' | 'close') =>
  sendOrder({ orderType: 'mkt', symbol: toKrakenContractSymbol(symbol), side: side.toLowerCase(), size: quantity }, tradingMode);

export const krakenSetLeverage = async (symbol: string, leverage: number, _holdSide?: 'long' | 'short', tradingMode: TradingMode = 'demo') => ({ result: 'success', code: '00000', msg: 'Kraken Futures leverage is account-configured', data: { symbol: toKrakenContractSymbol(symbol), leverage }, tradingMode });
export const krakenGetPositionMode = async (_symbol: string, _tradingMode: TradingMode = 'demo'): Promise<KrakenPositionMode> => 'one_way_mode';
export const krakenSetPositionMode = async (_symbol: string, posMode: KrakenPositionMode, _tradingMode: TradingMode = 'demo') => ({ result: 'success', code: '00000', msg: `Kraken Futures uses net positions (${posMode} requested)` });

type KrakenPositionSnapshot = {
  ok: boolean;
  positions: Array<{ symbol: string; positionAmt: string | number; entryPrice: string | number; unRealizedProfit: string | number; leverage: string | number; positionSide: 'LONG' | 'SHORT' | 'BOTH' }>;
  errors: string[];
};

const mapPosition = (position: any) => ({
  symbol: krakenNormalizeSymbol(position?.symbol || ''),
  positionAmt: Number(position?.size || 0) * (String(position?.side || '').toLowerCase() === 'short' ? -1 : 1),
  entryPrice: position?.price ?? 0,
  unRealizedProfit: position?.unrealizedPnl ?? 0,
  leverage: position?.maxFixedLeverage ?? 1,
  positionSide: String(position?.side || '').toLowerCase() === 'short' ? 'SHORT' as const : 'LONG' as const,
});

export const krakenGetPositions = async (tradingMode: TradingMode = 'demo'): Promise<KrakenPositionSnapshot> => {
  if (tradingMode === 'demo') {
    const positions = await prisma.position.findMany({ where: { tradingMode: 'demo', status: 'open' } });
    return {
      ok: true,
      positions: positions.map((position) => ({
        symbol: krakenNormalizeSymbol(position.symbol),
        positionAmt: position.positionType === 'sell' ? -Math.abs(position.quantity) : Math.abs(position.quantity),
        entryPrice: position.entryPrice,
        unRealizedProfit: 0,
        leverage: 1,
        positionSide: position.positionType === 'sell' ? 'SHORT' as const : 'LONG' as const,
      })),
      errors: [],
    };
  }
  const resp = await krakenRequest('/derivatives/api/v3/openpositions', {}, 'GET', true, tradingMode);
  if (!krakenOrderSuccess(resp)) return { ok: false, positions: [], errors: [resp?.error || resp?.message || 'Kraken positions unavailable'] };
  return { ok: true, positions: Array.isArray(resp.openPositions) ? resp.openPositions.map(mapPosition) : [], errors: [] };
};

export const krakenGetSinglePosition = async (symbol: string, tradingMode: TradingMode = 'demo') => {
  const all = await krakenGetPositions(tradingMode);
  const canonical = krakenNormalizeSymbol(symbol);
  return { ...all, positions: all.positions.filter((position) => position.symbol === canonical) };
};

const decimalPlaces = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return 4;
  return Math.max(0, (value.toFixed(12).replace(/0+$/, '').split('.')[1] || '').length);
};
let instrumentsCache: { expires: number; instruments: any[] } | null = null;
const getInstruments = async (mode: TradingMode) => {
  if (instrumentsCache && instrumentsCache.expires > Date.now()) return instrumentsCache.instruments;
  const resp = await krakenRequest('/derivatives/api/v3/instruments', {}, 'GET', false, mode);
  if (!Array.isArray(resp?.instruments)) return [];
  instrumentsCache = { expires: Date.now() + 30_000, instruments: resp.instruments };
  return resp.instruments;
};

export const krakenGetExchangeInfo = async (symbol: string, tradingMode: TradingMode = 'demo') => {
  const native = toKrakenContractSymbol(symbol);
  const instrument = (await getInstruments(tradingMode)).find((item: any) => item.symbol === native);
  if (!instrument) return null;
  const tickSize = Number(instrument.tickSize) || 0.0001;
  const contractSize = Number(instrument.contractSize) || 1;
  return { ...instrument, symbol: krakenNormalizeSymbol(symbol), krakenSymbol: native, pricePlace: decimalPlaces(tickSize), priceEndStep: Math.max(1, Math.round(tickSize * 10 ** decimalPlaces(tickSize))), tickSize, minTradeNum: contractSize, sizeMultiplier: contractSize, volumePlace: Math.max(0, Number(instrument.contractValueTradePrecision ?? 0)), minLever: 1, maxLever: 50 };
};
export const krakenGetPricePrecision = async (symbol: string, mode: TradingMode = 'demo') => Number((await krakenGetExchangeInfo(symbol, mode))?.pricePlace || 4);
export const krakenGetTickSize = (exchangeInfo: any) => Number(exchangeInfo?.tickSize) || Number(exchangeInfo?.priceEndStep || 1) / 10 ** Number(exchangeInfo?.pricePlace || 4);
export const krakenNormalizePriceByContractDirectional = (price: number, exchangeInfo: any, direction: 'down' | 'up' = 'down') => {
  const tick = krakenGetTickSize(exchangeInfo);
  const places = Number(exchangeInfo?.pricePlace ?? decimalPlaces(tick));
  const units = price / tick;
  return Number(((direction === 'up' ? Math.ceil(units - 1e-12) : Math.floor(units + 1e-12)) * tick).toFixed(places));
};
export const krakenNormalizePriceByContract = (price: number, exchangeInfo: any) => krakenNormalizePriceByContractDirectional(price, exchangeInfo, 'down');
export const krakenNormalizeProtectionPrice = (price: number, exchangeInfo: any, positionType: 'buy' | 'sell', kind: KrakenProtectionKind) => krakenNormalizePriceByContractDirectional(price, exchangeInfo, kind === 'stop' ? (positionType === 'buy' ? 'down' : 'up') : (positionType === 'buy' ? 'up' : 'down'));
export const krakenNormalizeSizeByContract = (size: number, exchangeInfo: any) => {
  const step = Number(exchangeInfo?.contractSize || exchangeInfo?.sizeMultiplier || 1) || 1;
  const min = Number(exchangeInfo?.minTradeNum || step) || step;
  return Number(Math.max(min, Math.floor(size / step) * step).toFixed(Number(exchangeInfo?.volumePlace || 6)));
};
export const formatQuantity = (quantity: number, exchangeInfo: any) => krakenNormalizeSizeByContract(quantity, exchangeInfo).toString();

const orderSide = (side: 'BUY' | 'SELL') => side.toLowerCase();
const triggerSignal = (_value?: string) => 'mark';
export const krakenPlaceStopMarket = async (symbol: string, side: 'BUY' | 'SELL', stopPrice: number, quantity?: number, tradingMode: TradingMode = 'demo', _tradeSide?: 'open' | 'close', _positionType?: 'buy' | 'sell') => {
  const info = await krakenGetExchangeInfo(symbol, tradingMode);
  const precision = Number(info?.pricePlace || 4);
  const price = info ? krakenNormalizePriceByContractDirectional(stopPrice, info, side === 'SELL' ? 'up' : 'down') : stopPrice;
  return sendOrder({ orderType: 'stp', symbol: toKrakenContractSymbol(symbol), side: orderSide(side), size: quantity || 0, stopPrice: price.toFixed(precision), triggerSignal: triggerSignal(), reduceOnly: true }, tradingMode);
};
export const krakenPlaceTpslMarket = async (symbol: string, planType: 'profit_plan' | 'loss_plan', holdSide: 'long' | 'short' | 'buy' | 'sell', triggerPrice: number, quantity: number, clientOid?: string, tradingMode: TradingMode = 'demo') => {
  const info = await krakenGetExchangeInfo(symbol, tradingMode);
  const positionType = holdSide === 'long' || holdSide === 'buy' ? 'buy' : 'sell';
  const price = info ? krakenNormalizeProtectionPrice(triggerPrice, info, positionType, planType === 'profit_plan' ? 'take_profit' : 'stop') : triggerPrice;
  return sendOrder({ orderType: planType === 'loss_plan' ? 'stp' : 'take_profit', symbol: toKrakenContractSymbol(symbol), side: positionType === 'buy' ? 'sell' : 'buy', size: quantity, stopPrice: price, triggerSignal: triggerSignal(), reduceOnly: true, cliOrdId: clientOid }, tradingMode);
};
export const krakenPlaceTrailingStop = async (symbol: string, holdSide: 'long' | 'short' | 'buy' | 'sell', _triggerPrice: number, quantity: number, callbackPercent: number, triggerType: 'fill_price' | 'mark_price' = 'mark_price', clientOid?: string, tradingMode: TradingMode = 'demo') =>
  sendOrder({ orderType: 'trailing_stop', symbol: toKrakenContractSymbol(symbol), side: holdSide === 'long' || holdSide === 'buy' ? 'sell' : 'buy', size: quantity, triggerSignal: triggerType === 'fill_price' ? 'last' : 'mark', trailingStopMaxDeviation: Math.min(50, Math.max(0.1, callbackPercent)), trailingStopDeviationUnit: 'PERCENT', reduceOnly: true, cliOrdId: clientOid }, tradingMode);
export const krakenPlaceLimitOrder = async (symbol: string, side: 'BUY' | 'SELL', quantity: number, price: number, force: 'post_only' | 'ioc' | 'gtc' = 'post_only', clientOid?: string, tradingMode: TradingMode = 'demo', _tradeSide?: 'open' | 'close') =>
  sendOrder({ orderType: force === 'post_only' ? 'post' : force === 'ioc' ? 'ioc' : 'lmt', symbol: toKrakenContractSymbol(symbol), side: orderSide(side), size: quantity, limitPrice: price, cliOrdId: clientOid }, tradingMode);

export const krakenCancelOrder = async (symbol: string, tradingMode: TradingMode = 'demo', orderId?: string, clientOid?: string) => {
  if (tradingMode === 'demo') {
    const orders = await readPaperOrders();
    const matching = orders.filter((order) => order.symbol === toKrakenContractSymbol(symbol) && (!orderId || order.orderId === orderId) && (!clientOid || order.clientOid === clientOid));
    const ids = new Set(matching.map((order) => order.orderId));
    await writePaperOrders(orders.map((order) => ids.has(order.orderId) ? { ...order, status: 'cancelled', updatedAt: new Date().toISOString() } : order));
    return { result: 'success', code: '00000', msg: 'paper order cancelled', data: { successList: Array.from(ids) } };
  }
  if (process.env.KRAKEN_LIVE_TRADING_ENABLED !== '1') return { result: 'error', error: 'Live trading is disabled' };
  return krakenRequest('/derivatives/api/v3/cancelorder', { orderId, cliOrdId: clientOid, symbol: toKrakenContractSymbol(symbol) }, 'POST', true, tradingMode);
};
export const krakenGetOrderDetail = async (_symbol: string, tradingMode: TradingMode = 'demo', orderId?: string, clientOid?: string) => {
  if (tradingMode === 'demo') {
    const orders = (await readPaperOrders()).filter((order) => (!orderId || order.orderId === orderId) && (!clientOid || order.clientOid === clientOid));
    const data = orders.map((order) => paperOrderResponse(order).data);
    return { result: 'success', code: '00000', data, orders: data };
  }
  const resp = await krakenRequest('/derivatives/api/v3/orders/status', { orderIds: orderId, cliOrdIds: clientOid }, 'POST', true, tradingMode);
  const orders = Array.isArray(resp?.orders) ? resp.orders.map((item: any) => item.order || item) : [];
  return { ...resp, data: orders, orders };
};
export const krakenGetOrderFills = async (_symbol: string, orderId: string, tradingMode: TradingMode = 'demo') => {
  if (tradingMode === 'demo') {
    const order = (await readPaperOrders()).find((item) => item.orderId === orderId);
    const fills = order && order.status === 'filled' ? [{ order_id: order.orderId, symbol: order.symbol, size: order.filledSize, price: order.averagePrice, fillTime: order.updatedAt }] : [];
    return { result: 'success', code: '00000', data: fills, fills };
  }
  const resp = await krakenRequest('/derivatives/api/v3/fills', {}, 'GET', true, tradingMode);
  const fills = Array.isArray(resp?.fills) ? resp.fills.filter((fill: any) => !orderId || fill.order_id === orderId) : [];
  return { ...resp, data: fills, fills };
};
export const krakenGetOrderHistory = async (symbol: string, _startTime: number, _endTime: number, tradingMode: TradingMode = 'demo') => {
  if (tradingMode === 'demo') {
    const native = toKrakenContractSymbol(symbol);
    const data = (await readPaperOrders()).filter((order) => order.symbol === native && order.status === 'filled').map((order) => ({ orderId: order.orderId, symbol, reduceOnly: Boolean(order.reduceOnly), baseVolume: order.filledSize, priceAvg: order.averagePrice, cTime: Date.parse(order.updatedAt), orderSource: order.orderType }));
    return { result: 'success', code: '00000', data, orders: data };
  }
  const resp = await krakenRequest('/derivatives/api/v3/fills', {}, 'GET', true, tradingMode);
  const native = toKrakenContractSymbol(symbol);
  const data = Array.isArray(resp?.fills) ? resp.fills.filter((fill: any) => fill.symbol === native).map((fill: any) => ({ orderId: fill.order_id, symbol, reduceOnly: false, baseVolume: fill.size, priceAvg: fill.price, cTime: Date.parse(fill.fillTime || '') || Date.now(), orderSource: fill.fillType })) : [];
  return { ...resp, data, orders: data };
};
export const krakenGetPlanOrderHistory = async (symbol: string, _planType: 'normal_plan' | 'profit_loss', startTime: number, endTime: number, tradingMode: TradingMode = 'demo') => krakenGetOrderHistory(symbol, startTime, endTime, tradingMode);

export const krakenGetMergeDepth = async (symbol: string, tradingMode: TradingMode = 'demo') => {
  const resp = await krakenRequest('/derivatives/api/v3/orderbook', { symbol: toKrakenContractSymbol(symbol) }, 'GET', false, tradingMode);
  if (!krakenOrderSuccess(resp) || !resp.orderBook) return { ok: false, bids: [], asks: [], error: resp?.error || 'Kraken orderbook unavailable' };
  const normalizeSide = (side: any[], direction: 'bid' | 'ask') => (Array.isArray(side) ? side : [])
    .map((level: any) => Array.isArray(level) ? [Number(level[0]), Number(level[1])] : [Number(level?.price), Number(level?.size ?? level?.qty)])
    .filter((level: number[]) => Number.isFinite(level[0]) && Number.isFinite(level[1]) && level[0] > 0 && level[1] > 0)
    .sort((left: number[], right: number[]) => direction === 'bid' ? right[0] - left[0] : left[0] - right[0]);
  return { ok: true, bids: normalizeSide(resp.orderBook.bids, 'bid'), asks: normalizeSide(resp.orderBook.asks, 'ask'), error: null };
};
const resolutionFor = (granularity: string) => ({ '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1H': '1h', '1h': '1h', '4H': '4h', '4h': '4h', '12H': '12h', '1D': '1d', '1d': '1d' } as Record<string, string>)[granularity] || '1m';
export const krakenGetHistoricalCandles = async (symbol: string, granularity: string, limit: number, tradingMode: TradingMode = 'demo', endTime?: number) => {
  const baseUrl = tradingMode === 'live' ? LIVE_URL : PAPER_MARKET_URL;
  const query = new URLSearchParams({ count: String(limit) });
  if (endTime) query.set('to', String(Math.floor(endTime / 1000)));
  try {
    const response = await axios.get(`${baseUrl}/api/charts/v1/trade/${toKrakenContractSymbol(symbol)}/${resolutionFor(granularity)}?${query}`, { timeout: 15000 });
    const candles = (response.data?.candles || []).map((candle: any) => ({ ts: Number(candle.time), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume || 0) })).filter((candle: any) => [candle.ts, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));
    return candles.length ? { ok: true, candles, error: null } : { ok: false, error: 'No candle data available' };
  } catch (error: any) { return { ok: false, error: error?.response?.data?.error || error?.message || 'Kraken candles unavailable' }; }
};
export const krakenGetRecentCandleRange = async (symbol: string, mode: TradingMode = 'demo', limit = 5): Promise<any> => { const historical = await krakenGetHistoricalCandles(symbol, '1m', limit, mode); if (!historical.ok) return historical; return { ok: true, high: Math.max(...historical.candles.map((candle: any) => candle.high)), low: Math.min(...historical.candles.map((candle: any) => candle.low)), candles: historical.candles, error: null }; };

export const krakenGetWsBestBidAsk = async (symbol: string, tradingMode: TradingMode = 'demo') => {
  try {
    await axios.get(`${WS_SERVICE_URL}/subscribe`, { params: { symbol: krakenNormalizeSymbol(symbol), mode: tradingMode }, timeout: 1500 });
    const response = await axios.get(`${WS_SERVICE_URL}/snapshot`, { params: { symbol: krakenNormalizeSymbol(symbol), mode: tradingMode }, timeout: 1500 });
    const snapshot = response.data?.snapshot;
    if (!response.data?.ok || !snapshot) return { ok: false, source: 'websocket', error: response.data?.message || 'snapshot unavailable' };
    return { ok: true, source: 'websocket' as const, bestBid: Number(snapshot.bestBid), bestAsk: Number(snapshot.bestAsk), bidSize: Number(snapshot.bidSize || 0), askSize: Number(snapshot.askSize || 0), timestamp: Number(snapshot.timestamp || Date.now()) };
  } catch (error: any) { return { ok: false, source: 'websocket', error: error?.response?.data?.message || error?.message || 'ws service unavailable' }; }
};
export const krakenGetVipFeeRates = async () => ({ ok: true, makerFeeRate: getConfiguredFee('live', 'maker'), takerFeeRate: getConfiguredFee('live', 'taker') });
export const krakenGetCommissionRate = async (_symbol: string, mode: TradingMode = 'demo') => getConfiguredFee(mode, 'taker');
export const krakenGetMakerCommissionRate = async (_symbol: string, mode: TradingMode = 'demo') => getConfiguredFee(mode, 'maker');
export const krakenGetCurrentFundingRate = async (symbol: string, tradingMode: TradingMode = 'demo') => { const ticker = await getTicker(symbol, tradingMode); return ticker ? { ok: true, fundingRate: Number(ticker.fundingRate || 0), nextFundingTime: null } : { ok: false, fundingRate: 0, nextFundingTime: null }; };

const normalizeOpenOrders = (resp: any, symbol: string) => {
  const native = toKrakenContractSymbol(symbol);
  return (Array.isArray(resp?.openOrders) ? resp.openOrders : [])
    .filter((order: any) => order.symbol === native)
    .map((order: any) => ({
      ...order,
      orderId: order.order_id || order.orderId,
      planType: planTypeForOrderType(order.orderType),
      triggerPrice: order.stopPrice || order.priceTriggerOptions?.triggerPrice,
      size: order.unfilledSize || order.quantity,
      rangeRate: order.priceTriggerOptions?.trailingStopOptions?.maxDeviation,
    }));
};
const getPendingOrders = async (symbol: string, mode: TradingMode) => {
  if (mode === 'demo') {
    const native = toKrakenContractSymbol(symbol);
    const orders = (await readPaperOrders())
      .filter((order) => order.symbol === native && order.status === 'open')
      .map((order) => ({
        ...order,
        orderId: order.orderId,
        orderType: order.orderType,
        planType: planTypeForOrderType(order.orderType),
        triggerPrice: order.stopPrice,
        size: order.size,
        unfilledSize: order.size,
        rangeRate: order.rangeRate,
      }));
    return { ok: true as const, orders, error: null };
  }
  const resp = await krakenRequest('/derivatives/api/v3/openorders', {}, 'GET', true, mode);
  if (!krakenOrderSuccess(resp)) return { ok: false as const, orders: [], error: resp?.error || 'Kraken open orders unavailable' };
  return { ok: true as const, orders: normalizeOpenOrders(resp, symbol), error: null };
};
export const krakenGetPendingStopOrders = async (symbol: string, mode: TradingMode = 'demo') => { const pending = await getPendingOrders(symbol, mode); return pending.ok ? { ...pending, orders: pending.orders.filter((order: any) => ['stp', 'stop', 'trigger_order'].some((kind) => String(order.orderType).toLowerCase().includes(kind))) } : pending; };
export const krakenGetPendingTpslOrders = async (symbol: string, mode: TradingMode = 'demo') => { const pending = await getPendingOrders(symbol, mode); return pending.ok ? { ...pending, orders: pending.orders.filter((order: any) => ['take_profit', 'trailing_stop', 'trigger_order'].some((kind) => String(order.orderType).toLowerCase().includes(kind) || String(order.planType).toLowerCase().includes(kind))) } : pending; };
export const krakenIsTrailingOrder = (order: any) => String(order?.orderType || '').toLowerCase().includes('trailing') || Number.isFinite(Number(order?.rangeRate));
export const krakenGetPendingTrailingOrders = async (symbol: string, mode: TradingMode = 'demo') => { const pending = await krakenGetPendingTpslOrders(symbol, mode); return pending.ok ? { ...pending, orders: pending.orders.filter(krakenIsTrailingOrder) } : pending; };

const priceMatches = (left: number, right: number) => Math.abs(left - right) <= Math.max(1e-8, Math.abs(right) * 0.000001);
const sizeMatches = (left: number, right: number) => Math.abs(left - right) <= Math.max(0.000001, Math.abs(right) * 0.02);
export const krakenVerifyPendingStopOrder = async (symbol: string, expectedTriggerPrice: number, expectedSize: number, mode: TradingMode = 'demo') => { const pending = await krakenGetPendingStopOrders(symbol, mode); const order = pending.ok ? pending.orders.find((item: any) => priceMatches(Number(item.triggerPrice), expectedTriggerPrice) && sizeMatches(Number(item.size), expectedSize)) : null; return { ok: pending.ok, verified: Boolean(order), message: order ? 'verified' : (pending.error || 'matching stop order not found'), order: order || null }; };
export const krakenEnsureVerifiedStopOrder = async (params: { symbol: string; side: 'BUY' | 'SELL'; stopPrice: number; quantity: number; tradingMode: TradingMode; tradeSide?: 'open' | 'close'; positionType?: 'buy' | 'sell' }) => {
  const { symbol, side, stopPrice, quantity, tradingMode, positionType } = params;
  const info = await krakenGetExchangeInfo(symbol, tradingMode);
  const normalizedStopPrice = info && positionType ? krakenNormalizeProtectionPrice(stopPrice, info, positionType, 'stop') : stopPrice;
  const pending = await krakenGetPendingStopOrders(symbol, tradingMode);
  if (!pending.ok) return { ok: false, message: pending.error };
  const existing = pending.orders[0];
  if (existing && priceMatches(Number(existing.triggerPrice), normalizedStopPrice) && sizeMatches(Number(existing.size), quantity)) return { ok: true, message: 'unchanged', order: existing, normalizedStopPrice };
  await krakenCancelAllOrders(symbol, tradingMode);
  const response = await krakenPlaceStopMarket(symbol, side, normalizedStopPrice, quantity, tradingMode);
  if (!krakenOrderSuccess(response)) return { ok: false, message: response?.error || 'Stop order rejected' };
  for (const delay of PROTECTION_VERIFY_DELAYS_MS) { await sleep(delay); const verification = await krakenVerifyPendingStopOrder(symbol, normalizedStopPrice, quantity, tradingMode); if (verification.verified) return { ok: true, message: 'placed', order: verification.order, normalizedStopPrice }; }
  return { ok: false, message: `Stop order could not be verified at ${normalizedStopPrice}` };
};
export const krakenVerifyPendingTrailingOrder = async (params: { symbol: string; expectedTriggerPrice: number; expectedSize: number; expectedCallbackPercent: number; tradingMode: TradingMode; expectedTriggerType?: 'fill_price' | 'mark_price' }) => { const pending = await krakenGetPendingTrailingOrders(params.symbol, params.tradingMode); const order = pending.ok ? pending.orders.find((item: any) => sizeMatches(Number(item.size), params.expectedSize) && Math.abs(Number(item.rangeRate) - params.expectedCallbackPercent) <= Math.max(0.0001, params.expectedCallbackPercent * 0.01)) : null; return { ok: pending.ok, verified: Boolean(order), message: order ? 'verified' : (pending.error || 'matching trailing order not found'), order: order || null }; };
export const krakenEnsureTrailingOrder = async (params: { symbol: string; holdSide: 'long' | 'short' | 'buy' | 'sell'; triggerPrice: number; quantity: number; callbackPercent: number; triggerType?: 'fill_price' | 'mark_price'; clientOid?: string; tradingMode: TradingMode }) => { await krakenCancelTrailingOrders(params.symbol, params.tradingMode); const response = await krakenPlaceTrailingStop(params.symbol, params.holdSide, params.triggerPrice, params.quantity, params.callbackPercent, params.triggerType === 'fill_price' ? 'fill_price' : 'mark_price', params.clientOid, params.tradingMode); if (!krakenOrderSuccess(response)) return { ok: false, message: response?.error || 'Trailing order rejected', response }; for (const delay of PROTECTION_VERIFY_DELAYS_MS) { await sleep(delay); const verification = await krakenVerifyPendingTrailingOrder({ symbol: params.symbol, expectedTriggerPrice: params.triggerPrice, expectedSize: params.quantity, expectedCallbackPercent: params.callbackPercent, tradingMode: params.tradingMode, expectedTriggerType: params.triggerType }); if (verification.verified) return { ok: true, message: 'placed', response, order: verification.order, normalizedTriggerPrice: params.triggerPrice }; } return { ok: false, message: `Trailing order could not be verified at ${params.triggerPrice}`, response }; };
export const krakenCancelVerifiedTakeProfitOrders = async (symbol: string, mode: TradingMode = 'demo') => { const pending = await krakenGetPendingTpslOrders(symbol, mode); if (!pending.ok) return { ok: false, message: pending.error }; await Promise.all(pending.orders.filter((order: any) => String(order.orderType).toLowerCase().includes('take_profit')).map((order: any) => krakenCancelOrder(symbol, mode, order.orderId))); return { ok: true, message: 'cancelled' }; };
export const krakenModifyStopOrder = async (symbol: string, orderId: string, stopPrice: number, mode: TradingMode = 'demo') => { await krakenCancelOrder(symbol, mode, orderId); return krakenPlaceStopMarket(symbol, 'SELL', stopPrice, undefined, mode); };
export const krakenModifyTpslOrder = async (symbol: string, orderId: string, triggerPrice: number, quantity: number, mode: TradingMode = 'demo') => { await krakenCancelOrder(symbol, mode, orderId); return krakenPlaceTpslMarket(symbol, 'profit_plan', 'long', triggerPrice, quantity, undefined, mode); };
export const krakenCancelPlanOrdersByIds = async (symbol: string, orderIds: string[], mode: TradingMode = 'demo') => { for (const id of orderIds) await krakenCancelOrder(symbol, mode, id); return { result: 'success', code: '00000', data: { successList: orderIds, failureList: [] } }; };
export const krakenCancelTrailingOrders = async (symbol: string, mode: TradingMode = 'demo') => { const pending = await krakenGetPendingTrailingOrders(symbol, mode); if (!pending.ok) return { ok: false, message: pending.error }; await krakenCancelPlanOrdersByIds(symbol, pending.orders.map((order: any) => order.orderId).filter(Boolean), mode); return { ok: true, message: pending.orders.length ? 'cancelled' : 'already-empty' }; };
export const krakenCancelAlgoOrders = async (symbol: string, mode: TradingMode = 'demo') => krakenCancelAllOrders(symbol, mode);
export const krakenCancelLossOrders = async (symbol: string, mode: TradingMode = 'demo') => krakenCancelAllOrders(symbol, mode);
export const krakenCancelAlgoOrder = async (symbol: string, algoId: number | string, mode: TradingMode = 'demo') => krakenCancelOrder(symbol, mode, String(algoId));
export const krakenCancelAllOrders = async (symbol: string, mode: TradingMode = 'demo') => {
  if (mode === 'demo') {
    const native = toKrakenContractSymbol(symbol);
    const orders = await readPaperOrders();
    await writePaperOrders(orders.map((order) => order.symbol === native && order.status === 'open' ? { ...order, status: 'cancelled', updatedAt: new Date().toISOString() } : order));
    return { result: 'success', code: '00000', msg: 'paper open orders cancelled' };
  }
  if (process.env.KRAKEN_LIVE_TRADING_ENABLED !== '1') return { result: 'error', error: 'Live trading is disabled' };
  return krakenRequest('/derivatives/api/v3/cancelallorders', { symbol: toKrakenContractSymbol(symbol) }, 'POST', true, mode);
};
/** Kraken Futures dead-man switch. Call periodically from the worker in live mode. */
export const krakenCancelAllOrdersAfter = async (timeoutSeconds: number, mode: TradingMode = 'live') => {
  if (mode === 'demo') return { result: 'success', code: '00000', msg: 'paper dead-man switch is implicit' };
  if (process.env.KRAKEN_LIVE_TRADING_ENABLED !== '1') return { result: 'error', error: 'Live trading is disabled' };
  return krakenRequest('/derivatives/api/v3/cancelallordersafter', { timeout: Math.max(0, Math.floor(timeoutSeconds)) }, 'POST', true, mode);
};
export const krakenFlashClosePosition = async (symbol: string, _holdSide?: 'long' | 'short', mode: TradingMode = 'demo') => { const position = await krakenGetSinglePosition(symbol, mode); const current = position.positions[0]; if (!current || Number(current.positionAmt) === 0) return { result: 'success', code: '00000', msg: 'already-flat' }; return krakenClosePosition(symbol, Number(current.positionAmt) > 0 ? 'SELL' : 'BUY', Math.abs(Number(current.positionAmt)), mode); };
export const krakenClosePosition = async (symbol: string, side: 'BUY' | 'SELL', quantity: number, mode: TradingMode = 'demo', _tradeSide?: 'open' | 'close') => sendOrder({ orderType: 'mkt', symbol: toKrakenContractSymbol(symbol), side: orderSide(side), size: quantity, reduceOnly: true }, mode);

const normalizeAccountRecords = (payload: any) => {
  const source = payload?.accounts || payload?.data?.accounts || payload?.data;
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source).map(([accountType, value]: [string, any]) => {
    const account = value || {};
    const accountName = accountType.toLowerCase();
    const marginCoin = account.currency || (accountName.includes('xbt') ? 'XBT' : accountName.includes('eth') ? 'ETH' : 'USD');
    const accountEquity = Number(account.portfolioValue ?? account.portfolio_value ?? account.balanceValue ?? account.balance_value ?? account.cashValue ?? account.cash_value ?? 0);
    const available = Number(account.availableMargin ?? account.available_margin ?? account.available ?? 0);
    const locked = Number(account.initialMargin ?? account.initial_margin ?? 0);
    const unrealizedPnl = Number(account.pnl ?? account.totalUnrealized ?? account.total_unrealized ?? account.unrealizedFunding ?? account.unrealized_funding ?? 0);
    return {
      accountType,
      marginCoin,
      available: Number.isFinite(available) ? available : 0,
      locked: Number.isFinite(locked) ? locked : 0,
      accountEquity: Number.isFinite(accountEquity) ? accountEquity : 0,
      unrealizedPnl: Number.isFinite(unrealizedPnl) ? unrealizedPnl : 0,
      crossedMaxAvailable: Number.isFinite(available) ? available : 0,
      maxOpenPosAvailable: Number.isFinite(available) ? available : 0,
      usdtBalance: /USD|USDT|USDC/i.test(marginCoin) ? (Number.isFinite(accountEquity) ? accountEquity : 0) : 0,
      btcBalance: /^XBT|BTC$/i.test(marginCoin) ? (Number.isFinite(accountEquity) ? accountEquity : 0) : 0,
    };
  });
};

export const krakenGetAllAccountBalance = async (mode: TradingMode = 'demo') => {
  if (mode === 'demo') {
    const balanceSetting = await prisma.setting.findUnique({ where: { key: PAPER_BALANCE_SETTING_KEY } });
    const balance = Number.parseFloat(balanceSetting?.value || process.env.KRAKEN_PAPER_INITIAL_BALANCE_USD || '10000');
    const positions = await prisma.position.findMany({ where: { tradingMode: 'demo', status: 'open' } });
    const unrealizedPnl = positions.reduce((sum, position) => sum + Number(position.profitLossFiat || 0), 0);
    const account = {
      accountType: 'PAPER-FUTURES', marginCoin: 'USD', available: balance, locked: 0,
      accountEquity: balance + unrealizedPnl, unrealizedPnl, crossedMaxAvailable: balance,
      maxOpenPosAvailable: balance, usdtBalance: balance + unrealizedPnl, btcBalance: 0,
    };
    return { result: 'success', code: '00000', msg: 'app-local paper account', data: [account] };
  }
  const response = await krakenRequest('/derivatives/api/v3/accounts', {}, 'GET', true, mode);
  return krakenOrderSuccess(response) ? { ...response, data: normalizeAccountRecords(response) } : response;
};

export const krakenGetFuturesAccounts = async (_productType: 'USD-FUTURES' | 'FUTURES', mode: TradingMode = 'demo') => krakenGetAllAccountBalance(mode);

export const krakenGetSpotAssets = async (_mode: TradingMode = 'demo') => ({ result: 'success', code: '00000', msg: 'Kraken Futures adapter has no Spot wallet scope', data: [] });
