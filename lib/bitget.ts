import axios from 'axios';
import crypto from 'crypto';

const BITGET_API_KEY = process.env.BITGET_LIVE_API_KEY || '';
const BITGET_SECRET_KEY = process.env.BITGET_LIVE_SECRET_KEY || '';
const BITGET_PASSPHRASE = process.env.BITGET_LIVE_PASSPHRASE || '';

const BITGET_DEMO_API_KEY = process.env.BITGET_DEMO_API_KEY || '';
const BITGET_DEMO_SECRET_KEY = process.env.BITGET_DEMO_SECRET_KEY || '';
const BITGET_DEMO_PASSPHRASE = process.env.BITGET_DEMO_PASSPHRASE || '';

const BASE_URL = 'https://api.bitget.com';
const WS_SERVICE_URL = (process.env.BITGET_WS_SERVICE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DEFAULT_TAKER_FEE = 0.0006;
const DEFAULT_MAKER_FEE = 0.0002;
const PROTECTION_VERIFY_DELAYS_MS = [300, 600, 1200, 1500, 2000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseFeeRate = (value?: string) => {
  const parsed = Number.parseFloat(String(value || '').trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const getConfiguredTakerFee = (symbol: string, tradingMode: 'demo' | 'live') => {
  const quote = symbol.toUpperCase().endsWith('USDC') ? 'USDC' : symbol.toUpperCase().endsWith('USD') ? 'USD' : 'USDT';
  const modePrefix = tradingMode === 'live' ? 'BITGET_LIVE' : 'BITGET_DEMO';
  const candidates = [
    process.env[`${modePrefix}_${quote}_TAKER_FEE`],
    process.env[`${modePrefix}_TAKER_FEE`],
    process.env.BITGET_TAKER_FEE,
  ];

  for (const candidate of candidates) {
    const parsed = parseFeeRate(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return DEFAULT_TAKER_FEE;
};

const getConfiguredMakerFee = (symbol: string, tradingMode: 'demo' | 'live') => {
  const quote = symbol.toUpperCase().endsWith('USDC') ? 'USDC' : symbol.toUpperCase().endsWith('USD') ? 'USD' : 'USDT';
  const modePrefix = tradingMode === 'live' ? 'BITGET_LIVE' : 'BITGET_DEMO';
  const candidates = [
    process.env[`${modePrefix}_${quote}_MAKER_FEE`],
    process.env[`${modePrefix}_MAKER_FEE`],
    process.env.BITGET_MAKER_FEE,
  ];

  for (const candidate of candidates) {
    const parsed = parseFeeRate(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return DEFAULT_MAKER_FEE;
};

const bitgetRequest = async (
  endpoint: string,
  params: Record<string, any> = {},
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  signed = false,
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const apiKey = tradingMode === 'live' ? BITGET_API_KEY : BITGET_DEMO_API_KEY;
  const secretKey = tradingMode === 'live' ? BITGET_SECRET_KEY : BITGET_DEMO_SECRET_KEY;
  const passphrase = tradingMode === 'live' ? BITGET_PASSPHRASE : BITGET_DEMO_PASSPHRASE;

  const timestamp = Date.now().toString();

  let requestPath = endpoint;
  let bodyStr = '';

  if (method === 'GET' && Object.keys(params).length > 0) {
    const query = new URLSearchParams(params).toString();
    requestPath = `${endpoint}?${query}`;
  } else if (method === 'POST') {
    bodyStr = JSON.stringify(params);
  }

  const prehash = timestamp + method + requestPath + bodyStr;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (tradingMode === 'demo') {
    headers['paptrading'] = '1';
  }

  if (signed) {
    const signature = crypto.createHmac('sha256', secretKey).update(prehash).digest('base64');
    headers['ACCESS-KEY'] = apiKey;
    headers['ACCESS-SIGN'] = signature;
    headers['ACCESS-TIMESTAMP'] = timestamp;
    headers['ACCESS-PASSPHRASE'] = passphrase;
  }

  const url = `${BASE_URL}${requestPath}`;

  try {
    const response = await axios({
      method,
      url,
      headers,
      data: method === 'POST' ? bodyStr : undefined,
      timeout: 15000,
    });
    return response.data;
  } catch (error: any) {
    console.error(`Bitget API Error (${tradingMode}): ${method} ${endpoint}`, error.response?.data || error.message);
    return error.response?.data || { error: true, message: error.message };
  }
};

const getProductType = (symbol: string) => {
  if (symbol.endsWith('USDC')) return 'usdc-futures';
  if (symbol.endsWith('USD')) return 'coin-futures';
  return 'usdt-futures';
};

const getMarginCoin = (symbol: string) => {
  if (symbol.endsWith('USDC')) return 'USDC';
  if (symbol.endsWith('USD')) return symbol.replace('USD', '');
  return 'USDT';
};

export type BitgetPositionMode = 'one_way_mode' | 'hedge_mode';

const normalizeBitgetPositionMode = (value: unknown): BitgetPositionMode | null => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'one_way_mode' || raw === 'hedge_mode') {
    return raw;
  }
  return null;
};

export const bitgetBuildPositionContext = (
  positionType: 'buy' | 'sell',
  positionMode: BitgetPositionMode
) => {
  const openSide = positionType === 'buy' ? 'BUY' : 'SELL';
  const closeSide = positionMode === 'hedge_mode'
    ? (positionType === 'buy' ? 'BUY' : 'SELL')
    : (positionType === 'buy' ? 'SELL' : 'BUY');
  const holdSide = positionMode === 'hedge_mode'
    ? (positionType === 'buy' ? 'long' : 'short')
    : (positionType === 'buy' ? 'buy' : 'sell');
  const leverageHoldSide = positionType === 'buy' ? 'long' : 'short';

  return {
    openSide: openSide as 'BUY' | 'SELL',
    closeSide: closeSide as 'BUY' | 'SELL',
    holdSide: holdSide as 'long' | 'short' | 'buy' | 'sell',
    leverageHoldSide: leverageHoldSide as 'long' | 'short',
    openTradeSide: positionMode === 'hedge_mode' ? ('open' as const) : undefined,
    closeTradeSide: positionMode === 'hedge_mode' ? ('close' as const) : undefined,
    flashCloseHoldSide: positionMode === 'hedge_mode'
      ? (positionType === 'buy' ? 'long' : 'short') as 'long' | 'short'
      : undefined,
  };
};

export const bitgetGetPrice = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo'): Promise<number | false> => {
  const sym = symbol.toUpperCase();
  const res = await bitgetRequest('/api/v2/mix/market/ticker', { symbol: sym, productType: getProductType(sym) }, 'GET', false, tradingMode);
  if (res && res.data && res.data[0] && res.data[0].lastPr) {
    return parseFloat(res.data[0].lastPr);
  }
  return false;
};

export const bitgetPlaceMarketOrder = async (
  symbol: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  tradingMode: 'demo' | 'live' = 'demo',
  tradeSide?: 'open' | 'close'
) => {
  const sym = symbol.toUpperCase();
  const params: Record<string, string> = {
    symbol: sym,
    productType: getProductType(sym),
    marginMode: 'crossed',
    marginCoin: getMarginCoin(sym),
    side: side.toLowerCase(), // 'buy' or 'sell'
    orderType: 'market',
    size: quantity.toString(),
  };

  if (tradeSide) {
    params.tradeSide = tradeSide;
  }

  return bitgetRequest('/api/v2/mix/order/place-order', params, 'POST', true, tradingMode);
};

export const bitgetOrderSuccess = (resp: any) => {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.error) return false;
  if (resp.code !== '00000') return false;
  return true;
};

export const bitgetSetLeverage = async (
  symbol: string,
  leverage: number,
  holdSide?: 'long' | 'short',
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const sym = symbol.toUpperCase();
  const params: Record<string, string> = {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
    leverage: leverage.toString(),
  };

  if (holdSide) {
    params.holdSide = holdSide;
  }

  return bitgetRequest('/api/v2/mix/account/set-leverage', params, 'POST', true, tradingMode);
};

export const bitgetGetPositionMode = async (
  symbol: string,
  tradingMode: 'demo' | 'live' = 'demo'
): Promise<BitgetPositionMode | null> => {
  const sym = symbol.toUpperCase();
  const resp = await bitgetRequest('/api/v2/mix/account/account', {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
  }, 'GET', true, tradingMode);

  if (!bitgetOrderSuccess(resp)) {
    return null;
  }

  return normalizeBitgetPositionMode(resp?.data?.posMode);
};

export const bitgetSetPositionMode = async (
  symbol: string,
  posMode: BitgetPositionMode,
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const sym = symbol.toUpperCase();
  return bitgetRequest('/api/v2/mix/account/set-position-mode', {
    productType: getProductType(sym),
    posMode,
  }, 'POST', true, tradingMode);
};

type BitgetPositionSnapshot = {
  ok: boolean;
  positions: Array<{
    symbol: string;
    positionAmt: string | number;
    entryPrice: string | number;
    unRealizedProfit: string | number;
    leverage: string | number;
    positionSide: 'LONG' | 'SHORT' | 'BOTH';
  }>;
  errors: string[];
};

const normalizeBitgetPositionsPayload = (payload: any): any[] => {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === 'object') {
    return [payload];
  }

  return [];
};

const mapBitgetPosition = (p: any): BitgetPositionSnapshot['positions'][number] => ({
  symbol: p.symbol,
  positionAmt: p.total ?? p.openDelegateSize ?? p.available ?? p.locked ?? '0',
  entryPrice: p.averageOpenPrice ?? p.openPriceAvg ?? p.markPrice ?? '0',
  unRealizedProfit: p.unrealizedPL,
  leverage: p.leverage,
  positionSide: p.holdSide === 'long' ? 'LONG' : (p.holdSide === 'short' ? 'SHORT' : 'BOTH'),
});

export const bitgetClosePosition = async (
  symbol: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  tradingMode: 'demo' | 'live' = 'demo',
  tradeSide?: 'open' | 'close'
) => {
  const sym = symbol.toUpperCase();

  const params: Record<string, string> = {
    symbol: sym,
    productType: getProductType(sym),
    marginMode: 'crossed',
    marginCoin: getMarginCoin(sym),
    side: side.toLowerCase(),
    orderType: 'market',
    size: quantity.toString(),
  };

  if (tradeSide) {
    params.tradeSide = tradeSide;
  } else {
    params.reduceOnly = 'YES';
  }

  const res = await bitgetRequest('/api/v2/mix/order/place-order', params, 'POST', true, tradingMode);

  return res;
};

export const bitgetGetPositions = async (tradingMode: 'demo' | 'live' = 'demo'): Promise<BitgetPositionSnapshot> => {
  const responses = await Promise.all([
    bitgetRequest('/api/v2/mix/position/all-position', { productType: 'usdt-futures', marginCoin: 'USDT' }, 'GET', true, tradingMode),
    bitgetRequest('/api/v2/mix/position/all-position', { productType: 'usdc-futures', marginCoin: 'USDC' }, 'GET', true, tradingMode)
  ]);

  let allPositions: any[] = [];
  const errors: string[] = [];
  for (const resp of responses) {
    if (!bitgetOrderSuccess(resp)) {
      errors.push(resp?.msg || resp?.message || JSON.stringify(resp));
      continue;
    }

    if (resp && resp.data && Array.isArray(resp.data)) {
      // Map Bitget positions to the legacy shape expected by the current app.
      const mapped = resp.data.map((p: any) => mapBitgetPosition(p));
      allPositions = allPositions.concat(mapped);
    }
  }

  return {
    ok: errors.length === 0,
    positions: allPositions,
    errors,
  };
};

export const bitgetGetSinglePosition = async (
  symbol: string,
  tradingMode: 'demo' | 'live' = 'demo'
): Promise<BitgetPositionSnapshot> => {
  const sym = symbol.toUpperCase();
  const resp = await bitgetRequest('/api/v2/mix/position/single-position', {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
  }, 'GET', true, tradingMode);

  if (!bitgetOrderSuccess(resp)) {
    return {
      ok: false,
      positions: [],
      errors: [resp?.msg || resp?.message || JSON.stringify(resp)],
    };
  }

  return {
    ok: true,
    positions: normalizeBitgetPositionsPayload(resp?.data).map((p: any) => mapBitgetPosition(p)),
    errors: [],
  };
};

export const bitgetGetPricePrecision = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo'): Promise<number> => {
  const sym = symbol.toUpperCase();
  const res = await bitgetRequest('/api/v2/mix/market/contracts', { productType: getProductType(sym) }, 'GET', false, tradingMode);
  if (res && res.data) {
    const s = res.data.find((x: any) => x.symbol === sym);
    if (s && s.pricePlace) {
      return parseInt(s.pricePlace, 10);
    }
  }
  return 4;
};

export const bitgetGetTickSize = (exchangeInfo: any) => {
  const pricePlace = parseInt(exchangeInfo?.pricePlace || '4', 10);
  const priceEndStep = parseFloat(exchangeInfo?.priceEndStep || '1');
  return priceEndStep / Math.pow(10, pricePlace);
};

export const bitgetNormalizePriceByContract = (price: number, exchangeInfo: any) => {
  const pricePlace = parseInt(exchangeInfo?.pricePlace || '4', 10);
  const tickSize = bitgetGetTickSize(exchangeInfo);
  const normalized = Math.floor(price / tickSize) * tickSize;
  return parseFloat(normalized.toFixed(pricePlace));
};

export const bitgetNormalizePriceByContractDirectional = (
  price: number,
  exchangeInfo: any,
  direction: 'down' | 'up' = 'down'
) => {
  const pricePlace = parseInt(exchangeInfo?.pricePlace || '4', 10);
  const tickSize = bitgetGetTickSize(exchangeInfo);
  const scaled = price / tickSize;
  const normalized = direction === 'up'
    ? Math.ceil(scaled) * tickSize
    : Math.floor(scaled) * tickSize;
  const result = parseFloat(normalized.toFixed(pricePlace));

  // DEBUG: Log para verificar normalización
  if (exchangeInfo?.symbol === 'ADAUSDT' && Math.abs(price - 0.2172) < 0.0001) {
    console.log(`[BITGET DEBUG] ADAUSDT TP normalization:`, {
      inputPrice: price,
      direction,
      pricePlace,
      tickSize,
      scaled,
      rounded: direction === 'up' ? Math.ceil(scaled) : Math.floor(scaled),
      resultPrice: result,
      changed: result !== price
    });
  }

  return result;
};

export const bitgetNormalizeSizeByContract = (size: number, exchangeInfo: any) => {
  const minTradeNum = parseFloat(exchangeInfo?.minTradeNum || '0.001');
  const sizeMultiplier = parseFloat(exchangeInfo?.sizeMultiplier || '0');
  const volumePlace = parseInt(exchangeInfo?.volumePlace || '3', 10);

  let normalized = size;
  if (sizeMultiplier > 0) {
    normalized = Math.floor(normalized / sizeMultiplier) * sizeMultiplier;
  }
  if (normalized < minTradeNum) {
    normalized = minTradeNum;
  }

  return parseFloat(normalized.toFixed(volumePlace));
};

export const bitgetPlaceStopMarket = async (
  symbol: string,
  side: 'BUY' | 'SELL',
  stopPrice: number,
  quantity?: number,
  tradingMode: 'demo' | 'live' = 'demo',
  tradeSide?: 'open' | 'close'
) => {
  const sym = symbol.toUpperCase();
  const precision = await bitgetGetPricePrecision(sym, tradingMode);

  const params: any = {
    symbol: sym,
    productType: getProductType(sym),
    planType: 'normal_plan',
    triggerPrice: stopPrice.toFixed(precision),
    triggerType: 'mark_price',
    executePrice: '0', // market order
    side: side.toLowerCase(),
    orderType: 'market',
    marginCoin: getMarginCoin(sym),
    marginMode: 'crossed',
  };

  if (tradeSide) {
    params.tradeSide = tradeSide;
  } else {
    params.reduceOnly = 'YES';
  }

  if (quantity) {
    params.size = quantity.toString();
  }

  return bitgetRequest('/api/v2/mix/order/place-plan-order', params, 'POST', true, tradingMode);
};

export const bitgetPlaceTpslMarket = async (
  symbol: string,
  planType: 'profit_plan' | 'loss_plan',
  holdSide: 'long' | 'short' | 'buy' | 'sell',
  triggerPrice: number,
  quantity: number,
  clientOid?: string,
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const sym = symbol.toUpperCase();
  const precision = await bitgetGetPricePrecision(sym, tradingMode);
  const params: Record<string, string> = {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
    planType,
    triggerPrice: triggerPrice.toFixed(precision),
    triggerType: 'mark_price',
    executePrice: '0',
    holdSide,
    size: quantity.toString(),
  };

  if (clientOid) {
    params.clientOid = clientOid;
  }

  return bitgetRequest('/api/v2/mix/order/place-tpsl-order', params, 'POST', true, tradingMode);
};

export const bitgetPlaceLimitOrder = async (
  symbol: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  force: 'post_only' | 'ioc' | 'gtc' = 'post_only',
  clientOid?: string,
  tradingMode: 'demo' | 'live' = 'demo',
  tradeSide?: 'open' | 'close'
) => {
  const sym = symbol.toUpperCase();
  const params: Record<string, string> = {
    symbol: sym,
    productType: getProductType(sym),
    marginMode: 'crossed',
    marginCoin: getMarginCoin(sym),
    side: side.toLowerCase(),
    orderType: 'limit',
    size: quantity.toString(),
    price: price.toString(),
    force,
  };

  if (clientOid) {
    params.clientOid = clientOid;
  }

  if (tradeSide) {
    params.tradeSide = tradeSide;
  }

  return bitgetRequest('/api/v2/mix/order/place-order', params, 'POST', true, tradingMode);
};

export const bitgetCancelOrder = async (
  symbol: string,
  tradingMode: 'demo' | 'live' = 'demo',
  orderId?: string,
  clientOid?: string
) => {
  const sym = symbol.toUpperCase();
  const params: Record<string, string> = {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
  };

  if (orderId) params.orderId = orderId;
  if (clientOid) params.clientOid = clientOid;

  return bitgetRequest('/api/v2/mix/order/cancel-order', params, 'POST', true, tradingMode);
};

export const bitgetGetOrderDetail = async (
  symbol: string,
  tradingMode: 'demo' | 'live' = 'demo',
  orderId?: string,
  clientOid?: string
) => {
  const sym = symbol.toUpperCase();
  const params: Record<string, string> = {
    symbol: sym,
    productType: getProductType(sym),
  };

  if (orderId) params.orderId = orderId;
  if (clientOid) params.clientOid = clientOid;

  return bitgetRequest('/api/v2/mix/order/detail', params, 'GET', true, tradingMode);
};

export const bitgetGetOrderFills = async (
  symbol: string,
  orderId: string,
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const sym = symbol.toUpperCase();
  return bitgetRequest('/api/v2/mix/order/fills', {
    symbol: sym,
    orderId,
    productType: getProductType(sym),
    limit: '100',
  }, 'GET', true, tradingMode);
};

export const bitgetGetOrderHistory = async (
  symbol: string,
  startTime: number,
  endTime: number,
  tradingMode: 'demo' | 'live' = 'demo',
  limit = 100
) => {
  const sym = symbol.toUpperCase();
  return bitgetRequest('/api/v2/mix/order/orders-history', {
    symbol: sym,
    productType: getProductType(sym),
    startTime: String(startTime),
    endTime: String(endTime),
    limit: String(limit),
  }, 'GET', true, tradingMode);
};

export const bitgetGetPlanOrderHistory = async (
  symbol: string,
  planType: 'normal_plan' | 'profit_loss',
  startTime: number,
  endTime: number,
  tradingMode: 'demo' | 'live' = 'demo',
  limit = 100
) => {
  const sym = symbol.toUpperCase();
  return bitgetRequest('/api/v2/mix/order/orders-plan-history', {
    symbol: sym,
    productType: getProductType(sym),
    planType,
    startTime: String(startTime),
    endTime: String(endTime),
    limit: String(limit),
  }, 'GET', true, tradingMode);
};

export const bitgetGetMergeDepth = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  const resp = await bitgetRequest('/api/v2/mix/market/merge-depth', {
    symbol: sym,
    productType: getProductType(sym),
    limit: '5',
  }, 'GET', false, tradingMode);

  if (!resp || resp.code !== '00000' || !resp.data) {
    return { ok: false, bids: [], asks: [], error: resp?.msg || resp?.message || 'merge-depth failed' };
  }

  return {
    ok: true,
    bids: Array.isArray(resp.data.bids) ? resp.data.bids : [],
    asks: Array.isArray(resp.data.asks) ? resp.data.asks : [],
    error: null,
  };
};

export const bitgetGetRecentCandleRange = async (
  symbol: string,
  tradingMode: 'demo' | 'live' = 'demo',
  limit = 5
) => {
  const sym = symbol.toUpperCase();
  const resp = await bitgetRequest('/api/v2/mix/market/history-candles', {
    symbol: sym,
    productType: getProductType(sym),
    granularity: '1m',
    limit: String(limit),
  }, 'GET', false, tradingMode);

  if (!resp || resp.code !== '00000' || !Array.isArray(resp.data)) {
    return { ok: false, error: resp?.msg || resp?.message || 'history-candles failed' };
  }

  const candles = resp.data
    .map((row: any[]) => ({
      ts: Number.parseInt(String(row?.[0] || '0'), 10),
      high: Number.parseFloat(String(row?.[2] || '0')),
      low: Number.parseFloat(String(row?.[3] || '0')),
    }))
    .filter((candle: any) =>
      Number.isFinite(candle.ts) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      candle.high > 0 &&
      candle.low > 0
    );

  if (candles.length === 0) {
    return { ok: false, error: 'No candle data available' };
  }

  return {
    ok: true,
    high: Math.max(...candles.map((candle: any) => candle.high)),
    low: Math.min(...candles.map((candle: any) => candle.low)),
    candles,
    error: null,
  };
};

export const bitgetGetWsBestBidAsk = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();

  try {
    await axios.get(`${WS_SERVICE_URL}/subscribe`, {
      params: { symbol: sym, mode: tradingMode },
      timeout: 1500,
    });

    const resp = await axios.get(`${WS_SERVICE_URL}/snapshot`, {
      params: { symbol: sym, mode: tradingMode },
      timeout: 1500,
    });

    if (!resp.data?.ok || !resp.data?.snapshot) {
      return { ok: false, source: 'websocket', error: resp.data?.message || 'snapshot unavailable' };
    }

    const snapshot = resp.data.snapshot;
    return {
      ok: true,
      source: 'websocket' as const,
      bestBid: parseFloat(String(snapshot.bestBid)),
      bestAsk: parseFloat(String(snapshot.bestAsk)),
      bidSize: parseFloat(String(snapshot.bidSize || '0')),
      askSize: parseFloat(String(snapshot.askSize || '0')),
      timestamp: Number.parseInt(String(snapshot.timestamp || Date.now()), 10),
    };
  } catch (error: any) {
    return {
      ok: false,
      source: 'websocket',
      error: error?.response?.data?.message || error?.message || 'ws service unavailable',
    };
  }
};

