import { prisma } from '@/lib/db';
import { notifyPositiveClose } from '@/lib/ntfy';
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
export type PositionManagementMode = 'auto' | 'self' | 'strat' | 'trend';

const SELF_MODE_ALIASES = new Set(['self', 'sefl', 'selft']);
const FIXED_PRICE_MODE_ALIASES = new Set(['fixed']);
const STRAT_MODE_ALIASES = new Set(['strat', 'strategy']);
const TREND_MODE_ALIASES = new Set(['trend']);
const CLOSE_RETRY_DELAYS_MS = [400, 900, 1600];
const ADAPTIVE_MIN_ATR_1H_PERCENT = 0.4;
const ADAPTIVE_CHOP_RANGE_BASE_PERCENT = 1.8;
const ADAPTIVE_CHOP_RANGE_SPREAD_PERCENT = 1.0;
const ADAPTIVE_BREAK_EVEN_BASE_BUFFER_PERCENT = 0.04;
const ADAPTIVE_BREAK_EVEN_QUALITY_BONUS_PERCENT = 0.18;
const ADAPTIVE_BREAK_EVEN_CHOP_PENALTY_PERCENT = 0.08;
const ADAPTIVE_BREAK_EVEN_MIN_PERCENT = 0.16;
const ADAPTIVE_BREAK_EVEN_MAX_PERCENT = 0.38;
const ADAPTIVE_TRAILING_BASE_OFFSET_PERCENT = 0.10;
const ADAPTIVE_TRAILING_QUALITY_BONUS_PERCENT = 0.14;
const ADAPTIVE_TRAILING_MIN_PERCENT = 0.26;
const ADAPTIVE_TRAILING_MAX_PERCENT = 0.62;
const ADAPTIVE_GIVEBACK_BASE_PERCENT = 0.10;
const ADAPTIVE_GIVEBACK_QUALITY_BONUS_PERCENT = 0.14;
const ADAPTIVE_GIVEBACK_CHOP_PENALTY_PERCENT = 0.06;
const ADAPTIVE_GIVEBACK_MIN_PERCENT = 0.08;
const ADAPTIVE_GIVEBACK_MAX_PERCENT = 0.28;
const ADAPTIVE_MIN_NET_LOCKED_PERCENT = 0.03;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizePositionManagementMode(value: unknown): PositionManagementMode {
  const raw = String(value ?? '').trim().toLowerCase();
  if (SELF_MODE_ALIASES.has(raw) || FIXED_PRICE_MODE_ALIASES.has(raw)) {
    return 'self';
  }

  if (STRAT_MODE_ALIASES.has(raw)) {
    return 'strat';
  }

  if (TREND_MODE_ALIASES.has(raw)) {
    return 'trend';
  }

  return 'auto';
}

export function isFixedPriceManagementMode(value: unknown) {
  const raw = String(value ?? '').trim().toLowerCase();
  return FIXED_PRICE_MODE_ALIASES.has(raw);
}

export function isSelfManagedPosition(value: unknown) {
  return normalizePositionManagementMode(value) === 'self';
}

type MarketCandle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type AdaptiveProtectionContext = {
  signedTrend4hPercent: number;
  atr1hPercent: number;
  rangePercent8x15m: number;
  entryPercentile: number;
  pullbackScore: number;
  chopScore: number;
  trendAlignScore: number;
  qualityScore: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function calculateTrueRange(current: MarketCandle, previous: MarketCandle | null) {
  if (!previous) {
    return current.high - current.low;
  }

  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close)
  );
}

function calculateAverageTrueRangePercent(candles: MarketCandle[], period: number) {
  if (candles.length < period) {
    return null;
  }

  const slice = candles.slice(-period);
  const trueRanges = slice.map((candle, index) => {
    const previous = index === 0 ? (candles[candles.length - slice.length - 1] || null) : slice[index - 1];
    return calculateTrueRange(candle, previous);
  });
  const averageTrueRange = trueRanges.reduce((acc, value) => acc + value, 0) / trueRanges.length;
  const referencePrice = slice[slice.length - 1]?.close || 0;

  if (!(referencePrice > 0)) {
    return null;
  }

  return (averageTrueRange / referencePrice) * 100;
}

function calculateEntryPercentile(entryPrice: number, low: number, high: number) {
  const span = high - low;
  if (!(span > 0)) {
    return 0.5;
  }

  return clamp((entryPrice - low) / span, 0, 1);
}

