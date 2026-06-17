import http, { ServerResponse } from 'http';
import { Position } from '@prisma/client';
import { prisma } from '@/lib/db';
import { writeAuditLog } from '@/lib/audit';
import { notifyAllActiveDevices } from '@/lib/pushNotifications';
import { notifyPositiveClose } from '@/lib/ntfy';
import {
  bitgetBuildPositionContext,
  bitgetCancelAllOrders,
  bitgetClosePosition,
  bitgetEnsureVerifiedStopOrder,
  getDefaultBitgetFeeRate,
  bitgetGetHistoricalCandles,
  bitgetGetPositionMode,
  bitgetGetPrice,
  bitgetGetPositions,
  bitgetGetSinglePosition,
  bitgetOrderSuccess,
} from '@/lib/bitget';
import {
  AdaptiveProtectionContext,
  buildAdaptiveProtectionContext,
  calculateCloseMetrics,
  computeAdaptiveProtectionDecision,
  inferPositionCloseOrigin,
  isFixedPriceManagementMode,
  normalizePositionManagementMode,
  resolveBitgetCloseExecution,
} from '@/lib/positions';

type TradingMode = 'demo' | 'live';

type MarketSnapshot = {
  symbol: string;
  tradingMode: TradingMode;
  bestBid: number | null;
  bestAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  lastPrice: number | null;
  markPrice: number | null;
  timestamp: number;
  source: 'websocket';
};

type MarketEventPayload = {
  channel: 'books1' | 'ticker';
  snapshot: MarketSnapshot;
};

type EngineSubscriber = {
  id: number;
  res: ServerResponse;
};

type PositionMarketUpdate = {
  positionId: number;
  symbol: string;
  tradingMode: TradingMode;
  price: number;
  priceSource: 'mark_price' | 'last_price' | 'mid_price';
  profitPercent: number;
  profitFiat: number;
  stopLoss: number;
  takeProfit: number | null;
  candidateStopLoss: number | null;
  canImproveStop: boolean;
  managementMode: 'auto' | 'self' | 'strat' | 'trend';
  stratBreakEvenEnabled: boolean;
  stratTrailingEnabled: boolean;
  eventTimestamp: number;
};

type EngineSettings = {
  exhaustionGuardEnabled: boolean;
  takeProfitAutoCloseEnabled: boolean;
};