export const bitgetGetVipFeeRates = async () => {
  const resp = await bitgetRequest('/api/v2/mix/market/vip-fee-rate', {}, 'GET', false, 'live');
  if (!resp || resp.code !== '00000' || !Array.isArray(resp.data)) {
    return { ok: false, makerFeeRate: DEFAULT_MAKER_FEE, takerFeeRate: DEFAULT_TAKER_FEE };
  }

  const levelOne = resp.data[0];
  return {
    ok: true,
    makerFeeRate: parseFeeRate(levelOne?.makerFeeRate) ?? DEFAULT_MAKER_FEE,
    takerFeeRate: parseFeeRate(levelOne?.takerFeeRate) ?? DEFAULT_TAKER_FEE,
  };
};

export const bitgetGetCurrentFundingRate = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  const resp = await bitgetRequest('/api/v2/mix/market/current-fund-rate', {
    symbol: sym,
    productType: getProductType(sym),
  }, 'GET', false, tradingMode);

  if (!resp || resp.code !== '00000' || !Array.isArray(resp.data) || !resp.data[0]) {
    return { ok: false, fundingRate: 0, nextFundingTime: null };
  }

  return {
    ok: true,
    fundingRate: parseFloat(resp.data[0].fundingRate || '0'),
    nextFundingTime: resp.data[0].nextFundingTime || null,
  };
};

