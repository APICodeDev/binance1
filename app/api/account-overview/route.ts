export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/apiResponse';
import { requireRole } from '@/lib/auth';
import {
  bitgetGetAllAccountBalance,
  bitgetGetFuturesAccounts,
  bitgetGetSpotAssets,
  bitgetOrderSuccess,
} from '@/lib/bitget';

type TradingMode = 'demo' | 'live';

const parseNumber = (value: unknown) => {
  const parsed = Number.parseFloat(String(value ?? '0'));
  return Number.isFinite(parsed) ? parsed : 0;
};

const mapFuturesAccounts = (items: any[] | undefined) =>
  (Array.isArray(items) ? items : []).map((item: any) => ({
    marginCoin: item.marginCoin || '-',
    available: parseNumber(item.available),
    locked: parseNumber(item.locked),
    accountEquity: parseNumber(item.accountEquity ?? item.usdtEquity ?? item.equity),
    unrealizedPnl: parseNumber(item.unrealizedPL ?? item.unrealizedPnl),
    crossedMaxAvailable: parseNumber(item.crossedMaxAvailable),
    maxOpenPosAvailable: parseNumber(item.maxOpenPosAvailable),
  }));

const mapSpotAssets = (items: any[] | undefined) =>
  (Array.isArray(items) ? items : [])
    .map((item: any) => ({
      coin: item.coinName || item.coin || '-',
      available: parseNumber(item.available),
      frozen: parseNumber(item.frozen),
      total: parseNumber(item.available) + parseNumber(item.frozen),
    }))
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

async function loadModeOverview(tradingMode: TradingMode) {
  const [allBalanceResp, usdtResp, usdcResp, coinResp, spotResp] = await Promise.all([
    bitgetGetAllAccountBalance(tradingMode),
    bitgetGetFuturesAccounts('USDT-FUTURES', tradingMode),
    bitgetGetFuturesAccounts('USDC-FUTURES', tradingMode),
    bitgetGetFuturesAccounts('COIN-FUTURES', tradingMode),
    bitgetGetSpotAssets(tradingMode),
  ]);

  const allAccounts = bitgetOrderSuccess(allBalanceResp) ? (allBalanceResp.data || []) : [];
  const summaryFromAllAccounts = (Array.isArray(allAccounts) ? allAccounts : []).map((item: any) => ({
    accountType: item.accountType || '-',
    usdtBalance: parseNumber(item.usdtBalance),
    btcBalance: parseNumber(item.btcBalance),
  }));
  const usdtFutures = mapFuturesAccounts(usdtResp?.data);
  const fallbackSummary = usdtFutures.length > 0 ? [{
    accountType: 'USDT-FUTURES',
    usdtBalance: usdtFutures.reduce((sum, item) => sum + item.accountEquity, 0),
    btcBalance: 0,
  }] : [];
  const summaryHasValue = summaryFromAllAccounts.some((item) => item.usdtBalance > 0 || item.btcBalance > 0);
  const summary = summaryHasValue ? summaryFromAllAccounts : fallbackSummary;

  return {
    summary,
    futures: {
      usdt: usdtFutures,
      usdc: mapFuturesAccounts(usdcResp?.data),
      coin: mapFuturesAccounts(coinResp?.data),
    },
    spotAssets: mapSpotAssets(spotResp?.data),
    rawStatus: {
      allAccountBalance: bitgetOrderSuccess(allBalanceResp),
      usdtFutures: bitgetOrderSuccess(usdtResp),
      usdcFutures: bitgetOrderSuccess(usdcResp),
      coinFutures: bitgetOrderSuccess(coinResp),
      spotAssets: bitgetOrderSuccess(spotResp),
    },
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin']);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const [demo, live] = await Promise.all([
      loadModeOverview('demo'),
      loadModeOverview('live'),
    ]);

    return ok({
      demo,
      live,
      fetchedAt: new Date().toISOString(),
    }, 'Account overview loaded');
  } catch (error: any) {
    return fail(500, error?.message || 'Unable to load Bitget account overview');
  }
}
