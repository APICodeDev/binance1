import axios from 'axios';
import crypto from 'crypto';

const BITGET_API_KEY = process.env.BITGET_LIVE_API_KEY || '';
const BITGET_SECRET_KEY = process.env.BITGET_LIVE_SECRET_KEY || '';
const BITGET_PASSPHRASE = process.env.BITGET_LIVE_PASSPHRASE || '';

const BITGET_DEMO_API_KEY = process.env.BITGET_DEMO_API_KEY || '';
const BITGET_DEMO_SECRET_KEY = process.env.BITGET_DEMO_SECRET_KEY || '';
const BITGET_DEMO_PASSPHRASE = process.env.BITGET_DEMO_PASSPHRASE || '';

const BASE_URL = 'https://api.bitget.com';

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
  if (symbol.endsWith('USD')) return symbol.replace('USD','');
  return 'USDT';
};

export const bitgetGetPrice = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo'): Promise<number | false> => {
  const sym = symbol.toUpperCase();
  const res = await bitgetRequest('/api/v2/mix/market/ticker', { symbol: sym, productType: getProductType(sym) }, 'GET', false, tradingMode);
  if (res && res.data && res.data[0] && res.data[0].lastPr) {
    return parseFloat(res.data[0].lastPr);
  }
  return false;
};

export const bitgetPlaceMarketOrder = async (symbol: string, side: 'BUY' | 'SELL', quantity: number, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  return bitgetRequest('/api/v2/mix/order/place-order', {
    symbol: sym,
    productType: getProductType(sym),
    marginMode: 'crossed',
    marginCoin: getMarginCoin(sym),
    side: side.toLowerCase(), // 'buy' or 'sell'
    orderType: 'market',
    size: quantity.toString()
  }, 'POST', true, tradingMode);
};

export const bitgetOrderSuccess = (resp: any) => {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.error) return false;
  if (resp.code !== '00000') return false;
  return true;
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

const mapBitgetPosition = (p: any) => ({
  symbol: p.symbol,
  positionAmt: p.total ?? p.openDelegateSize ?? p.available ?? p.locked ?? '0',
  entryPrice: p.averageOpenPrice ?? p.openPriceAvg ?? p.markPrice ?? '0',
  unRealizedProfit: p.unrealizedPL,
  leverage: p.leverage,
  positionSide: p.holdSide === 'long' ? 'LONG' : (p.holdSide === 'short' ? 'SHORT' : 'BOTH')
});

export const bitgetClosePosition = async (symbol: string, side: 'BUY' | 'SELL', quantity: number, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  
  const res = await bitgetRequest('/api/v2/mix/order/place-order', {
    symbol: sym,
    productType: getProductType(sym),
    marginMode: 'crossed',
    marginCoin: getMarginCoin(sym),
    side: side.toLowerCase(),
    orderType: 'market',
    size: quantity.toString(),
    reduceOnly: 'YES'
  }, 'POST', true, tradingMode);

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
    positions: Array.isArray(resp?.data) ? resp.data.map((p: any) => mapBitgetPosition(p)) : [],
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

export const bitgetPlaceStopMarket = async (symbol: string, side: 'BUY' | 'SELL', stopPrice: number, quantity?: number, tradingMode: 'demo' | 'live' = 'demo') => {
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
    reduceOnly: 'YES'
  };

  if (quantity) {
    params.size = quantity.toString();
  }

  return bitgetRequest('/api/v2/mix/order/place-plan-order', params, 'POST', true, tradingMode);
};

export const bitgetCancelAlgoOrders = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  return bitgetRequest('/api/v2/mix/order/cancel-all-plan-order', {
    productType: getProductType(sym),
    marginCoin: getMarginCoin(sym),
    planType: 'normal_plan'
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
  
  const r2 = await bitgetCancelAlgoOrders(sym, tradingMode);
  return { normal: r1, algo: r2 };
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
  return res && res.data ? res.data.find((s: any) => s.symbol === sym) || null : null;
};

export const bitgetGetCommissionRate = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo'): Promise<number> => {
  return 0.0006; // Standard Bitget Taker fee unless overriden. Bitget V2 API doesn't easily expose individual commission rates via public endpoint.
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