export const bitgetGetPendingStopOrders = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  const resp = await bitgetRequest('/api/v2/mix/order/orders-plan-pending', {
    symbol: sym,
    planType: 'normal_plan',
    productType: getProductType(sym),
  }, 'GET', true, tradingMode);

  if (!bitgetOrderSuccess(resp)) {
    return { ok: false, orders: [], error: resp?.msg || resp?.message || JSON.stringify(resp) };
  }

  return {
    ok: true,
    orders: Array.isArray(resp?.data?.entrustedList) ? resp.data.entrustedList : [],
    error: null,
  };
};

const bitgetPriceMatches = (left: number, right: number) => {
  return Math.abs(left - right) <= Math.max(1e-8, Math.abs(right) * 0.000001);
};

const bitgetSizeMatches = (left: number, right: number) => {
  return Math.abs(left - right) <= Math.max(0.000001, Math.abs(right) * 0.02);
};

export const bitgetVerifyPendingStopOrder = async (
  symbol: string,
  expectedTriggerPrice: number,
  expectedSize: number,
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const pending = await bitgetGetPendingStopOrders(symbol, tradingMode);
  if (!pending.ok) {
    return { ok: false, verified: false, message: pending.error || 'Unable to fetch pending stop orders', order: null };
  }

  const matched = pending.orders.find((order: any) => {
    if (String(order?.planType || '').toLowerCase() !== 'normal_plan') {
      return false;
    }

    const triggerPrice = Number.parseFloat(String(order?.triggerPrice || order?.planTriggerPrice || '0'));
    const size = Number.parseFloat(String(order?.size || order?.sz || '0'));
    return Number.isFinite(triggerPrice) &&
      bitgetPriceMatches(triggerPrice, expectedTriggerPrice) &&
      (!Number.isFinite(size) || size <= 0 || bitgetSizeMatches(size, expectedSize));
  }) || null;

  return {
    ok: true,
    verified: Boolean(matched),
    message: matched ? 'verified' : 'matching stop order not found',
    order: matched,
  };
};