const HOST = process.env.TRADE_ENGINE_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.TRADE_ENGINE_PORT || '8789', 10);
const MARKETDATA_URL = (process.env.BITGET_WS_SERVICE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const POSITION_REFRESH_MS = Number.parseInt(process.env.TRADE_ENGINE_POSITION_REFRESH_MS || '3000', 10);
const SETTINGS_REFRESH_MS = Number.parseInt(process.env.TRADE_ENGINE_SETTINGS_REFRESH_MS || '5000', 10);
const MARKET_STREAM_RECONNECT_MS = Number.parseInt(process.env.TRADE_ENGINE_MARKET_STREAM_RECONNECT_MS || '2000', 10);
const STOP_SYNC_COOLDOWN_MS = Number.parseInt(process.env.TRADE_ENGINE_STOP_COOLDOWN_MS || '1200', 10);
const POSITION_PERSIST_COOLDOWN_MS = Number.parseInt(process.env.TRADE_ENGINE_POSITION_PERSIST_COOLDOWN_MS || '2000', 10);
const EXHAUSTION_MIN_MFE_PERCENT = 1.0;
const EXHAUSTION_MIN_STAGNATION_MS = 90 * 60 * 1000;
const EXHAUSTION_MIN_RETRACEMENT_RATIO = 0.35;
const EXHAUSTION_FLAT_MIN_MFE_PERCENT = 1.5;
const EXHAUSTION_FLAT_MIN_PROFIT_PERCENT = 1.0;
const EXHAUSTION_FLAT_MIN_STAGNATION_MS = 120 * 60 * 1000;
const EXHAUSTION_FLAT_MAX_GIVEBACK_PERCENT = 0.25;

const marketSnapshots = new Map<string, MarketSnapshot>();
const openPositions = new Map<number, Position>();
const positionsByMarketKey = new Map<string, Set<number>>();
const watchedMarketKeys = new Set<string>();
const adaptiveContextByPosition = new Map<number, AdaptiveProtectionContext | null>();
const adaptiveContextPromiseByPosition = new Map<number, Promise<AdaptiveProtectionContext | null>>();
const engineSubscribers = new Map<number, EngineSubscriber>();
const positionLocks = new Set<number>();
const lastPersistAtByPosition = new Map<number, number>();
const lastStopSyncAtByPosition = new Map<number, number>();
let nextSubscriberId = 1;
let lastReloadAt: number | null = null;
let lastMarketEventAt: number | null = null;
let lastSettingsReloadAt: number | null = null;
let lastWarning: string | null = null;
let engineSettings: EngineSettings = {
  exhaustionGuardEnabled: true,
  takeProfitAutoCloseEnabled: false,
};

const makeMarketKey = (tradingMode: TradingMode, symbol: string) => `${tradingMode}:${symbol.toUpperCase()}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const writeSse = (res: ServerResponse, event: string, payload: unknown) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const emitEngineEvent = (event: string, payload: unknown) => {
  for (const subscriber of Array.from(engineSubscribers.values())) {
    writeSse(subscriber.res, event, payload);
  }
};

const getSelfManagedTrailingStep = (marketMovePercent: number) => {
  if (marketMovePercent < 1.25) {
    return null;
  }

  const lockedPercent = Math.floor((marketMovePercent - 0.25) + 1e-9);
  return lockedPercent >= 1 ? lockedPercent : null;
};

const getPositionCommission = (position: Position) => {
  const tradingMode = ((position as any).tradingMode || 'demo') as TradingMode;
  return getDefaultBitgetFeeRate(tradingMode);
};

const resolveLivePrice = (snapshot: MarketSnapshot) => {
  if (snapshot.markPrice !== null && snapshot.markPrice > 0) {
    return { price: snapshot.markPrice, source: 'mark_price' as const };
  }

  if (snapshot.lastPrice !== null && snapshot.lastPrice > 0) {
    return { price: snapshot.lastPrice, source: 'last_price' as const };
  }

  if (snapshot.bestBid !== null && snapshot.bestAsk !== null && snapshot.bestBid > 0 && snapshot.bestAsk > 0) {
    return { price: (snapshot.bestBid + snapshot.bestAsk) / 2, source: 'mid_price' as const };
  }

  return null;
};

const updateCachedPosition = (positionId: number, patch: Partial<Position>) => {
  const current = openPositions.get(positionId);
  if (!current) {
    return;
  }

  openPositions.set(positionId, {
    ...current,
    ...patch,
  });
};

const isStratBreakEvenActive = (position: Position) => {
  const managementMode = normalizePositionManagementMode(position.managementMode);
  return managementMode === 'strat' || Boolean((position as any).stratBreakEvenEnabled);
};

const isStratTrailingActive = (position: Position) => {
  const managementMode = normalizePositionManagementMode(position.managementMode);
  return managementMode === 'strat' || Boolean((position as any).stratTrailingEnabled);
};

const removeOpenPosition = (position: Position) => {
  openPositions.delete(position.id);
  const marketKey = makeMarketKey(((position as any).tradingMode || 'demo') as TradingMode, position.symbol);
  const ids = positionsByMarketKey.get(marketKey);
  if (ids) {
    ids.delete(position.id);
    if (ids.size === 0) {
      positionsByMarketKey.delete(marketKey);
    }
  }

  positionLocks.delete(position.id);
  lastPersistAtByPosition.delete(position.id);
  lastStopSyncAtByPosition.delete(position.id);
  adaptiveContextByPosition.delete(position.id);
  adaptiveContextPromiseByPosition.delete(position.id);
};

const loadAdaptiveContextForPosition = async (position: Position) => {
  const cached = adaptiveContextByPosition.get(position.id);
  if (typeof cached !== 'undefined') {
    return cached;
  }

  const pending = adaptiveContextPromiseByPosition.get(position.id);
  if (pending) {
    return pending;
  }

  const createdAtMs = new Date(position.createdAt).getTime();
  const tradingMode = ((position as any).tradingMode || 'demo') as TradingMode;
  const promise = Promise.all([
    bitgetGetHistoricalCandles(position.symbol, '15m', 8, tradingMode, createdAtMs).catch(() => ({ ok: false as const, error: '15m history failed' })),
    bitgetGetHistoricalCandles(position.symbol, '1H', 20, tradingMode, createdAtMs).catch(() => ({ ok: false as const, error: '1H history failed' })),
  ])
    .then(([candles15m, candles1h]) => {
      if (!candles15m.ok || !candles1h.ok) {
        return null;
      }

      return buildAdaptiveProtectionContext({
        positionType: position.positionType,
        entryPrice: position.entryPrice,
        candles15m: candles15m.candles,
        candles1h: candles1h.candles,
      });
    })
    .catch(() => null)
    .finally(() => {
      adaptiveContextPromiseByPosition.delete(position.id);
    });

  adaptiveContextPromiseByPosition.set(position.id, promise);
  const resolved = await promise;
  adaptiveContextByPosition.set(position.id, resolved);
  return resolved;
};

const computeCandidateStopLoss = (position: Position, currentPrice: number, adaptiveContext: AdaptiveProtectionContext | null) => {
  const managementMode = normalizePositionManagementMode(position.managementMode);
  const stratBreakEvenEnabled = isStratBreakEvenActive(position);
  const stratTrailingEnabled = isStratTrailingActive(position);
  const trendManaged = managementMode === 'trend';
  const effectiveSelfManaged = managementMode === 'self' || (managementMode === 'strat' && stratTrailingEnabled);
  const stratBreakEvenOnlyEnabled = managementMode === 'strat' && stratBreakEvenEnabled && !stratTrailingEnabled;
  const autoManaged = managementMode === 'auto';
  const commission = getPositionCommission(position);
  const marketMovePercent = position.positionType === 'buy'
    ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  const historicalMaxProfitPercent = Math.max(0, Number((position as any).maxProfitPercent || 0));
  const effectiveMovePercent = Math.max(marketMovePercent, historicalMaxProfitPercent);
  if (trendManaged) {
    if (position.positionType === 'buy') {
      return effectiveMovePercent > 1
        ? position.entryPrice * (1 + commission) / (1 - commission)
        : null;
    }

    return effectiveMovePercent > 1
      ? position.entryPrice * (1 - commission) / (1 + commission)
      : null;
  }

  const adaptiveProtection = computeAdaptiveProtectionDecision({
    positionType: position.positionType,
    entryPrice: position.entryPrice,
    entryCommission: commission,
    exitCommission: commission,
    effectiveMovePercent,
    context: adaptiveContext,
  });

  if (adaptiveProtection) {
    return adaptiveProtection.stopPrice;
  }

  if (position.positionType === 'buy') {
    if (effectiveSelfManaged) {
      const trailingStep = getSelfManagedTrailingStep(effectiveMovePercent);
      if (trailingStep !== null) {
        return position.entryPrice * (1 + (trailingStep / 100));
      }
      if (effectiveMovePercent >= 0.5) {
        return position.entryPrice * (1 + commission) / (1 - commission);
      }
      return null;
    }

    if (stratBreakEvenOnlyEnabled && effectiveMovePercent >= 0.5) {
      return position.entryPrice * (1 + commission) / (1 - commission);
    }

    if (autoManaged && effectiveMovePercent >= 1) {
      const crossedStep = Math.floor(effectiveMovePercent / 0.5) * 0.5;
      const crossedPrice = position.entryPrice * (1 + crossedStep / 100);
      return crossedPrice * (1 - 0.5 / 100);
    }

    if (autoManaged && effectiveMovePercent >= 0.5) {
      return position.entryPrice * (1 + commission) / (1 - commission);
    }

    return null;
  }

  if (effectiveSelfManaged) {
    const trailingStep = getSelfManagedTrailingStep(effectiveMovePercent);
    if (trailingStep !== null) {
      return position.entryPrice * (1 - (trailingStep / 100));
    }
    if (effectiveMovePercent >= 0.5) {
      return position.entryPrice * (1 - commission) / (1 + commission);
    }
    return null;
  }

  if (stratBreakEvenOnlyEnabled && effectiveMovePercent >= 0.5) {
    return position.entryPrice * (1 - commission) / (1 + commission);
  }

  if (autoManaged && effectiveMovePercent >= 1) {
    const crossedStep = Math.floor(effectiveMovePercent / 0.5) * 0.5;
    const crossedPrice = position.entryPrice * (1 - crossedStep / 100);
    return crossedPrice * (1 + 0.5 / 100);
  }

  if (autoManaged && effectiveMovePercent >= 0.5) {
    return position.entryPrice * (1 - commission) / (1 + commission);
  }

  return null;
};

const hasBreachedStopLevel = (position: Position, currentPrice: number, stopPrice: number) => {
  return position.positionType === 'buy'
    ? currentPrice <= stopPrice
    : currentPrice >= stopPrice;
};

const buildPositionMarketUpdate = (
  position: Position,
  snapshot: MarketSnapshot,
  adaptiveContext: AdaptiveProtectionContext | null
): PositionMarketUpdate | null => {
  const livePrice = resolveLivePrice(snapshot);
  if (!livePrice) {
    return null;
  }

  const currentPrice = livePrice.price;
  const commission = getPositionCommission(position);
  const entryCost = position.entryPrice * position.quantity * commission;
  const exitCost = currentPrice * position.quantity * commission;
  const profitFiat = position.positionType === 'buy'
    ? ((currentPrice - position.entryPrice) * position.quantity) - entryCost - exitCost
    : ((position.entryPrice - currentPrice) * position.quantity) - entryCost - exitCost;
  const profitPercent = position.positionType === 'buy'
    ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  const candidateStopLoss = computeCandidateStopLoss(position, currentPrice, adaptiveContext);
  const canImproveStop = candidateStopLoss !== null && (
    (position.positionType === 'buy' && candidateStopLoss > position.stopLoss) ||
    (position.positionType === 'sell' && candidateStopLoss < position.stopLoss)
  );

  return {
    positionId: position.id,
    symbol: position.symbol.toUpperCase(),
    tradingMode: ((position as any).tradingMode || 'demo') as TradingMode,
    price: currentPrice,
    priceSource: livePrice.source,
    profitPercent,
    profitFiat,
    stopLoss: position.stopLoss,
    takeProfit: typeof position.takeProfit === 'number' ? position.takeProfit : null,
    candidateStopLoss,
    canImproveStop,
    managementMode: normalizePositionManagementMode(position.managementMode),
    stratBreakEvenEnabled: isStratBreakEvenActive(position),
    stratTrailingEnabled: isStratTrailingActive(position),
    eventTimestamp: snapshot.timestamp,
  };
};

const subscribeMarketKey = async (marketKey: string) => {
  if (watchedMarketKeys.has(marketKey)) {
    return;
  }

  const [mode, symbol] = marketKey.split(':');
  const params = new URLSearchParams({
    symbol,
    mode,
  });
  const response = await fetch(`${MARKETDATA_URL}/subscribe?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to subscribe ${marketKey}: ${response.status}`);
  }

  watchedMarketKeys.add(marketKey);
};

const rebuildPositionIndexes = (positions: Position[]) => {
  openPositions.clear();
  positionsByMarketKey.clear();

  for (const position of positions) {
    openPositions.set(position.id, position);
    const marketKey = makeMarketKey(((position as any).tradingMode || 'demo') as TradingMode, position.symbol);
    const current = positionsByMarketKey.get(marketKey) || new Set<number>();
    current.add(position.id);
    positionsByMarketKey.set(marketKey, current);
  }
};

const buildModeCounts = () => {
  let demo = 0;
  let live = 0;

  for (const position of Array.from(openPositions.values())) {
    if (((position as any).tradingMode || 'demo') === 'live') {
      live += 1;
    } else {
      demo += 1;
    }
  }

  return { demo, live };
};

const buildPositionIdsByMode = () => {
  const demo: number[] = [];
  const live: number[] = [];

  for (const position of Array.from(openPositions.values())) {
    if (((position as any).tradingMode || 'demo') === 'live') {
      live.push(position.id);
    } else {
      demo.push(position.id);
    }
  }

  demo.sort((left, right) => left - right);
  live.sort((left, right) => left - right);
  return { demo, live };
};

const positionExistsInSnapshot = (snapshot: Awaited<ReturnType<typeof bitgetGetSinglePosition>>, symbol: string) => {
  const normalizedSymbol = symbol.toUpperCase();
  return snapshot.ok && snapshot.positions.some((remotePosition: any) => (
    String(remotePosition?.symbol || '').toUpperCase() === normalizedSymbol &&
    Number.parseFloat(String(remotePosition?.positionAmt || '0')) !== 0
  ));
};

const reconcileExternallyClosedPosition = async (position: Position) => {
  if (positionLocks.has(position.id)) {
    return position;
  }

  const tradingMode = ((position as any).tradingMode || 'demo') as TradingMode;
  const symbol = position.symbol.toUpperCase();
  const [singleSnapshot, currentPrice] = await Promise.all([
    bitgetGetSinglePosition(symbol, tradingMode).catch(() => null),
    bitgetGetPrice(symbol, tradingMode).catch(() => false),
  ]);

  if (!singleSnapshot?.ok || positionExistsInSnapshot(singleSnapshot, symbol)) {
    return position;
  }

  const exchangeClose = await resolveBitgetCloseExecution({
    position: position as any,
    tradingMode,
    targetTime: new Date(),
    fallbackExitPrice: typeof currentPrice === 'number' ? currentPrice : position.entryPrice,
    fallbackReason: 'exchange_closed',
  });

  const exitPrice = exchangeClose?.exitPrice || (typeof currentPrice === 'number' ? currentPrice : position.entryPrice);
  const commission = getPositionCommission(position);
  const closeMetrics = calculateCloseMetrics({
    positionType: position.positionType,
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    entryCommission: commission,
    exitCommission: commission,
    exitPrice,
  });

  await prisma.position.update({
    where: { id: position.id },
    data: {
      status: 'closed',
      closedAt: exchangeClose?.closedAt || new Date(),
      profitLossPercent: closeMetrics.profitPercent,
      profitLossFiat: closeMetrics.profitFiat,
      exitPrice,
      exitReason: exchangeClose?.exitReason || 'exchange_closed',
      exitOrderId: exchangeClose?.exitOrderId || null,
      exitSource: exchangeClose?.exitSource || 'exchange_reconciled',
      closeOrigin: inferPositionCloseOrigin({
        exitReason: exchangeClose?.exitReason || 'exchange_closed',
        exitSource: exchangeClose?.exitSource || 'exchange_reconciled',
      }),
      maxProfitPercent: Number((position as any).maxProfitPercent || 0),
      maxProfitAt: ((position as any).maxProfitAt ? new Date((position as any).maxProfitAt) : null),
    } as any,
  });

  await writeAuditLog({
    action: 'trade_engine.exchange_position_missing',
    targetType: 'position',
    targetId: String(position.id),
    metadata: {
      symbol,
      tradingMode,
      exitPrice,
      exitReason: exchangeClose?.exitReason || 'exchange_closed',
      exitSource: exchangeClose?.exitSource || 'exchange_reconciled',
    },
  }).catch(() => undefined);

  emitEngineEvent('position_closed', {
    positionId: position.id,
    symbol,
    tradingMode,
    reason: exchangeClose?.exitReason || 'exchange_closed',
    exitPrice,
    profitPercent: closeMetrics.profitPercent,
    profitFiat: closeMetrics.profitFiat,
    at: Date.now(),
  });

  return null;
};

const reconcileOpenPositionsAgainstExchange = async (positions: Position[]) => {
  if (positions.length === 0) {
    return positions;
  }

  const modeSnapshots = await Promise.all([
    bitgetGetPositions('demo').catch(() => null),
    bitgetGetPositions('live').catch(() => null),
  ]);

  const openSymbolsByMode = {
    demo: new Set<string>(),
    live: new Set<string>(),
  };

  for (let index = 0; index < modeSnapshots.length; index += 1) {
    const snapshot = modeSnapshots[index];
    const mode = index === 0 ? 'demo' : 'live';
    if (!snapshot?.ok) {
      continue;
    }

    for (const remotePosition of snapshot.positions) {
      if (Number.parseFloat(String(remotePosition?.positionAmt || '0')) !== 0) {
        openSymbolsByMode[mode].add(String(remotePosition.symbol || '').toUpperCase());
      }
    }
  }

  const reconciled = await Promise.all(positions.map(async (position) => {
    const tradingMode = ((position as any).tradingMode || 'demo') as TradingMode;
    const symbol = position.symbol.toUpperCase();
    if (openSymbolsByMode[tradingMode].has(symbol)) {
      return position;
    }

    return reconcileExternallyClosedPosition(position);
  }));

  return reconciled.filter((position): position is Position => Boolean(position));
};

const reloadOpenPositions = async () => {
  let positions = await prisma.position.findMany({
    where: { status: 'open' } as any,
    orderBy: { createdAt: 'desc' },
  });

  const staleStratIds = positions
    .filter((position) => (
      normalizePositionManagementMode(position.managementMode) === 'strat' &&
      (!Boolean((position as any).stratBreakEvenEnabled) || !Boolean((position as any).stratTrailingEnabled))
    ))
    .map((position) => position.id);

  if (staleStratIds.length > 0) {
    await prisma.position.updateMany({
      where: { id: { in: staleStratIds } },
      data: {
        stratBreakEvenEnabled: true,
        stratTrailingEnabled: true,
      } as any,
    });

    positions = positions.map((position) => (
      staleStratIds.includes(position.id)
        ? {
            ...position,
            stratBreakEvenEnabled: true,
            stratTrailingEnabled: true,
          }
        : position
    ));

    await writeAuditLog({
      action: 'trade_engine.strat_flags_healed',
      targetType: 'position',
      targetId: staleStratIds.join(','),
      metadata: {
        healedPositionIds: staleStratIds,
        total: staleStratIds.length,
      },
    }).catch(() => undefined);
  }

  positions = await reconcileOpenPositionsAgainstExchange(positions);

  rebuildPositionIndexes(positions);
  for (const marketKey of Array.from(positionsByMarketKey.keys())) {
    await subscribeMarketKey(marketKey);
  }

  lastReloadAt = Date.now();
  emitEngineEvent('positions_reloaded', {
    openPositions: openPositions.size,
    watchedSymbols: positionsByMarketKey.size,
    modeCounts: buildModeCounts(),
    positionIdsByMode: buildPositionIdsByMode(),
    at: lastReloadAt,
  });
};

const reloadSettings = async () => {
  const [exhaustionGuardSetting, takeProfitAutoCloseSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'exhaustion_guard_enabled' } }),
    prisma.setting.findUnique({ where: { key: 'take_profit_auto_close_enabled' } }),
  ]);

  engineSettings = {
    exhaustionGuardEnabled: exhaustionGuardSetting?.value !== '0',
    takeProfitAutoCloseEnabled: takeProfitAutoCloseSetting?.value === '1',
  };

  lastSettingsReloadAt = Date.now();
  emitEngineEvent('settings_reloaded', {
    ...engineSettings,
    at: lastSettingsReloadAt,
  });
};

const shouldPersistPosition = (positionId: number, force = false) => {
  if (force) {
    return true;
  }

  const lastPersistAt = lastPersistAtByPosition.get(positionId) || 0;
  return (Date.now() - lastPersistAt) >= POSITION_PERSIST_COOLDOWN_MS;
};

const persistPositionSnapshot = async (position: Position, patch: Partial<Position>, force = false) => {
  if (!shouldPersistPosition(position.id, force)) {
    updateCachedPosition(position.id, patch);
    return;
  }

  await prisma.position.update({
    where: { id: position.id },
    data: patch as any,
  });
  updateCachedPosition(position.id, patch);
  lastPersistAtByPosition.set(position.id, Date.now());
};

const syncStopForPosition = async (position: Position, update: PositionMarketUpdate) => {
  if (!update.canImproveStop || update.candidateStopLoss === null) {
    return null;
  }

  if (hasBreachedStopLevel(position, update.price, update.candidateStopLoss)) {
    return null;
  }

  const lastSyncAt = lastStopSyncAtByPosition.get(position.id) || 0;
  if ((Date.now() - lastSyncAt) < STOP_SYNC_COOLDOWN_MS) {
    return null;
  }

  const tradingMode = ((position as any).tradingMode || 'demo') as TradingMode;
  const positionMode = await bitgetGetPositionMode(position.symbol.toUpperCase(), tradingMode) || 'one_way_mode';
  const positionContext = bitgetBuildPositionContext(position.positionType as 'buy' | 'sell', positionMode);
  const syncResult = await bitgetEnsureVerifiedStopOrder({
    symbol: position.symbol.toUpperCase(),
    side: positionContext.closeSide,
    stopPrice: update.candidateStopLoss,
    quantity: position.quantity,
    tradingMode,
    tradeSide: positionContext.closeTradeSide,
  });

  lastStopSyncAtByPosition.set(position.id, Date.now());

  if (!syncResult.ok) {
    console.warn('[trade-engine] stop sync failed', {
      positionId: position.id,
      symbol: position.symbol,
      tradingMode,
      candidateStopLoss: update.candidateStopLoss,
      currentStopLoss: position.stopLoss,
      message: syncResult.message,
    });
    emitEngineEvent('warning', {
      kind: 'stop_sync_failed',
      positionId: position.id,
      symbol: position.symbol,
      tradingMode,
      message: syncResult.message,
      at: Date.now(),
    });
    return null;
  }

  await prisma.position.update({
    where: { id: position.id },
    data: {
      stopLoss: update.candidateStopLoss,
    } as any,
  });
  updateCachedPosition(position.id, {
    stopLoss: update.candidateStopLoss,
  });
  lastPersistAtByPosition.set(position.id, Date.now());

  await writeAuditLog({
    action: 'trade_engine.stop_moved',
    targetType: 'position',
    targetId: String(position.id),
    metadata: {
      symbol: position.symbol,
      tradingMode,
      previousStopLoss: position.stopLoss,
      updatedStopLoss: update.candidateStopLoss,
      action: syncResult.message,
    },
  });

  emitEngineEvent('stop_moved', {
    positionId: position.id,
    symbol: position.symbol,
    tradingMode,
    previousStopLoss: position.stopLoss,
    updatedStopLoss: update.candidateStopLoss,
    action: syncResult.message,
    at: Date.now(),
  });

  return update.candidateStopLoss;
};

const closePositionFromEngine = async (position: Position, update: PositionMarketUpdate, reason: 'stop_loss' | 'trailing_stop' | 'take_profit' | 'exhaustion') => {
  const tradingMode = ((position as any).tradingMode || 'demo') as TradingMode;
  const positionMode = await bitgetGetPositionMode(position.symbol.toUpperCase(), tradingMode) || 'one_way_mode';
  const positionContext = bitgetBuildPositionContext(position.positionType as 'buy' | 'sell', positionMode);
  await bitgetCancelAllOrders(position.symbol.toUpperCase(), tradingMode);
  const closeResp = await bitgetClosePosition(
    position.symbol.toUpperCase(),
    positionContext.closeSide,
    position.quantity,
    tradingMode,
    positionContext.closeTradeSide
  );

  if (!bitgetOrderSuccess(closeResp)) {
    const singlePositionSnapshot = await bitgetGetSinglePosition(position.symbol.toUpperCase(), tradingMode).catch(() => null);
    const exchangeStillOpen = singlePositionSnapshot?.ok
      ? singlePositionSnapshot.positions.some((remotePosition: any) => (
          String(remotePosition?.symbol || '').toUpperCase() === position.symbol.toUpperCase() &&
          Number.parseFloat(String(remotePosition?.positionAmt || '0')) !== 0
        ))
      : true;

    if (!exchangeStillOpen) {
      const exchangeClose = await resolveBitgetCloseExecution({
        position: position as any,
        tradingMode,
        targetTime: new Date(),
        fallbackExitPrice: update.price,
        fallbackReason: reason,
      });

      const exitPrice = exchangeClose?.exitPrice || update.price;
      const commission = getPositionCommission(position);
      const closeMetrics = calculateCloseMetrics({
        positionType: position.positionType,
        entryPrice: position.entryPrice,
        quantity: position.quantity,
        entryCommission: commission,
        exitCommission: commission,
        exitPrice,
      });

      await prisma.position.update({
        where: { id: position.id },
        data: {
          status: 'closed',
          closedAt: exchangeClose?.closedAt || new Date(),
          profitLossPercent: closeMetrics.profitPercent,
          profitLossFiat: closeMetrics.profitFiat,
          exitPrice,
          exitReason: exchangeClose?.exitReason || reason,
          exitOrderId: exchangeClose?.exitOrderId || null,
          exitSource: exchangeClose?.exitSource || 'exchange_reconciled',
          closeOrigin: inferPositionCloseOrigin({
            exitReason: exchangeClose?.exitReason || reason,
            exitSource: exchangeClose?.exitSource || 'exchange_reconciled',
          }),
          maxProfitPercent: Math.max(Number((position as any).maxProfitPercent || 0), update.profitPercent),
          maxProfitAt: update.profitPercent > Number((position as any).maxProfitPercent || 0)
            ? new Date()
            : ((position as any).maxProfitAt ? new Date((position as any).maxProfitAt) : null),
        } as any,
      });

      await writeAuditLog({
        action: 'trade_engine.close_reconciled',
        targetType: 'position',
        targetId: String(position.id),
        metadata: {
          symbol: position.symbol,
          tradingMode,
          reason,
          exchangeMessage: closeResp?.msg || closeResp?.message || 'close rejected',
          reconciledExitPrice: exitPrice,
        },
      }).catch(() => undefined);

      emitEngineEvent('position_closed', {
        positionId: position.id,
        symbol: position.symbol.toUpperCase(),
        tradingMode,
        reason,
        exitPrice,
        profitPercent: closeMetrics.profitPercent,
        profitFiat: closeMetrics.profitFiat,
        at: Date.now(),
      });

      removeOpenPosition(position);
      return true;
    }

    emitEngineEvent('warning', {
      kind: 'close_failed',
      positionId: position.id,
      symbol: position.symbol,
      tradingMode,
      reason,
      message: closeResp?.msg || closeResp?.message || 'close rejected',
      at: Date.now(),
    });
    return false;
  }

  const exchangeClose = await resolveBitgetCloseExecution({
    position: position as any,
    tradingMode,
    targetTime: new Date(),
    fallbackExitPrice: update.price,
    knownCloseResp: closeResp,
    fallbackReason: reason,
  });

  const exitPrice = exchangeClose?.exitPrice || update.price;
  const commission = getPositionCommission(position);
  const closeMetrics = calculateCloseMetrics({
    positionType: position.positionType,
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    entryCommission: commission,
    exitCommission: commission,
    exitPrice,
  });

  await prisma.position.update({
    where: { id: position.id },
    data: {
      status: 'closed',
      closedAt: exchangeClose?.closedAt || new Date(),
      profitLossPercent: closeMetrics.profitPercent,
      profitLossFiat: closeMetrics.profitFiat,
      exitPrice,
      exitReason: exchangeClose?.exitReason || reason,
      exitOrderId: exchangeClose?.exitOrderId || null,
      exitSource: exchangeClose?.exitSource || null,
      closeOrigin: inferPositionCloseOrigin({
        exitReason: exchangeClose?.exitReason || reason,
        exitSource: exchangeClose?.exitSource || null,
      }),
      maxProfitPercent: Math.max(Number((position as any).maxProfitPercent || 0), update.profitPercent),
      maxProfitAt: update.profitPercent > Number((position as any).maxProfitPercent || 0)
        ? new Date()
        : ((position as any).maxProfitAt || null),
    } as any,
  });

  await writeAuditLog({
    action: 'trade_engine.position_closed',
    targetType: 'position',
    targetId: String(position.id),
    metadata: {
      symbol: position.symbol,
      tradingMode,
      reason,
      exitPrice,
      profitPercent: closeMetrics.profitPercent,
      profitFiat: closeMetrics.profitFiat,
    },
  });

  await notifyPositiveClose({
    symbol: position.symbol.toUpperCase(),
    tradingMode,
    profitFiat: closeMetrics.profitFiat,
    profitPercent: closeMetrics.profitPercent,
  }).catch(() => undefined);

  await notifyAllActiveDevices({
    title: `${position.symbol.toUpperCase()} cerrada`,
    body: `La posicion #${position.id} en ${tradingMode.toUpperCase()} se cerro por ${reason}.`,
    data: {
      kind: reason === 'take_profit'
        ? 'position_closed_take_profit'
        : reason === 'trailing_stop'
          ? 'position_closed_trailing_stop'
          : reason === 'exhaustion'
            ? 'position_closed_exhaustion'
            : 'position_closed_stop_loss',
      positionId: position.id,
      symbol: position.symbol.toUpperCase(),
      tradingMode,
      profitPercent: Number(closeMetrics.profitPercent.toFixed(2)),
      profitFiat: Number(closeMetrics.profitFiat.toFixed(2)),
    },
  }).catch(() => undefined);

  emitEngineEvent('position_closed', {
    positionId: position.id,
    symbol: position.symbol.toUpperCase(),
    tradingMode,
    reason,
    exitPrice,
    profitPercent: closeMetrics.profitPercent,
    profitFiat: closeMetrics.profitFiat,
    at: Date.now(),
  });

  removeOpenPosition(position);
  return true;
};

