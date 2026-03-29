// lib/binance.ts
import axios from 'axios';
import crypto from 'crypto';

const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY || '';
const BINANCE_BASE_URL = process.env.BINANCE_BASE_URL || 'https://testnet.binancefuture.com';

const binanceRequest = async (endpoint: string, params: Record<string, any> = {}, method: 'GET' | 'POST' | 'DELETE' = 'GET', signed = false) => {
  if (signed) {
    params.timestamp = Date.now().toString();
    const query = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', BINANCE_SECRET_KEY).update(query).digest('hex');
    params.signature = signature;
  }

  const url = `${BINANCE_BASE_URL}${endpoint}`;
  const query = new URLSearchParams(params).toString();
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (signed) {
    headers['X-MBX-APIKEY'] = BINANCE_API_KEY;
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
    console.error(`Binance API Error: ${method} ${endpoint}`, error.response?.data || error.message);
    return error.response?.data || { error: true, message: error.message };
  }
};

export const binanceGetPrice = async (symbol: string): Promise<number | false> => {
  const response = await binanceRequest('/fapi/v1/ticker/price', { symbol: symbol.toUpperCase() });
  return response?.price ? parseFloat(response.price) : false;
};

export const binancePlaceMarketOrder = async (symbol: string, side: 'BUY' | 'SELL', quantity: number) => {
  return binanceRequest('/fapi/v1/order', {
    symbol: symbol.toUpperCase(),
    side,
    type: 'MARKET',
    quantity,
  }, 'POST', true);
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

export const binanceClosePosition = async (symbol: string, side: 'BUY' | 'SELL', quantity: number) => {
  const sym = symbol.toUpperCase();
  // Attempt 1: with reduceOnly=true
  let resp = await binanceRequest('/fapi/v1/order', {
    symbol: sym,
    side,
    type: 'MARKET',
    quantity,
    reduceOnly: 'true',
  }, 'POST', true);

  if (binanceOrderSuccess(resp)) return resp;

  // Attempt 2: if error -2022, retry without reduceOnly
  if (resp.code === -2022) {
    resp = await binanceRequest('/fapi/v1/order', {
      symbol: sym,
      side,
      type: 'MARKET',
      quantity,
    }, 'POST', true);
  }
  return resp;
};

export const binanceGetPositions = async () => {
  const response = await binanceRequest('/fapi/v2/positionRisk', {}, 'GET', true);
  return Array.isArray(response) && !response.hasOwnProperty('code') ? response : [];
};

export const binanceGetPricePrecision = async (symbol: string): Promise<number> => {
  const response = await binanceRequest('/fapi/v1/exchangeInfo');
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

export const binancePlaceStopMarket = async (symbol: string, side: 'BUY' | 'SELL', stopPrice: number, quantity?: number) => {
  const precision = await binanceGetPricePrecision(symbol);
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

  return binanceRequest('/fapi/v1/algoOrder', params, 'POST', true);
};

export const binanceCancelAlgoOrders = async (symbol: string) => {
  return binanceRequest('/fapi/v1/algoOrder/all', { symbol: symbol.toUpperCase() }, 'DELETE', true);
};

export const binanceCancelAllOrders = async (symbol: string) => {
  const sym = symbol.toUpperCase();
  const r1 = await binanceRequest('/fapi/v1/allOpenOrders', { symbol: sym }, 'DELETE', true);
  const r2 = await binanceCancelAlgoOrders(sym);
  return { normal: r1, algo: r2 };
};

export const binanceGetExchangeInfo = async (symbol: string) => {
  const response = await binanceRequest('/fapi/v1/exchangeInfo');
  return response?.symbols?.find((s: any) => s.symbol === symbol.toUpperCase()) || null;
};

export const formatQuantity = (quantity: number, exchangeInfo: any): string => {
  if (!exchangeInfo) return quantity.toFixed(3);
  const stepSizeFilter = exchangeInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE');
  const stepSize = stepSizeFilter ? parseFloat(stepSizeFilter.stepSize) : 0.001;
  let precision = 0;
  let temp = stepSize;
  while (temp < 1 && temp > 0) {
    temp *= 10;
    precision++;
  }
  const formatted = Math.floor(quantity / stepSize) * stepSize;
  return formatted.toFixed(precision);
};