export const bitgetEnsureVerifiedStopOrder = async (params: {
  symbol: string;
  side: 'BUY' | 'SELL';
  stopPrice: number;
  quantity: number;
  tradingMode: 'demo' | 'live';
  tradeSide?: 'open' | 'close';
}) => {
  const { symbol, side, stopPrice, quantity, tradingMode, tradeSide } = params;
  const exchangeInfo = await bitgetGetExchangeInfo(symbol, tradingMode);
  const normalizedStopPrice = exchangeInfo
    ? bitgetNormalizePriceByContractDirectional(
        stopPrice,
        exchangeInfo,
        side === 'SELL' ? 'up' : 'down'
      )
    : stopPrice;
  const pending = await bitgetGetPendingStopOrders(symbol, tradingMode);
  if (!pending.ok) {
    return { ok: false, message: pending.error || 'Unable to fetch pending stop orders before sync' };
  }

  const stopOrders = pending.orders.filter((order: any) => String(order?.planType || '').toLowerCase() === 'normal_plan');
  const primary = stopOrders[0];
  const extras = stopOrders.slice(1).map((order: any) => order.orderId).filter(Boolean);

  if (extras.length > 0) {
    await bitgetCancelPlanOrdersByIds(symbol, extras, tradingMode);
  }

  let action: 'unchanged' | 'modified' | 'placed' = 'placed';

  if (primary?.orderId) {
    const currentTriggerPrice = Number.parseFloat(String(primary.triggerPrice || primary.planTriggerPrice || '0'));
    const currentSize = Number.parseFloat(String(primary.size || primary.sz || '0'));
    if (Number.isFinite(currentTriggerPrice) &&
      bitgetPriceMatches(currentTriggerPrice, normalizedStopPrice) &&
      (!Number.isFinite(currentSize) || currentSize <= 0 || bitgetSizeMatches(currentSize, quantity))) {
      action = 'unchanged';
    } else {
      // For strat mode: cancel existing and place new (like Self mode)
      // This avoids Bitget conflicts when modifying stop orders
      await bitgetCancelAlgoOrders(symbol, tradingMode);
      await bitgetCancelLossOrders(symbol, tradingMode);
      await sleep(300); // Give Bitget time to process cancellation
      const placeResp = await bitgetPlaceStopMarket(symbol, side, normalizedStopPrice, quantity, tradingMode, tradeSide);
      if (!bitgetOrderSuccess(placeResp)) {
        return { ok: false, message: placeResp?.msg || placeResp?.message || JSON.stringify(placeResp) };
      }
      action = 'placed';
    }
  } else {
    await bitgetCancelAlgoOrders(symbol, tradingMode);
    await bitgetCancelLossOrders(symbol, tradingMode);
    await sleep(300); // Give Bitget time to process cancellation
    const placeResp = await bitgetPlaceStopMarket(symbol, side, normalizedStopPrice, quantity, tradingMode, tradeSide);
    if (!bitgetOrderSuccess(placeResp)) {
      return { ok: false, message: placeResp?.msg || placeResp?.message || JSON.stringify(placeResp) };
    }
    action = 'placed';
  }

  for (const delayMs of PROTECTION_VERIFY_DELAYS_MS) {
    await sleep(delayMs);
    const verification = await bitgetVerifyPendingStopOrder(symbol, normalizedStopPrice, quantity, tradingMode);
    if (verification.ok && verification.verified) {
      return { ok: true, message: action, order: verification.order, normalizedStopPrice };
    }
  }

  return { ok: false, message: `Stop order could not be verified at ${normalizedStopPrice}` };
};