const processPositionMarketUpdate = async (positionId: number, snapshot: MarketSnapshot) => {
  if (positionLocks.has(positionId)) {
    return;
  }

  const position = openPositions.get(positionId);
  if (!position) {
    return;
  }

  const adaptiveContext = await loadAdaptiveContextForPosition(position);
  const update = buildPositionMarketUpdate(position, snapshot, adaptiveContext);
  if (!update) {
    return;
  }

  positionLocks.add(positionId);
  try {
    emitEngineEvent('position_market_update', update);

    const currentPosition = openPositions.get(positionId);
    if (!currentPosition) {
      return;
    }

    const managementMode = update.managementMode;
    const fixedManaged = isFixedPriceManagementMode(currentPosition.managementMode);
    const stratManaged = managementMode === 'strat';
    const trendManaged = managementMode === 'trend';
    const autoManaged = managementMode === 'auto';
    const previousMaxProfitPercent = Math.max(0, Number((currentPosition as any).maxProfitPercent || 0));
    const improvedMax = update.profitPercent > previousMaxProfitPercent;
    const maxProfitPercent = improvedMax ? update.profitPercent : previousMaxProfitPercent;
    const maxProfitAt = improvedMax
      ? new Date()
      : ((currentPosition as any).maxProfitAt ? new Date((currentPosition as any).maxProfitAt) : null);
    const stagnationMs = maxProfitAt ? (Date.now() - maxProfitAt.getTime()) : 0;
    const retracementRatio = maxProfitPercent > 0
      ? Math.max(0, (maxProfitPercent - update.profitPercent) / maxProfitPercent)
      : 0;
    const givebackPercent = Math.max(0, maxProfitPercent - update.profitPercent);

    let activeStopLoss = currentPosition.stopLoss;
    const movedStopLoss = await syncStopForPosition(currentPosition, update);
    if (typeof movedStopLoss === 'number') {
      activeStopLoss = movedStopLoss;
      update.stopLoss = movedStopLoss;
    }

    let exhaustionTriggered = false;
    if (
      autoManaged &&
      engineSettings.exhaustionGuardEnabled &&
      maxProfitPercent >= EXHAUSTION_MIN_MFE_PERCENT &&
      update.profitPercent > 0 &&
      stagnationMs >= EXHAUSTION_MIN_STAGNATION_MS &&
      retracementRatio >= EXHAUSTION_MIN_RETRACEMENT_RATIO
    ) {
      exhaustionTriggered = true;
    } else if (
      autoManaged &&
      engineSettings.exhaustionGuardEnabled &&
      maxProfitPercent >= EXHAUSTION_FLAT_MIN_MFE_PERCENT &&
      update.profitPercent >= EXHAUSTION_FLAT_MIN_PROFIT_PERCENT &&
      stagnationMs >= EXHAUSTION_FLAT_MIN_STAGNATION_MS &&
      givebackPercent <= EXHAUSTION_FLAT_MAX_GIVEBACK_PERCENT
    ) {
      exhaustionTriggered = true;
    }

    let takeProfitTriggered = false;
    if (typeof update.takeProfit === 'number' && update.takeProfit > 0) {
      if (currentPosition.positionType === 'buy') {
        takeProfitTriggered = trendManaged
          ? false
          : autoManaged
          ? (engineSettings.takeProfitAutoCloseEnabled && update.price >= update.takeProfit)
          : ((fixedManaged || stratManaged) && update.price >= update.takeProfit);
      } else {
        takeProfitTriggered = trendManaged
          ? false
          : autoManaged
          ? (engineSettings.takeProfitAutoCloseEnabled && update.price <= update.takeProfit)
          : ((fixedManaged || stratManaged) && update.price <= update.takeProfit);
      }
    }

    const derivedStopLoss = update.candidateStopLoss !== null
      ? (
          currentPosition.positionType === 'buy'
            ? Math.max(activeStopLoss, update.candidateStopLoss)
            : Math.min(activeStopLoss, update.candidateStopLoss)
        )
      : activeStopLoss;
    const stopLossTriggered = trendManaged
      ? false
      : hasBreachedStopLevel(currentPosition, update.price, derivedStopLoss);

    if (exhaustionTriggered || takeProfitTriggered || stopLossTriggered) {
      const impliedTrailingStop = !trendManaged && update.candidateStopLoss !== null && (
        (currentPosition.positionType === 'buy' && update.candidateStopLoss > currentPosition.stopLoss) ||
        (currentPosition.positionType === 'sell' && update.candidateStopLoss < currentPosition.stopLoss)
      );
      const reason = exhaustionTriggered
        ? 'exhaustion'
        : takeProfitTriggered
          ? 'take_profit'
          : ((typeof movedStopLoss === 'number' || impliedTrailingStop) ? 'trailing_stop' : 'stop_loss');
      await closePositionFromEngine(currentPosition, update, reason);
      return;
    }

    await persistPositionSnapshot(currentPosition, {
      stopLoss: activeStopLoss,
      profitLossPercent: update.profitPercent,
      profitLossFiat: update.profitFiat,
      maxProfitPercent,
      maxProfitAt,
    }, improvedMax);
  } catch (error: any) {
    lastWarning = `position-${positionId}: ${error?.message || 'unknown error'}`;
    emitEngineEvent('warning', {
      kind: 'position_processing_failed',
      positionId,
      symbol: position.symbol,
      warning: lastWarning,
      at: Date.now(),
    });
  } finally {
    positionLocks.delete(positionId);
  }
};

