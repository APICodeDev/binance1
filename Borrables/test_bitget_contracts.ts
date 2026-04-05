import axios from 'axios';
import crypto from 'crypto';

const BITGET_DEMO_API_KEY = 'bg_f4dfdf3db1843034062f758ebbbca580';
const BITGET_DEMO_SECRET_KEY = '07be1d0893222151c2bd2836f335cb757e0d3fa1a21b83075edba9d7d3430ae4';
const BITGET_DEMO_PASSPHRASE = '12345678901234567890123456789012';

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
  const signature = crypto.createHmac('sha256', BITGET_DEMO_SECRET_KEY).update(prehash).digest('base64');
  
  const headers = {
    'ACCESS-KEY': BITGET_DEMO_API_KEY,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': BITGET_DEMO_PASSPHRASE,
    'Content-Type': 'application/json',
    'paptrading': '1'
  };

  const url = `https://api.bitget.com${requestPath}`;
  
  try {
    const res = await axios({
      method,
      url,
      headers,
      data: method === 'POST' ? bodyStr : undefined
    });
    return res.data;
  } catch (error: any) {
    console.error(`Error ${endpoint}:`, error.response?.data || error.message);
  }
}

async function run() {
  const res = await bitgetRequest('/api/v2/mix/market/contracts', 'GET', { productType: 'usdt-futures' });
  if (res && res.data) {
    console.log(res.data.slice(0, 2).map((x: any) => x.symbol));
    const sui = res.data.find((x: any) => x.symbol.includes('SUI'));
    console.log('SUI symbol info:', sui);
  }
}
run();