export const bitgetGetPendingTpslOrders = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  const resp = await bitgetRequest('/api/v2/mix/order/orders-plan-pending', {
    symbol: sym,
    planType: 'profit_loss',
    productType: getProductType(sym),
  }, 'GET', true, tradingMode);

  if (!bitgetOrderSuccess(resp)) {
    return { ok: false, orders: [], error: resp?.msg || resp?.message || JSON.stringify(resp) };
  }

  return {
    ok: true,
    orders: Array.isArray(resp?.data?.entrustedList) ? resp.data.entrustedList : [],
    error: null,
  };
};

const bitgetIsTakeProfitOrder = (order: any) => {
  const planType = String(order?.planType || '').toLowerCase();
  const orderSource = String(order?.orderSource || '').toLowerCase();
  return planType.includes('profit') || orderSource.includes('profit');
};

const bitgetCancelAllPlanOrdersByType = async (
  symbol: string,
  planType: 'normal_plan' | 'profit_plan' | 'loss_plan' | 'pos_profit' | 'pos_loss' | 'moving_plan',
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const sym = symbol.toUpperCase();
  return bitgetRequest('/api/v2/mix/order/cancel-all-plan-order', {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
    planType,
  }, 'POST', true, tradingMode);
};

export const bitgetCancelVerifiedTakeProfitOrders = async (
  symbol: string,
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const loadPending = async () => {
    const pending = await bitgetGetPendingTpslOrders(symbol, tradingMode);
    if (!pending.ok) {
      return { ok: false as const, message: pending.error || 'Unable to fetch pending TP orders', orders: [] as any[] };
    }

    const orders = pending.orders.filter((order: any) => bitgetIsTakeProfitOrder(order));

    return { ok: true as const, message: 'loaded', orders };
  };

  const initial = await loadPending();
  if (!initial.ok) {
    return { ok: false, message: initial.message };
  }

  const orderIds = initial.orders.map((order: any) => order.orderId).filter(Boolean);
  if (orderIds.length > 0) {
    await bitgetCancelPlanOrdersByIds(symbol, orderIds, tradingMode);
    await Promise.allSettled([
      bitgetCancelAllPlanOrdersByType(symbol, 'profit_plan', tradingMode),
      bitgetCancelAllPlanOrdersByType(symbol, 'pos_profit', tradingMode),
    ]);
  }

  for (const delayMs of PROTECTION_VERIFY_DELAYS_MS) {
    await sleep(delayMs);
    const verification = await loadPending();
    if (!verification.ok) {
      continue;
    }

    if (verification.orders.length === 0) {
      return { ok: true, message: orderIds.length > 0 ? 'cancelled' : 'already-empty' };
    }
  }

  return { ok: false, message: 'Take profit orders could not be fully removed from Bitget' };
};

