import { prisma } from '@/lib/db';
import {
  bitgetCancelAllOrders,
  bitgetClosePosition,
  bitgetFlashClosePosition,
  bitgetGetCommissionRate,
  bitgetGetPrice,
  bitgetGetSinglePosition,
  bitgetOrderSuccess,
} from '@/lib/bitget';

export type TradingMode = 'demo' | 'live';
export type PositionManagementMode = 'auto' | 'self';

const SELF_MODE_ALIASES = new Set(['self', 'sefl', 'selft']);

export function normalizePositionManagementMode(value: unknown): PositionManagementMode {
  const raw = String(value ?? '').trim().toLowerCase();
  return SELF_MODE_ALIASES.has(raw) ? 'self' : 'auto';
}

export function isSelfManagedPosition(value: unknown) {
  return normalizePositionManagementMode(value) === 'self';
}

type CloseablePosition = {
  id: number;
  symbol: string;
  positionType: string;
  quantity: number;
  entryPrice: number;
  tradingMode?: string | null;
  commission?: number | null;
};

type ClosePositionResult =
  | {
      ok: true;
      symbol: string;
      tradingMode: TradingMode;
      profitPercent: number;
      profitFiat: number;
    }
  | {
      ok: false;
      status: number;
      message: string;
      details?: unknown;
    };

export async function closeTrackedPosition(pos: CloseablePosition): Promise<ClosePositionResult> {
  const tradingMode = ((pos.tradingMode || 'demo') as TradingMode);
  const symbol = pos.symbol.toUpperCase();

  const currentPrice = await bitgetGetPrice(symbol, tradingMode);
  if (!currentPrice) {
    return { ok: false, status: 500, message: 'Failed to fetch price' };
  }

  const exitComm = await bitgetGetCommissionRate(symbol, tradingMode);
  const entryComm = pos.commission ?? exitComm;
  const closeSide = pos.positionType === 'buy' ? 'SELL' : 'BUY';
  const holdSide = pos.positionType === 'buy' ? 'long' : 'short';

  await bitgetCancelAllOrders(symbol, tradingMode);

  let closeResp = await bitgetFlashClosePosition(symbol, holdSide, tradingMode);
  if (!bitgetOrderSuccess(closeResp)) {
    closeResp = await bitgetClosePosition(symbol, closeSide, pos.quantity, tradingMode);
  }

  await bitgetCancelAllOrders(symbol, tradingMode);

  if (!bitgetOrderSuccess(closeResp)) {
    return { ok: false, status: 500, message: 'Bitget close failed', details: closeResp };
  }

  const verifySnapshot = await bitgetGetSinglePosition(symbol, tradingMode);
  if (!verifySnapshot.ok) {
    return { ok: false, status: 502, message: 'Bitget close verification failed', details: verifySnapshot.errors };
  }

  const stillOpen = verifySnapshot.positions.some((rp: any) => rp.symbol && parseFloat(rp.positionAmt) !== 0);
  if (stillOpen) {
    return { ok: false, status: 409, message: 'Position still open on Bitget after close attempt', details: closeResp };
  }

  const entryCost = pos.entryPrice * pos.quantity * entryComm;
  const exitCost = currentPrice * pos.quantity * exitComm;

  const profitFiat = pos.positionType === 'buy'
    ? ((currentPrice - pos.entryPrice) * pos.quantity) - entryCost - exitCost
    : ((pos.entryPrice - currentPrice) * pos.quantity) - entryCost - exitCost;

  const profitPercent = pos.positionType === 'buy'
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

  await prisma.position.update({
    where: { id: pos.id },
    data: {
      status: 'closed',
      closedAt: new Date(),
      profitLossPercent: profitPercent,
      profitLossFiat: profitFiat,
    },
  });

  return {
    ok: true,
    symbol,
    tradingMode,
    profitPercent,
    profitFiat,
  };
}
