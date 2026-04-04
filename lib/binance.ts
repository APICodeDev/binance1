// lib/binance.ts
import axios from 'axios';
import crypto from 'crypto';

const BINANCE_DEMO_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_DEMO_SECRET_KEY = process.env.BINANCE_SECRET_KEY || '';
const BINANCE_DEMO_BASE_URL = process.env.BINANCE_BASE_URL || 'https://testnet.binancefuture.com';

const BINANCE_LIVE_API_KEY = process.env.BINANCE_LIVE_API_KEY || '';
const BINANCE_LIVE_SECRET_KEY = process.env.BINANCE_LIVE_SECRET_KEY || '';
const BINANCE_LIVE_BASE_URL = process.env.BINANCE_LIVE_BASE_URL || 'https://fapi.binance.com';

const binanceRequest = async (
  endpoint: string, 
  params: Record<string, any> = {}, 
  method: 'GET' | 'POST' | 'DELETE' = 'GET', 
  signed = false,
  tradingMode: 'demo' | 'live' = 'demo'
) => {
  const apiKey = tradingMode === 'live' ? BINANCE_LIVE_API_KEY : BINANCE_DEMO_API_KEY;
  const secretKey = tradingMode === 'live' ? BINANCE_LIVE_SECRET_KEY : BINANCE_DEMO_SECRET_KEY;
  const baseUrl = tradingMode === 'live' ? BINANCE_LIVE_BASE_URL : BINANCE_DEMO_BASE_URL;

  if (signed) {
    params.timestamp = Date.now().toString();
    const query = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', secretKey).update(query).digest('hex');
    params.signature = signature;
  }

  const url = `${baseUrl}${endpoint}`;
  const query = new URLSearchParams(params).toString();
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (signed) {
    headers['X-MBX-APIKEY'] = apiKey;
  }

  try {
    const response = await axios({
      method,
      url: method === 'GET' ? `${url}?${query}` : url,
      data: method !== 'GET' ? query : undefined,
      headers,
      timeout: 15000,
    });
    return response.data;
  } catch (error: any) {
    console.error(`Binance API Error (${tradingMode}): ${method} ${endpoint}`, error.response?.data || error.message);
    return error.response?.data || { error: true, message: error.message };
  }
};

export const binanceGetPrice = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo'): Promise<number | false> => {
  const response = await binanceRequest('/fapi/v1/ticker/price', { symbol: symbol.toUpperCase() }, 'GET', false, tradingMode);
  return response?.price ? parseFloat(response.price) : false;
};

export const binancePlaceMarketOrder = async (symbol: string, side: 'BUY' | 'SELL', quantity: number, tradingMode: 'demo' | 'live' = 'demo') => {
  return binanceRequest('/fapi/v1/order', {
    symbol: symbol.toUpperCase(),
    side,
    type: 'MARKET',
    quantity,
  }, 'POST', true, tradingMode);
};

export const binanceOrderSuccess = (resp: any) => {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.error) return false;
  if (resp.code && resp.code < 0) return false;
  if (resp.orderId || resp.algoId) return true;
  const okStatuses = ['FILLED', 'NEW', 'PARTIALLY_FILLED', 'EXECUTING'];
  if (resp.status && okStatuses.includes(resp.status)) return true;
  return false;
};

export const binanceClosePosition = async (symbol: string, side: 'BUY' | 'SELL', quantity: number, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  // Attempt 1: with reduceOnly=true
  let resp = await binanceRequest('/fapi/v1/order', {
    symbol: sym,
    side,
    type: 'MARKET',
    quantity,
    reduceOnly: 'true',
  }, 'POST', true, tradingMode);

  if (binanceOrderSuccess(resp)) return resp;

  // Attempt 2: if error -2022, retry without reduceOnly
  if (resp.code === -2022) {
    resp = await binanceRequest('/fapi/v1/order', {
      symbol: sym,
      side,
      type: 'MARKET',
      quantity,
    }, 'POST', true, tradingMode);
  }
  return resp;
};

export const binanceGetPositions = async (tradingMode: 'demo' | 'live' = 'demo') => {
  const response = await binanceRequest('/fapi/v2/positionRisk', {}, 'GET', true, tradingMode);
  return Array.isArray(response) && !response.hasOwnProperty('code') ? response : [];
};