export const bitgetModifyStopOrder = async (
  symbol: string,
  orderId: string,
  stopPrice: number,
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const sym = symbol.toUpperCase();
  const precision = await bitgetGetPricePrecision(sym, tradingMode);

  return bitgetRequest('/api/v2/mix/order/modify-plan-order', {
    orderId,
    planType: 'normal_plan',
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
    newTriggerPrice: stopPrice.toFixed(precision),
    newTriggerType: 'mark_price',
  }, 'POST', true, tradingMode);
};

export const bitgetModifyTpslOrder = async (
  symbol: string,
  orderId: string,
  triggerPrice: number,
  quantity: number,
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const sym = symbol.toUpperCase();
  const precision = await bitgetGetPricePrecision(sym, tradingMode);

  return bitgetRequest('/api/v2/mix/order/modify-tpsl-order', {
    orderId,
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
    triggerPrice: triggerPrice.toFixed(precision),
    triggerType: 'mark_price',
    executePrice: '0',
    size: quantity.toString(),
  }, 'POST', true, tradingMode);
};

export const bitgetCancelPlanOrdersByIds = async (
  symbol: string,
  orderIds: string[],
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const sym = symbol.toUpperCase();
  if (orderIds.length === 0) {
    return { code: '00000', msg: 'success', data: { successList: [], failureList: [] } };
  }

  return bitgetRequest('/api/v2/mix/order/cancel-plan-order', {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
    orderIdList: orderIds.map((orderId) => ({ orderId, clientOid: '' })),
  }, 'POST', true, tradingMode);
};

