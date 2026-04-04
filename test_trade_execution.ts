const fs = require('fs');

const envContent = fs.readFileSync('.env', 'utf8');
envContent.split('\n').forEach((line: string) => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
        process.env[match[1]] = match[2].replace(/['"]/g, '').trim();
    }
});

// require AFTER env is set
const { bitgetPlaceMarketOrder, bitgetPlaceStopMarket } = require('./lib/bitget.ts');

async function run() {
  const symbol = 'BTCUSDT';
  const type = 'buy';
  const quantity = 0.001; // Tiny amount

  console.log(`[TEST] Placing Market Order (${type.toUpperCase()}) for ${quantity} ${symbol} in Demo mode...`);
  const orderRes = await bitgetPlaceMarketOrder(symbol, 'BUY', quantity, 'demo');
  console.log('[TEST] Market Order Response JSON:', JSON.stringify(orderRes, null, 2));

  if (orderRes.code === '00000') {
      const execPrice = parseFloat(orderRes.data?.avgPrice || '70000'); 
      const stopLoss = execPrice * 0.98;
      
      console.log(`[TEST] Success. Now placing Stop Market at ${stopLoss.toFixed(2)}...`);
      const slRes = await bitgetPlaceStopMarket(symbol, 'SELL', stopLoss, quantity, 'demo');
      console.log('[TEST] SL Response JSON:', JSON.stringify(slRes, null, 2));
      
      if (slRes.code === '00000') {
          console.log('[TEST] DONE! Both Entry and StopLoss orders executed correctly.');
      } else {
          console.log(`[TEST] Failed to place StopLoss. ${slRes.msg || slRes.message}`);
      }
  } else {
      console.log(`[TEST] Failed to place Market Order. ${orderRes.msg || orderRes.message}`);
  }
}

run();