export const binanceGetPricePrecision = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo'): Promise<number> => {
  const response = await binanceRequest('/fapi/v1/exchangeInfo', {}, 'GET', false, tradingMode);
  if (response?.symbols) {
    const s = response.symbols.find((s: any) => s.symbol === symbol.toUpperCase());
    if (s) {
      const filter = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
      if (filter) {
        let tickSize = parseFloat(filter.tickSize);
        let precision = 0;
        while (tickSize < 1 && tickSize > 0) {
          tickSize *= 10;
          precision++;
        }
        return precision;
      }
    }
  }
  return 2;
};

export const binancePlaceStopMarket = async (symbol: string, side: 'BUY' | 'SELL', stopPrice: number, quantity?: number, tradingMode: 'demo' | 'live' = 'demo') => {
  const precision = await binanceGetPricePrecision(symbol, tradingMode);
  const params: any = {
    symbol: symbol.toUpperCase(),
    side,
    algoType: 'CONDITIONAL',
    type: 'STOP_MARKET',
    triggerPrice: stopPrice.toFixed(precision),
    reduceOnly: 'true',
  };
  if (quantity) params.quantity = quantity;
  else params.closePosition = 'true';

  return binanceRequest('/fapi/v1/algoOrder', params, 'POST', true, tradingMode);
};

// Cancel all open algo orders for a symbol
export const binanceCancelAlgoOrders = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  return binanceRequest('/fapi/v1/algoOpenOrders', { symbol: symbol.toUpperCase() }, 'DELETE', true, tradingMode);
};

// Cancel a single algo order by algoId
export const binanceCancelAlgoOrder = async (symbol: string, algoId: number, tradingMode: 'demo' | 'live' = 'demo') => {
  return binanceRequest('/fapi/v1/algoOrder', { symbol: symbol.toUpperCase(), algoId }, 'DELETE', true, tradingMode);
};

export const binanceCancelAllOrders = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const sym = symbol.toUpperCase();
  const r1 = await binanceRequest('/fapi/v1/allOpenOrders', { symbol: sym }, 'DELETE', true, tradingMode);
  const r2 = await binanceCancelAlgoOrders(sym, tradingMode);
  return { normal: r1, algo: r2 };
};

export const binanceGetExchangeInfo = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo') => {
  const response = await binanceRequest('/fapi/v1/exchangeInfo', {}, 'GET', false, tradingMode);
  return response?.symbols?.find((s: any) => s.symbol === symbol.toUpperCase()) || null;
};

export const binanceGetCommissionRate = async (symbol: string, tradingMode: 'demo' | 'live' = 'demo'): Promise<number> => {
  const response = await binanceRequest('/fapi/v1/commissionRate', { symbol: symbol.toUpperCase() }, 'GET', true, tradingMode);
  if (response && response.takerCommissionRate) {
    return parseFloat(response.takerCommissionRate);
  }
  return 0.0004; // Default to 0.04% if not found or error
};

export const binanceNormalizeSymbol = (symbol: string): string => {
  let sym = symbol.toUpperCase().replace('/', '').replace('-', '');
  if (sym && !sym.endsWith('USDT') && !sym.endsWith('USDC')) {
    sym += 'USDT';
  }
  return sym;
};

export const formatQuantity = (quantity: number, exchangeInfo: any): string => {
  if (!exchangeInfo) return quantity.toFixed(3);
  
  const lotFilter = exchangeInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE');
  const stepSize = lotFilter ? parseFloat(lotFilter.stepSize) : 0.001;
  const maxQty = lotFilter ? parseFloat(lotFilter.maxQty) : 999999999;
  const minQty = lotFilter ? parseFloat(lotFilter.minQty) : 0;
  
  let q = Math.max(minQty, Math.min(maxQty, quantity));
  
  let precision = 0;
  let temp = stepSize;
  while (temp < 1 && temp > 0) {
    temp *= 10;
    precision++;
  }
  
  const formatted = Math.floor(q / stepSize) * stepSize;
  return formatted.toFixed(precision);
};