export const bitgetCancelAlgoOrders = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  return bitgetRequest('/api/v2/mix/order/cancel-all-plan-order', {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
    planType: 'normal_plan'
  }, 'POST', true, tradingMode);
};

export const bitgetCancelLossOrders = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  return bitgetRequest('/api/v2/mix/order/cancel-all-plan-order', {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
    planType: 'loss_plan'
  }, 'POST', true, tradingMode);
};

export const bitgetCancelAlgoOrder = async (symbol: string, algoId: number | string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  // Wait, Bitget cancel plan order by id
  return bitgetRequest('/api/v2/mix/order/cancel-plan-order', {
    symbol: sym,
    marginCoin: getMarginCoin(sym),
    productType: getProductType(sym),
    orderId: algoId.toString()
  }, 'POST', true, tradingMode);
};

export const bitgetCancelAllOrders = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  const method = 'POST'; // cancel uses post in bitget V2

  const r1 = await bitgetRequest('/api/v2/mix/order/cancel-all-orders', {
    symbol: sym,
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
  }, method, true, tradingMode);

  const planTypes = ['normal_plan', 'profit_plan', 'loss_plan', 'pos_profit', 'pos_loss', 'moving_plan'] as const;
  const algo = await Promise.all(planTypes.map((planType) =>
    bitgetRequest('/api/v2/mix/order/cancel-all-plan-order', {
      symbol: sym,
      productType: getProductType(sym),
      marginCoin: getMarginCoin(sym),
      planType,
    }, 'POST', true, tradingMode)
  ));

  return { normal: r1, algo };
};