export function buildAdaptiveProtectionContext(params: {
  positionType: string;
  entryPrice: number;
  candles15m: MarketCandle[];
  candles1h: MarketCandle[];
}) {
  const { positionType, entryPrice, candles15m, candles1h } = params;
  if (!(entryPrice > 0) || candles15m.length < 8 || candles1h.length < 5) {
    return null;
  }

  const recent15m = candles15m.slice(-8);
  const rangeHigh = Math.max(...recent15m.map((candle) => candle.high));
  const rangeLow = Math.min(...recent15m.map((candle) => candle.low));
  const rangePercent8x15m = ((rangeHigh - rangeLow) / entryPrice) * 100;
  const entryPercentile = calculateEntryPercentile(entryPrice, rangeLow, rangeHigh);
  const pullbackScore = positionType === 'buy' ? 1 - entryPercentile : entryPercentile;
  const atr1hPercent = calculateAverageTrueRangePercent(candles1h, Math.min(14, candles1h.length));
  const current1hClose = candles1h[candles1h.length - 1]?.close || 0;
  const previous4hClose = candles1h[candles1h.length - 5]?.close || 0;

  if (!(current1hClose > 0) || !(previous4hClose > 0) || atr1hPercent === null) {
    return null;
  }

  const signedTrend4hPercent = ((current1hClose - previous4hClose) / previous4hClose) * 100;
  const trendAlignedPercent = positionType === 'buy' ? signedTrend4hPercent : -signedTrend4hPercent;
  const trendAlignScore = clamp(
    trendAlignedPercent / Math.max(atr1hPercent, ADAPTIVE_MIN_ATR_1H_PERCENT),
    -1,
    1
  );
  const chopScore = clamp(
    (rangePercent8x15m - ADAPTIVE_CHOP_RANGE_BASE_PERCENT) / ADAPTIVE_CHOP_RANGE_SPREAD_PERCENT,
    0,
    1
  );
  const qualityScore = clamp(
    (0.55 * Math.max(0, trendAlignScore)) +
      (0.45 * pullbackScore) -
      (0.50 * chopScore),
    0,
    1
  );

  return {
    signedTrend4hPercent,
    atr1hPercent,
    rangePercent8x15m,
    entryPercentile,
    pullbackScore,
    chopScore,
    trendAlignScore,
    qualityScore,
  } satisfies AdaptiveProtectionContext;
}

export function calculateFeeAwareExitPrice(params: {
  positionType: string;
  entryPrice: number;
  entryCommission: number;
  exitCommission: number;
  netProfitTargetPercent: number;
}) {
  const {
    positionType,
    entryPrice,
    entryCommission,
    exitCommission,
    netProfitTargetPercent,
  } = params;
  const targetRatio = netProfitTargetPercent / 100;

  if (positionType === 'buy') {
    return entryPrice * (1 + entryCommission + targetRatio) / (1 - exitCommission);
  }

  return entryPrice * (1 - entryCommission - targetRatio) / (1 + exitCommission);
}

