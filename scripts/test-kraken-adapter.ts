import assert from 'node:assert/strict';
import { createKrakenFuturesSignature, krakenBuildPositionContext, krakenNormalizeSymbol, krakenOrderSuccess } from '@/lib/kraken';

assert.equal(krakenNormalizeSymbol('PF_XBTUSD'), 'BTCUSDT');
assert.equal(krakenNormalizeSymbol('BTC/USDT'), 'BTCUSDT');
assert.equal(krakenNormalizeSymbol('ETHUSD'), 'ETHUSDT');

const signature = createKrakenFuturesSignature('/derivatives/api/v3/sendorder', 'symbol=PF_XBTUSD&side=buy', '1700000000000', Buffer.from('test-secret').toString('base64'));
assert.match(signature, /^[A-Za-z0-9+/]+=*$/);
assert.equal(signature.length, 88);

assert.deepEqual(krakenBuildPositionContext('buy', 'one_way_mode'), {
  openSide: 'BUY', closeSide: 'SELL', holdSide: 'long', leverageHoldSide: 'long', openTradeSide: undefined, closeTradeSide: undefined, flashCloseHoldSide: 'long',
});
assert.equal(krakenOrderSuccess({ result: 'success' }), true);
assert.equal(krakenOrderSuccess({ result: 'error' }), false);

console.log('Kraken adapter offline tests passed');