export const bitgetFlashClosePosition = async (
  symbol: string,
  holdSide?: 'long' | 'short',
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const sym = symbol.toUpperCase();
  const params: Record<string, string> = {
    symbol: sym,
    productType: getProductType(sym),
  };

  if (holdSide) {
    params.holdSide = holdSide;
  }

  return bitgetRequest('/api/v2/mix/order/close-positions', params, 'POST', true, tradingMode);
};

export const bitgetGetExchangeInfo = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  const res = await bitgetRequest('/api/v2/mix/market/contracts', { productType: getProductType(sym) }, 'GET', false, tradingMode);
  const exchangeInfo = res && res.data ? res.data.find((s: any) => s.symbol === sym) || null : null;

  // DEBUG: Log para verificar pricePlace y priceEndStep
  if (exchangeInfo && sym === 'ADAUSDT') {
    console.log(`[BITGET DEBUG] ADAUSDT exchangeInfo:`, {
      symbol: exchangeInfo.symbol,
      pricePlace: exchangeInfo.pricePlace,
      priceEndStep: exchangeInfo.priceEndStep,
      tickSize: bitgetGetTickSize(exchangeInfo),
      calculated: `${exchangeInfo.priceEndStep} / 10^${exchangeInfo.pricePlace} = ${exchangeInfo.priceEndStep / Math.pow(10, exchangeInfo.pricePlace)}`
    });
  }

  return exchangeInfo;
};

export const bitgetGetAllAccountBalance = async (tradingMode: 'demo' | 'live' = 'demo') => {
  return bitgetRequest('/api/v2/account/all-account-balance', {}, 'GET', true, tradingMode);
};

export const bitgetGetFuturesAccounts = async (
  productType: 'USDT-FUTURES' | 'USDC-FUTURES' | 'COIN-FUTURES',
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  return bitgetRequest('/api/v2/mix/account/accounts', { productType }, 'GET', true, tradingMode);
};

export const bitgetGetSpotAssets = async (tradingMode: 'demo' | 'live' = 'demo') => {
  return bitgetRequest('/api/v2/spot/account/assets', {}, 'GET', true, tradingMode);
};

export const bitgetGetCommissionRate = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo'): Promise<number> => {
  return getConfiguredTakerFee(symbol, tradingMode);
};

export const bitgetGetMakerCommissionRate = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo'): Promise<number> => {
  return getConfiguredMakerFee(symbol, tradingMode);
};

export const bitgetNormalizeSymbol = (symbol: string): string => {
  let sym = symbol.toUpperCase().replace('/', '').replace('-', '');
  if (sym && !sym.endsWith('USDT') && !sym.endsWith('USDC')) {
    sym += 'USDT';
  }
  return sym;
};

export const formatQuantity = (quantity: number, exchangeInfo: any): string => {
  if (!exchangeInfo) return quantity.toFixed(3);

  const minSize = parseFloat(exchangeInfo.minTradeNum || '0.001');

  // Actually Bitget size is typically in coins or contracts depending on the pair.
  const dp = parseInt(exchangeInfo.volumePlace || '3', 10);

  let q = quantity;
  if (q < minSize) q = minSize;

  return q.toFixed(dp);
};
