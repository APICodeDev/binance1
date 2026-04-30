import { prisma } from '@/lib/db';
import {
  bitgetBuildPositionContext,
  bitgetCancelAllOrders,
  bitgetClosePosition,
  bitgetFlashClosePosition,
  bitgetGetCommissionRate,
  bitgetGetOrderHistory,
  bitgetGetPlanOrderHistory,
  bitgetGetPositionMode,
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
  createdAt?: Date | null;
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
      exitPrice: number;
      closedAt: Date;
      exitReason: string | null;
    }
  | {
      ok: false;
      status: number;
      message: string;
      details?: unknown;
    };

type CloseExecutionDetails = {
  exitPrice: number;
  closedAt: Date;
  exitOrderId: string | null;
  exitSource: string | null;
  exitReason: string | null;
};

type CloseMetrics = {
  profitPercent: number;
  profitFiat: number;
};

function extractCloseOrderId(closeResp: any) {
  return String(
    closeResp?.data?.orderId ||
    closeResp?.data?.orderIdStr ||
    closeResp?.orderId ||
    ''
  ).trim() || null;
}

export function calculateCloseMetrics(params: {
  positionType: string;
  entryPrice: number;
  quantity: number;
  entryCommission: number;
  exitCommission: number;
  exitPrice: number;
}): CloseMetrics {
  const {
    positionType,
    entryPrice,
    quantity,
    entryCommission,
    exitCommission,
    exitPrice,
  } = params;
  const entryCost = entryPrice * quantity * entryCommission;
  const exitCost = exitPrice * quantity * exitCommission;

  const profitFiat = positionType === 'buy'
    ? ((exitPrice - entryPrice) * quantity) - entryCost - exitCost
    : ((entryPrice - exitPrice) * quantity) - entryCost - exitCost;

  const profitPercent = positionType === 'buy'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;

  return {
    profitPercent,
    profitFiat,
  };
}

export async function resolveBitgetCloseExecution(params: {
  position: CloseablePosition;
  tradingMode: TradingMode;
  targetTime?: Date | null;
  fallbackExitPrice?: number | null;
  knownCloseResp?: any;
  fallbackReason?: string | null;
}) {
  const {
    position,
    tradingMode,
    targetTime,
    fallbackExitPrice,
    knownCloseResp,
    fallbackReason,
  } = params;
  const symbol = position.symbol.toUpperCase();
  const knownOrderId = extractCloseOrderId(knownCloseResp);
  const targetTimestamp = targetTime?.getTime() || Date.now();
  const searchStart = Math.max(
    0,
    (position.createdAt ? position.createdAt.getTime() : targetTimestamp) - (15 * 60 * 1000)
  );
  const searchEnd = Math.max(targetTimestamp + (15 * 60 * 1000), Date.now() + (2 * 60 * 1000));

  const [orderHistoryResp, stopPlanHistoryResp] = await Promise.all([
    bitgetGetOrderHistory(symbol, searchStart, searchEnd, tradingMode).catch(() => null),
    bitgetGetPlanOrderHistory(symbol, 'normal_plan', searchStart, searchEnd, tradingMode).catch(() => null),
  ]);

  const orderHistory = Array.isArray(orderHistoryResp?.data?.entrustedList)
    ? orderHistoryResp.data.entrustedList
    : [];
  const stopPlanHistory = Array.isArray(stopPlanHistoryResp?.data?.entrustedList)
    ? stopPlanHistoryResp.data.entrustedList
    : [];
  const quantityTolerance = Math.max(0.01, position.quantity * 0.02);

  const closeCandidates = orderHistory.filter((order: any) => {
    const isReduceOnly = String(order?.reduceOnly || '') === 'YES';
    const baseVolume = Number.parseFloat(String(order?.baseVolume || '0'));
    return isReduceOnly && Math.abs(baseVolume - position.quantity) <= quantityTolerance;
  });

  const exactOrder = knownOrderId
    ? closeCandidates.find((order: any) => String(order?.orderId || '') === knownOrderId)
    : null;
  const closeOrder = exactOrder || closeCandidates.sort((left: any, right: any) => {
    const leftTime = Math.abs(Number.parseInt(String(left?.cTime || '0'), 10) - targetTimestamp);
    const rightTime = Math.abs(Number.parseInt(String(right?.cTime || '0'), 10) - targetTimestamp);
    return leftTime - rightTime;
  })[0] || null;

  const matchedStopPlan = stopPlanHistory.find((plan: any) => {
    const executeOrderId = String(plan?.executeOrderId || '').trim();
    const orderId = String(closeOrder?.orderId || '').trim();
    const planQty = Number.parseFloat(String(plan?.size || '0'));
    const createdAt = Number.parseInt(String(plan?.cTime || '0'), 10);
    if (executeOrderId && orderId && executeOrderId === orderId) {
      return true;
    }
    return Math.abs(planQty - position.quantity) <= quantityTolerance &&
      Math.abs(createdAt - (position.createdAt?.getTime() || targetTimestamp)) <= 20 * 60 * 1000;
  }) || null;

  const parsedExitPrice = Number.parseFloat(String(closeOrder?.priceAvg || closeOrder?.price || ''));
  const exitPrice = Number.isFinite(parsedExitPrice) && parsedExitPrice > 0
    ? parsedExitPrice
    : fallbackExitPrice || null;
  const closeTimestamp = Number.parseInt(String(closeOrder?.cTime || ''), 10);
  const closedAt = Number.isFinite(closeTimestamp) && closeTimestamp > 0
    ? new Date(closeTimestamp)
    : (targetTime || new Date());
  const inferredReason = fallbackReason ||
    (matchedStopPlan?.planStatus === 'executed' ? 'stop_loss' : null) ||
    (String(closeOrder?.orderSource || '').toLowerCase() === 'plan_market' ? 'exchange_plan' : null);

  if (!exitPrice) {
    return null;
  }

  return {
    exitPrice,
    closedAt,
    exitOrderId: String(closeOrder?.orderId || matchedStopPlan?.executeOrderId || '').trim() || null,
    exitSource: String(closeOrder?.orderSource || '').trim() || null,
    exitReason: inferredReason,
  } satisfies CloseExecutionDetails;
}

