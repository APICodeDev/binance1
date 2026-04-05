import axios from 'axios';
import crypto from 'crypto';

const BITGET_API_KEY = 'bg_d53a4365293c7d6cc13a18ade2455b91';
const BITGET_SECRET_KEY = 'f6c332d83032873ddf3ea5a25e39c4a68e88bd083c50f9bd913f52af73073322';
const BITGET_PASSPHRASE = '12345678901234567890123456789012';
const BASE_URL = 'https://api.bitget.com';

async function bitgetRequest(endpoint: string, method: 'GET' | 'POST' = 'GET', params: any = {}) {
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
  const signature = crypto.createHmac('sha256', BITGET_SECRET_KEY).update(prehash).digest('base64');
  
  const headers = {
    'ACCESS-KEY': BITGET_API_KEY,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': BITGET_PASSPHRASE,
    'Content-Type': 'application/json',
  };

  const url = `${BASE_URL}${requestPath}`;
  
  try {
    const res = await axios({
      method,
      url,
      headers,
      data: method === 'POST' ? bodyStr : undefined
    });
    console.log(`Success ${endpoint}:`, res.data);
    return res.data;
  } catch (error: any) {
    console.error(`Error ${endpoint}:`, error.response?.data || error.message);
  }
}

async function run() {
  await bitgetRequest('/api/v2/mix/market/ticker', 'GET', { symbol: 'SUIUSDT', productType: 'usdt-futures' });
}
run();