export function computeAdaptiveProtectionDecision(params: {
  positionType: string;
  entryPrice: number;
  entryCommission: number;
  exitCommission: number;
  effectiveMovePercent: number;
  context: AdaptiveProtectionContext | null;
}) {
  const {
    positionType,
    entryPrice,
    entryCommission,
    exitCommission,
    effectiveMovePercent,
    context,
  } = params;

  if (!context) {
    return null;
  }

  const roundTripFeePercent = (entryCommission + exitCommission) * 100;
  const breakEvenActivationPercent = clamp(
    roundTripFeePercent +
      ADAPTIVE_BREAK_EVEN_BASE_BUFFER_PERCENT +
      (ADAPTIVE_BREAK_EVEN_QUALITY_BONUS_PERCENT * context.qualityScore) -
      (ADAPTIVE_BREAK_EVEN_CHOP_PENALTY_PERCENT * context.chopScore),
    ADAPTIVE_BREAK_EVEN_MIN_PERCENT,
    ADAPTIVE_BREAK_EVEN_MAX_PERCENT
  );
  const trailingActivationPercent = clamp(
    breakEvenActivationPercent +
      ADAPTIVE_TRAILING_BASE_OFFSET_PERCENT +
      (ADAPTIVE_TRAILING_QUALITY_BONUS_PERCENT * context.qualityScore),
    ADAPTIVE_TRAILING_MIN_PERCENT,
    ADAPTIVE_TRAILING_MAX_PERCENT
  );
  const givebackPercent = clamp(
    ADAPTIVE_GIVEBACK_BASE_PERCENT +
      (ADAPTIVE_GIVEBACK_QUALITY_BONUS_PERCENT * context.qualityScore) -
      (ADAPTIVE_GIVEBACK_CHOP_PENALTY_PERCENT * context.chopScore),
    ADAPTIVE_GIVEBACK_MIN_PERCENT,
    ADAPTIVE_GIVEBACK_MAX_PERCENT
  );

  if (effectiveMovePercent >= trailingActivationPercent) {
    const lockedNetPercent = Math.max(
      ADAPTIVE_MIN_NET_LOCKED_PERCENT,
      effectiveMovePercent - givebackPercent - roundTripFeePercent
    );

    return {
      reason: 'trailing' as const,
      stopPrice: calculateFeeAwareExitPrice({
        positionType,
        entryPrice,
        entryCommission,
        exitCommission,
        netProfitTargetPercent: lockedNetPercent,
      }),
      lockedNetPercent,
      breakEvenActivationPercent,
      trailingActivationPercent,
      givebackPercent,
      context,
    };
  }

  if (effectiveMovePercent >= breakEvenActivationPercent) {
    return {
      reason: 'break_even' as const,
      stopPrice: calculateFeeAwareExitPrice({
        positionType,
        entryPrice,
        entryCommission,
        exitCommission,
        netProfitTargetPercent: ADAPTIVE_MIN_NET_LOCKED_PERCENT,
      }),
      lockedNetPercent: ADAPTIVE_MIN_NET_LOCKED_PERCENT,
      breakEvenActivationPercent,
      trailingActivationPercent,
      givebackPercent,
      context,
    };
  }

  return null;
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

function snapshotHasOpenPosition(snapshot: Awaited<ReturnType<typeof bitgetGetSinglePosition>>, symbol: string) {
  const normalizedSymbol = symbol.toUpperCase();
  return snapshot.positions.some((rp: any) =>
    String(rp?.symbol || '').toUpperCase() === normalizedSymbol &&
    Number.parseFloat(String(rp?.positionAmt || '0')) !== 0
  );
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
  const entryComm = exitComm;
  const positionMode = await bitgetGetPositionMode(symbol, tradingMode) || 'one_way_mode';
  const positionContext = bitgetBuildPositionContext(pos.positionType as 'buy' | 'sell', positionMode);
  let closeResp: any = null;
  let lastVerifyErrors: string[] = [];
  let lastConfirmedStillOpen = false;
  let verifiedClosed = false;

  for (let attempt = 0; attempt <= CLOSE_RETRY_DELAYS_MS.length; attempt += 1) {
    await bitgetCancelAllOrders(symbol, tradingMode);

    const flashResp = await bitgetFlashClosePosition(symbol, positionContext.flashCloseHoldSide, tradingMode);
    closeResp = flashResp;

    if (!bitgetOrderSuccess(flashResp)) {
      const marketResp = await bitgetClosePosition(
        symbol,
        positionContext.closeSide,
        pos.quantity,
        tradingMode,
        positionContext.closeTradeSide
      );
      closeResp = marketResp;
    }

    await bitgetCancelAllOrders(symbol, tradingMode);

    let attemptConfirmedStillOpen = false;
    let attemptVerifyErrors: string[] = [];

    for (const verifyDelayMs of [150, 450, 900, 1400]) {
      if (verifyDelayMs > 0) {
        await sleep(verifyDelayMs);
      }

      const verifySnapshot = await bitgetGetSinglePosition(symbol, tradingMode);
      if (!verifySnapshot.ok) {
        attemptVerifyErrors = verifySnapshot.errors;
        continue;
      }

      const stillOpen = snapshotHasOpenPosition(verifySnapshot, symbol);
      if (!stillOpen) {
        verifiedClosed = true;
        break;
      }

      attemptConfirmedStillOpen = true;
      attemptVerifyErrors = [];
    }

    if (verifiedClosed) {
      break;
    }

    lastVerifyErrors = attemptVerifyErrors;
    lastConfirmedStillOpen = attemptConfirmedStillOpen;

    if (attempt < CLOSE_RETRY_DELAYS_MS.length) {
      await sleep(CLOSE_RETRY_DELAYS_MS[attempt]);
    }
  }

  if (!verifiedClosed) {
    if (lastConfirmedStillOpen) {
      return {
        ok: false,
        status: bitgetOrderSuccess(closeResp) ? 409 : 500,
        message: bitgetOrderSuccess(closeResp)
          ? `Position still open on Bitget after ${CLOSE_RETRY_DELAYS_MS.length + 1} close attempts`
          : 'Bitget close failed and the position is still open on exchange',
        details: closeResp,
      };
    }

    const closeDetailsFromHistory = await resolveBitgetCloseExecution({
      position: pos,
      tradingMode,
      targetTime: new Date(),
      fallbackExitPrice: currentPrice,
      knownCloseResp: closeResp,
      fallbackReason: 'manual',
    });

    if (!closeDetailsFromHistory) {
      return {
        ok: false,
        status: 502,
        message: 'Bitget close verification failed after repeated attempts',
        details: lastVerifyErrors.length > 0 ? lastVerifyErrors : closeResp,
      };
    }
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

  await notifyPositiveClose({
    symbol,
    tradingMode,
    profitFiat: metrics.profitFiat,
    profitPercent: metrics.profitPercent,
  }).catch((error) => {
    console.error('Failed to send positive close ntfy notification', error);
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