const consumeMarketEvent = (payload: MarketEventPayload) => {
  const snapshot = payload.snapshot;
  const marketKey = makeMarketKey(snapshot.tradingMode, snapshot.symbol);
  marketSnapshots.set(marketKey, snapshot);
  lastMarketEventAt = Date.now();

  emitEngineEvent('market', payload);

  const relatedPositions = positionsByMarketKey.get(marketKey);
  if (!relatedPositions || relatedPositions.size === 0) {
    return;
  }

  for (const positionId of Array.from(relatedPositions)) {
    void processPositionMarketUpdate(positionId, snapshot);
  }
};

const parseSseChunk = (chunk: string) => {
  const lines = chunk.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message';
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join('\n'),
  };
};

const streamMarketMode = async (mode: TradingMode) => {
  while (true) {
    try {
      const response = await fetch(`${MARKETDATA_URL}/events?mode=${mode}`, {
        headers: {
          Accept: 'text/event-stream',
        },
        cache: 'no-store',
      });

      if (!response.ok || !response.body) {
        throw new Error(`Market stream ${mode} unavailable (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const parsed = parseSseChunk(chunk);
          if (!parsed || parsed.event !== 'market') {
            continue;
          }

          try {
            consumeMarketEvent(JSON.parse(parsed.data) as MarketEventPayload);
          } catch {
            continue;
          }
        }
      }

      throw new Error(`Market stream ${mode} closed`);
    } catch (error: any) {
      lastWarning = `market-stream-${mode}: ${error?.message || 'unknown error'}`;
      emitEngineEvent('warning', {
        mode,
        warning: lastWarning,
        at: Date.now(),
      });
      await sleep(MARKET_STREAM_RECONNECT_MS);
    }
  }
};

const removeSubscriber = (id: number) => {
  const subscriber = engineSubscribers.get(id);
  if (!subscriber) {
    return;
  }

  engineSubscribers.delete(id);
  try {
    subscriber.res.end();
  } catch {
    return;
  }
};

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end('Missing URL');
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      marketdataUrl: MARKETDATA_URL,
      openPositions: openPositions.size,
      watchedSymbols: positionsByMarketKey.size,
      snapshots: marketSnapshots.size,
      subscribers: engineSubscribers.size,
      settings: engineSettings,
      lastReloadAt,
      lastMarketEventAt,
      lastSettingsReloadAt,
      lastWarning,
    }));
    return;
  }

  if (url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      openPositions: Array.from(openPositions.values()).map((position) => ({
        id: position.id,
        symbol: position.symbol,
        tradingMode: (position as any).tradingMode || 'demo',
        managementMode: normalizePositionManagementMode(position.managementMode),
        stratBreakEvenEnabled: isStratBreakEvenActive(position),
        stratTrailingEnabled: isStratTrailingActive(position),
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        maxProfitPercent: (position as any).maxProfitPercent ?? null,
        maxProfitAt: (position as any).maxProfitAt ?? null,
      })),
      watchedSymbols: Array.from(positionsByMarketKey.keys()),
      settings: engineSettings,
      lastReloadAt,
      lastMarketEventAt,
      lastSettingsReloadAt,
      lastWarning,
    }));
    return;
  }

  if (url.pathname === '/reload-positions') {
    try {
      await reloadOpenPositions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        openPositions: openPositions.size,
        watchedSymbols: positionsByMarketKey.size,
        lastReloadAt,
      }));
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        message: error?.message || 'Failed to reload positions',
      }));
    }
    return;
  }

  if (url.pathname === '/events') {
    const subscriberId = nextSubscriberId++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    engineSubscribers.set(subscriberId, { id: subscriberId, res });
    writeSse(res, 'ready', {
      subscriberId,
      openPositions: openPositions.size,
      watchedSymbols: positionsByMarketKey.size,
      settings: engineSettings,
    });

    req.on('close', () => {
      removeSubscriber(subscriberId);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, message: 'Not found' }));
});

async function main() {
  await Promise.all([
    reloadOpenPositions(),
    reloadSettings(),
  ]);

  setInterval(() => {
    reloadOpenPositions().catch((error: any) => {
      lastWarning = `reload-positions: ${error?.message || 'unknown error'}`;
      emitEngineEvent('warning', {
        warning: lastWarning,
        at: Date.now(),
      });
    });
  }, POSITION_REFRESH_MS).unref();

  setInterval(() => {
    reloadSettings().catch((error: any) => {
      lastWarning = `reload-settings: ${error?.message || 'unknown error'}`;
      emitEngineEvent('warning', {
        warning: lastWarning,
        at: Date.now(),
      });
    });
  }, SETTINGS_REFRESH_MS).unref();

  void streamMarketMode('demo');
  void streamMarketMode('live');

  server.listen(PORT, HOST, () => {
    console.log(`Trade engine running on http://${HOST}:${PORT}`);
  });
}

const shutdown = async (signal: string) => {
  console.log(`Shutting down trade engine (${signal})`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
