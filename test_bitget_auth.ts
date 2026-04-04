import axios from 'axios';
import crypto from 'crypto';

const BITGET_DEMO_API_KEY = 'bg_f4dfdf3db1843034062f758ebbbca580';
const BITGET_DEMO_SECRET_KEY = '07be1d0893222151c2bd2836f335cb757e0d3fa1a21b83075edba9d7d3430ae4';
const BITGET_DEMO_PASSPHRASE = '12345678901234567890123456789012';

async function bitgetRequest(key: string, secret: string, phrase: string, baseUrl: string, endpoint: string, method: 'GET' | 'POST' = 'GET', params: any = {}) {
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
  const signature = crypto.createHmac('sha256', secret).update(prehash).digest('base64');
  
  const headers = {
    'ACCESS-KEY': key,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': phrase,
    'Content-Type': 'application/json',
    'X-SIMULATED-TRADING': '1' // trying simulated trading header, paptrading? Let's add both.
  };

  const url = `${baseUrl}${requestPath}`;
  
  try {
    const res = await axios({
      method,
      url,
      headers: { ...headers, paptrading: '1' },
      data: method === 'POST' ? bodyStr : undefined
    });
    console.log(`Success ${baseUrl} ${endpoint}:`, res.data);
    return res.data;
  } catch (error: any) {
    console.error(`Error ${baseUrl} ${endpoint}:`, error.response?.data || error.message);
  }
}

async function run() {
  console.log('Testing DEMO with paptrading header');
  await bitgetRequest(BITGET_DEMO_API_KEY, BITGET_DEMO_SECRET_KEY, BITGET_DEMO_PASSPHRASE, 'https://api.bitget.com', '/api/v2/mix/position/all-position', 'GET', { productType: 'usdt-futures', marginCoin: 'USDT' });
}
run();