export async function closeTrackedPosition(pos: CloseablePosition): Promise<ClosePositionResult> {
  const tradingMode = ((pos.tradingMode || 'demo') as TradingMode);
  const symbol = pos.symbol.toUpperCase();

  const currentPrice = await bitgetGetPrice(symbol, tradingMode);
  if (!currentPrice) {
    return { ok: false, status: 500, message: 'Failed to fetch price' };
  }

  const exitComm = await bitgetGetCommissionRate(symbol, tradingMode);
  const entryComm = pos.commission ?? exitComm;
  const positionMode = await bitgetGetPositionMode(symbol, tradingMode) || 'one_way_mode';
  const positionContext = bitgetBuildPositionContext(pos.positionType as 'buy' | 'sell', positionMode);

  await bitgetCancelAllOrders(symbol, tradingMode);

  let closeResp = await bitgetFlashClosePosition(symbol, positionContext.flashCloseHoldSide, tradingMode);
  if (!bitgetOrderSuccess(closeResp)) {
    closeResp = await bitgetClosePosition(symbol, positionContext.closeSide, pos.quantity, tradingMode, positionContext.closeTradeSide);
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

  const closeDetails = await resolveBitgetCloseExecution({
    position: pos,
    tradingMode,
    targetTime: new Date(),
    fallbackExitPrice: currentPrice,
    knownCloseResp: closeResp,
    fallbackReason: 'manual',
  });
  const execution = closeDetails || {
    exitPrice: currentPrice,
    closedAt: new Date(),
    exitOrderId: extractCloseOrderId(closeResp),
    exitSource: null,
    exitReason: 'manual',
  };
  const metrics = calculateCloseMetrics({
    positionType: pos.positionType,
    entryPrice: pos.entryPrice,
    quantity: pos.quantity,
    entryCommission: entryComm,
    exitCommission: exitComm,
    exitPrice: execution.exitPrice,
  });

  await prisma.position.update({
    where: { id: pos.id },
    data: {
      status: 'closed',
      closedAt: execution.closedAt,
      profitLossPercent: metrics.profitPercent,
      profitLossFiat: metrics.profitFiat,
      exitPrice: execution.exitPrice,
      exitReason: execution.exitReason,
      exitOrderId: execution.exitOrderId,
      exitSource: execution.exitSource,
    } as any,
  });

  return {
    ok: true,
    symbol,
    tradingMode,
    profitPercent: metrics.profitPercent,
    profitFiat: metrics.profitFiat,
    exitPrice: execution.exitPrice,
    closedAt: execution.closedAt,
    exitReason: execution.exitReason,
  };
}
