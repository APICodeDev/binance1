// app/api/monitor/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { fail, ok } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  buildAdaptiveProtectionContext,
  calculateCloseMetrics,
  computeAdaptiveProtectionDecision,
  inferPositionCloseOrigin,
  isBreakEvenEffectivelyEnabled,
  isFixedPriceManagementMode,
  isTrailingEffectivelyEnabled,
  normalizePositionManagementMode,
  resolveBitgetCloseExecution,
} from '@/lib/positions';
import { attachTakeProfitUpgradeMeta } from '@/lib/positionSignals';
import { notifyPositiveClose } from '@/lib/ntfy';
import { notifyAllActiveDevices } from '@/lib/pushNotifications';
import {
  bitgetBuildPositionContext,
  bitgetGetPrice,
  bitgetGetPositionMode,
  bitgetGetPositions,
  bitgetGetSinglePosition,
  bitgetCancelAllOrders,
  bitgetCancelAlgoOrders,
  bitgetEnsureVerifiedStopOrder,
  bitgetGetHistoricalCandles,
  bitgetGetPendingStopOrders,
  bitgetGetRecentCandleRange,
  bitgetModifyStopOrder,
  bitgetCancelPlanOrdersByIds,
  bitgetOrderSuccess,
  bitgetClosePosition,
  bitgetPlaceStopMarket,
  bitgetGetCommissionRate
} from '@/lib/bitget';

const MONITOR_INTERNAL_SECRET = process.env.MONITOR_INTERNAL_SECRET || '';
const TRADE_ENGINE_URL = (process.env.TRADE_ENGINE_URL || '').trim();
const MONITOR_ALLOW_LEGACY_EXECUTION = process.env.MONITOR_ALLOW_LEGACY_EXECUTION === '1';
const EXHAUSTION_MIN_MFE_PERCENT = 1.0;
const EXHAUSTION_MIN_STAGNATION_MS = 90 * 60 * 1000;
const EXHAUSTION_MIN_RETRACEMENT_RATIO = 0.35;
const EXHAUSTION_FLAT_MIN_MFE_PERCENT = 1.5;
const EXHAUSTION_FLAT_MIN_PROFIT_PERCENT = 1.0;
const EXHAUSTION_FLAT_MIN_STAGNATION_MS = 120 * 60 * 1000;
const EXHAUSTION_FLAT_MAX_GIVEBACK_PERCENT = 0.25;
const DEFAULT_API_LEGACY_STOP_PERCENT = '1.2';

function resolveStoredLegacyStopPercent(rawValue?: string | null) {
  const parsed = Number.parseFloat(String(rawValue ?? '').trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0
    ? parsed.toString()
    : DEFAULT_API_LEGACY_STOP_PERCENT;
}

const DASHBOARD_SETTING_KEYS = [
  'bot_enabled',
  'custom_amount',
  'last_entry_error',
  'last_webhook_status',
  'trading_mode',
  'leverage_enabled',
  'leverage_value',
  'profit_sound_enabled',
  'profit_sound_file',
  'api_stop_mode',
  'api_legacy_stop_percent',
  'exhaustion_guard_enabled',
  'take_profit_auto_close_enabled',
  'reverse_on_opposite_signal_enabled',
] as const;

type DashboardMode = 'demo' | 'live';

function getDashboardMode(req: NextRequest): DashboardMode {
  const { searchParams } = new URL(req.url);
  return searchParams.get('mode') === 'live' ? 'live' : 'demo';
}

async function buildDashboardSnapshot(mode: DashboardMode) {
  const [open, history, totalPnlRows, settingsRows] = await Promise.all([
    prisma.position.findMany({
      where: { status: 'open', tradingMode: mode } as any,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.position.findMany({
      where: { status: 'closed', tradingMode: mode } as any,
      orderBy: { closedAt: 'desc' },
      take: 50,
    }),
    prisma.position.aggregate({
      where: { status: 'closed', tradingMode: mode } as any,
      _sum: { profitLossFiat: true },
    }),
    prisma.setting.findMany({
      where: { key: { in: [...DASHBOARD_SETTING_KEYS] } },
    }),
  ]);

  const settingsMap = settingsRows.reduce<Record<string, string>>((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  const [openWithTpMeta, historyWithTpMeta] = await Promise.all([
    attachTakeProfitUpgradeMeta(open as any),
    attachTakeProfitUpgradeMeta(history as any),
  ]);

  return {
    open: openWithTpMeta,
    history: historyWithTpMeta,
    totalPnl: totalPnlRows._sum?.profitLossFiat || 0,
    mode,
    settings: {
      bot_enabled: settingsMap.bot_enabled || '1',
      custom_amount: settingsMap.custom_amount || '',
      last_entry_error: settingsMap.last_entry_error || '',
      last_webhook_status: settingsMap.last_webhook_status || '',
      trading_mode: settingsMap.trading_mode || 'demo',
      leverage_enabled: settingsMap.leverage_enabled || '0',
      leverage_value: settingsMap.leverage_value || '1',
      profit_sound_enabled: settingsMap.profit_sound_enabled || '0',
      profit_sound_file: settingsMap.profit_sound_file || '',
      api_stop_mode: settingsMap.api_stop_mode || 'signal',
      api_legacy_stop_percent: resolveStoredLegacyStopPercent(settingsMap.api_legacy_stop_percent),
      exhaustion_guard_enabled: settingsMap.exhaustion_guard_enabled || '1',
      take_profit_auto_close_enabled: settingsMap.take_profit_auto_close_enabled || '0',
      reverse_on_opposite_signal_enabled: settingsMap.reverse_on_opposite_signal_enabled || '1',
    },
  };
}

export async function runMonitor(req: NextRequest, actorUserId?: number) {
  const dashboardMode = getDashboardMode(req);

  if (TRADE_ENGINE_URL && !MONITOR_ALLOW_LEGACY_EXECUTION) {
    const snapshot = await buildDashboardSnapshot(dashboardMode);
    await writeAuditLog({
      action: 'monitor.snapshot_only',
      userId: actorUserId,
      targetType: 'monitor',
      metadata: {
        mode: dashboardMode,
        reason: 'trade_engine_primary',
      },
      req,
    });

    return ok({ results: ['SNAPSHOT_ONLY: trade engine primary active'], snapshot }, 'Monitor snapshot loaded');
  }

  const positions = await prisma.position.findMany({ where: { status: 'open' } });
  const [exhaustionGuardSetting, takeProfitAutoCloseSetting] = await Promise.all([
    prisma.setting.findUnique({
      where: { key: 'exhaustion_guard_enabled' },
    }),
    prisma.setting.findUnique({
      where: { key: 'take_profit_auto_close_enabled' },
    }),
  ]);
  const exhaustionGuardEnabled = exhaustionGuardSetting?.value !== '0';
  const takeProfitAutoCloseEnabled = takeProfitAutoCloseSetting?.value === '1';

  if (positions.length === 0) {
    return ok({ results: [], snapshot: await buildDashboardSnapshot(dashboardMode) }, 'No open positions to monitor.');
  }

  // Fetch real positions for both worlds
  const realDemo = await bitgetGetPositions('demo');
  const realLive = await bitgetGetPositions('live');

  const buildMap = (realList: any[]) => {
    const map: Record<string, any> = {};
    if (Array.isArray(realList)) {
      realList.forEach((rp: any) => {
        if (rp.symbol && parseFloat(rp.positionAmt) !== 0) {
          map[rp.symbol.toUpperCase()] = rp;
        }
      });
    }
    return map;
  };

  const demoMap = buildMap(realDemo.positions);
  const liveMap = buildMap(realLive.positions);

  const results: string[] = [];
  const pushEvents: Array<{ title: string; body: string; data?: Record<string, unknown> }> = [];
  const adaptiveContextCache = new Map<number, Awaited<ReturnType<typeof buildAdaptiveProtectionContext>>>();

  const syncStopOrder = async (
    symbol: string,
    side: 'BUY' | 'SELL',
    stopPrice: number,
    quantity: number,
    mode: 'demo' | 'live',
    tradeSide?: 'open' | 'close'
  ) => {
    return bitgetEnsureVerifiedStopOrder({
      symbol,
      side,
      stopPrice,
      quantity,
      tradingMode: mode,
      tradeSide,
    });
  };

  const getSelfManagedTrailingStep = (marketMovePercent: number) => {
    if (marketMovePercent < 1.25) {
      return null;
    }

    const lockedPercent = Math.floor((marketMovePercent - 0.25) + 1e-9);
    return lockedPercent >= 1 ? lockedPercent : null;
  };

  const getAdaptiveContextForPosition = async (pos: any, mode: 'demo' | 'live') => {
    if (adaptiveContextCache.has(pos.id)) {
      return adaptiveContextCache.get(pos.id) ?? null;
    }

    const createdAtMs = new Date(pos.createdAt).getTime();
    const [candles15m, candles1h] = await Promise.all([
      bitgetGetHistoricalCandles(pos.symbol, '15m', 8, mode, createdAtMs).catch(() => ({ ok: false as const, error: '15m history failed' })),
      bitgetGetHistoricalCandles(pos.symbol, '1H', 20, mode, createdAtMs).catch(() => ({ ok: false as const, error: '1H history failed' })),
    ]);

    const context = candles15m.ok && candles1h.ok
      ? buildAdaptiveProtectionContext({
          positionType: pos.positionType,
          entryPrice: pos.entryPrice,
          candles15m: candles15m.candles,
          candles1h: candles1h.candles,
        })
      : null;

    adaptiveContextCache.set(pos.id, context);
    return context;
  };

  for (const pos of positions) {
    const mode = ((pos as any).tradingMode || 'demo') as 'demo' | 'live';
    const managementMode = normalizePositionManagementMode((pos as any).managementMode);
    const fixedManaged = isFixedPriceManagementMode((pos as any).managementMode);
    const selfManaged = managementMode === 'self';
    const stratManaged = managementMode === 'strat';
    const trendManaged = managementMode === 'trend';
    const breakEvenEnabled = isBreakEvenEffectivelyEnabled(pos as any);
    const trailingEnabled = isTrailingEffectivelyEnabled(pos as any);
    const effectiveSelfManaged = trailingEnabled && (fixedManaged || selfManaged || stratManaged || trendManaged);
    const breakEvenOnlyEnabled = breakEvenEnabled && !trailingEnabled;
    const autoManaged = managementMode === 'auto';
    const realMap = mode === 'live' ? liveMap : demoMap;
    const snapshot = mode === 'live' ? realLive : realDemo;
    const symbol = pos.symbol.toUpperCase();
    const positionMode = await bitgetGetPositionMode(symbol, mode) || 'one_way_mode';
    const positionContext = bitgetBuildPositionContext(pos.positionType as 'buy' | 'sell', positionMode);

    if (!snapshot.ok) {
      results.push(`SYNC_SKIPPED (${mode}): No se pudo verificar ${symbol} en Bitget. ${snapshot.errors.join(' | ')}`);
      continue;
    }

    // 1. Sync with Bitget (closure check)
    if (!realMap[symbol]) {
      const singleSnapshot = await bitgetGetSinglePosition(symbol, mode);
      if (!singleSnapshot.ok) {
        results.push(`SYNC_SKIPPED (${mode}): Verificación individual falló para ${symbol}. ${singleSnapshot.errors.join(' | ')}`);
        continue;
      }

      const stillOpen = singleSnapshot.positions.some((rp: any) => rp.symbol && parseFloat(rp.positionAmt) !== 0);
      if (stillOpen) {
        results.push(`SYNC_OK (${mode}): ${symbol} sigue abierto en Bitget tras verificación individual.`);
        continue;
      }

      const comm = await bitgetGetCommissionRate(symbol, mode);
      const entryComm = comm;
      const currentPrice = (await bitgetGetPrice(symbol, mode)) || pos.entryPrice;
      const exchangeClose = await resolveBitgetCloseExecution({
        position: pos as any,
        tradingMode: mode,
        targetTime: new Date(),
        fallbackExitPrice: currentPrice,
        fallbackReason: 'exchange_closed',
      });
      const exitPrice = exchangeClose?.exitPrice || currentPrice;
      const closeMetrics = calculateCloseMetrics({
        positionType: pos.positionType,
        entryPrice: pos.entryPrice,
        quantity: pos.quantity,
        entryCommission: entryComm,
        exitCommission: comm,
        exitPrice,
      });

      await bitgetCancelAllOrders(symbol, mode);
      await prisma.position.update({
        where: { id: pos.id },
        data: {
          status: 'closed',
          closedAt: exchangeClose?.closedAt || new Date(),
          profitLossPercent: closeMetrics.profitPercent,
          profitLossFiat: closeMetrics.profitFiat,
          exitPrice,
          exitReason: exchangeClose?.exitReason || 'exchange_closed',
          exitOrderId: exchangeClose?.exitOrderId || null,
          exitSource: exchangeClose?.exitSource || null,
          closeOrigin: inferPositionCloseOrigin({
            exitReason: exchangeClose?.exitReason || 'exchange_closed',
            exitSource: exchangeClose?.exitSource || null,
          }),
        } as any,
      });
      await notifyPositiveClose({
        symbol,
        tradingMode: mode,
        profitFiat: closeMetrics.profitFiat,
        profitPercent: closeMetrics.profitPercent,
      }).catch((error) => {
        console.error('Failed to send positive close ntfy notification', error);
      });
      results.push(`SINC_CERRADA (${mode}): Position #${pos.id} (${symbol}) cerrada en Bitget.`);
      pushEvents.push({
        title: `${symbol} cerrada`,
        body: `La posicion #${pos.id} en ${mode.toUpperCase()} se detecto como cerrada en Bitget.`,
        data: {
          kind: 'position_closed_sync',
          positionId: pos.id,
          symbol,
          tradingMode: mode,
        },
      });
      continue; // Move to next position
    }

    // 2. Trailing Stop and Local SL Check
    const currentPrice = await bitgetGetPrice(symbol, mode);
    if (!currentPrice) {
      results.push(`ERROR: Failed to fetch price for ${symbol} in ${mode}.`);
      continue;
    }
    const positionAgeMs = Date.now() - new Date(pos.createdAt).getTime();
    const recentRange = (fixedManaged || stratManaged) && positionAgeMs >= 2 * 60 * 1000
      ? await bitgetGetRecentCandleRange(symbol, mode, 5).catch(() => ({ ok: false as const, error: 'Recent candle fetch failed' }))
      : { ok: false as const, error: 'Recent candle fallback skipped' };
    const recentHigh: number | null = recentRange.ok ? (recentRange.high ?? null) : null;
    const recentLow: number | null = recentRange.ok ? (recentRange.low ?? null) : null;

    const comm = await bitgetGetCommissionRate(symbol, mode);
    const entryComm = comm;
    const entryCost = pos.entryPrice * pos.quantity * entryComm;
    const exitCost = currentPrice * pos.quantity * comm;

    const profitFiat = pos.positionType === 'buy'
      ? ((currentPrice - pos.entryPrice) * pos.quantity) - entryCost - exitCost
      : ((pos.entryPrice - currentPrice) * pos.quantity) - entryCost - exitCost;

    const profitPercent = pos.positionType === 'buy'
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
    const marketMovePercent = pos.positionType === 'buy'
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
    const previousMaxProfitPercent = Math.max(0, Number((pos as any).maxProfitPercent || 0));
    const improvedMax = profitPercent > previousMaxProfitPercent;
    const maxProfitPercent = improvedMax ? profitPercent : previousMaxProfitPercent;
    const maxProfitAt = improvedMax
      ? new Date()
      : ((pos as any).maxProfitAt ? new Date((pos as any).maxProfitAt) : null);
    const effectiveMovePercent = Math.max(marketMovePercent, maxProfitPercent);
    const stagnationMs = maxProfitAt ? (Date.now() - maxProfitAt.getTime()) : 0;
    const retracementRatio = maxProfitPercent > 0
      ? Math.max(0, (maxProfitPercent - profitPercent) / maxProfitPercent)
      : 0;
    const givebackPercent = Math.max(0, maxProfitPercent - profitPercent);
    const adaptiveContext = await getAdaptiveContextForPosition(pos, mode);
    const adaptiveProtection = computeAdaptiveProtectionDecision({
      positionType: pos.positionType,
      entryPrice: pos.entryPrice,
      entryCommission: entryComm,
      exitCommission: comm,
      effectiveMovePercent: Math.max(marketMovePercent, maxProfitPercent),
      context: adaptiveContext,
    });

    let newSl = pos.stopLoss;
    const previousStopLoss = pos.stopLoss;
    let stopLossTriggered = false;
    let takeProfitTriggered = false;
    let exhaustionTriggered = false;
    let exhaustionReason: 'retracement' | 'flat_timeout' | null = null;
    const takeProfit = Number((pos as any).takeProfit || 0);
    const hasTakeProfit = Number.isFinite(takeProfit) && takeProfit > 0;

    if (
      autoManaged &&
      exhaustionGuardEnabled &&
      maxProfitPercent >= EXHAUSTION_MIN_MFE_PERCENT &&
      profitPercent > 0 &&
      stagnationMs >= EXHAUSTION_MIN_STAGNATION_MS &&
      retracementRatio >= EXHAUSTION_MIN_RETRACEMENT_RATIO
    ) {
      exhaustionTriggered = true;
      exhaustionReason = 'retracement';
      results.push(
        `EXHAUSTION_SIGNAL (${mode}): ${symbol} MFE ${maxProfitPercent.toFixed(2)}% | ` +
        `actual ${profitPercent.toFixed(2)}% | estancada ${Math.floor(stagnationMs / 60000)}m`
      );
    } else if (
      autoManaged &&
      exhaustionGuardEnabled &&
      maxProfitPercent >= EXHAUSTION_FLAT_MIN_MFE_PERCENT &&
      profitPercent >= EXHAUSTION_FLAT_MIN_PROFIT_PERCENT &&
      stagnationMs >= EXHAUSTION_FLAT_MIN_STAGNATION_MS &&
      givebackPercent <= EXHAUSTION_FLAT_MAX_GIVEBACK_PERCENT
    ) {
      exhaustionTriggered = true;
      exhaustionReason = 'flat_timeout';
      results.push(
        `EXHAUSTION_FLAT (${mode}): ${symbol} MFE ${maxProfitPercent.toFixed(2)}% | ` +
        `actual ${profitPercent.toFixed(2)}% | sin mejora ${Math.floor(stagnationMs / 60000)}m`
      );
    }

    if (!effectiveSelfManaged) {
      const ensuredStopResp = await syncStopOrder(
        symbol,
        positionContext.closeSide,
        newSl,
        pos.quantity,
        mode,
        positionContext.closeTradeSide
      );

      if (!ensuredStopResp.ok) {
        results.push(`SL_SYNC_WARNING (${mode}): ${symbol} -> ${ensuredStopResp.message}`);
      } else if (ensuredStopResp.message === 'placed') {
        results.push(`SL_RESTORED (${mode}): ${symbol} -> ${newSl}`);
      }
    }

    if (!exhaustionTriggered && pos.positionType === 'buy') {
      if (trendManaged && effectiveMovePercent > 1) {
        const targetSlPrice = pos.entryPrice * (1 + entryComm) / (1 - comm);
        if (targetSlPrice > pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} trend breakeven -> ${targetSlPrice}`);
          } else {
            results.push(`SL_SYNC_WARNING (${mode}): ${symbol} trend breakeven -> ${slResp.message}`);
          }
        }
      } else if (autoManaged && takeProfitAutoCloseEnabled && hasTakeProfit && currentPrice >= takeProfit) {
        takeProfitTriggered = true;
      } else if (adaptiveProtection && trailingEnabled && adaptiveProtection.stopPrice > pos.stopLoss) {
        const slResp = await syncStopOrder(symbol, positionContext.closeSide, adaptiveProtection.stopPrice, pos.quantity, mode, positionContext.closeTradeSide);
        if (slResp.ok) {
          newSl = adaptiveProtection.stopPrice;
          results.push(`SL_UPDATE (${mode}): ${symbol} adaptive ${adaptiveProtection.reason} -> ${adaptiveProtection.stopPrice}`);
        }
      } else if (adaptiveProtection && breakEvenEnabled && adaptiveProtection.reason === 'break_even' && adaptiveProtection.stopPrice > pos.stopLoss) {
        const slResp = await syncStopOrder(symbol, positionContext.closeSide, adaptiveProtection.stopPrice, pos.quantity, mode, positionContext.closeTradeSide);
        if (slResp.ok) {
          newSl = adaptiveProtection.stopPrice;
          results.push(`SL_UPDATE (${mode}): ${symbol} adaptive break-even -> ${adaptiveProtection.stopPrice}`);
        }
      } else if (effectiveSelfManaged) {
        const trailingStep = getSelfManagedTrailingStep(marketMovePercent);
        if (trailingStep !== null) {
          const targetSlPrice = pos.entryPrice * (1 + (trailingStep / 100));
          if (targetSlPrice > pos.stopLoss) {
            const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
            if (slResp.ok) {
              newSl = targetSlPrice;
              results.push(`SL_UPDATE (${mode}): ${symbol} self trailing -> ${targetSlPrice}`);
            }
          }
        } else if (marketMovePercent >= 0.5) {
          const targetSlPrice = pos.entryPrice * (1 + entryComm) / (1 - comm);
          if (targetSlPrice > pos.stopLoss) {
            const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
            if (slResp.ok) {
              newSl = targetSlPrice;
              results.push(`SL_UPDATE (${mode}): ${symbol} -> breakeven+fees`);
            }
          }
        }
      } else if (breakEvenOnlyEnabled && marketMovePercent >= 0.5) {
        const targetSlPrice = pos.entryPrice * (1 + entryComm) / (1 - comm);
        if (targetSlPrice > pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} breakeven -> ${targetSlPrice}`);
          } else {
            results.push(`SL_SYNC_WARNING (${mode}): ${symbol} breakeven -> ${slResp.message}`);
          }
        }
      } else if (autoManaged && trailingEnabled && marketMovePercent >= 1) {
        const crossedStep = Math.floor(marketMovePercent / 0.5) * 0.5;
        const crossedPrice = pos.entryPrice * (1 + crossedStep / 100);
        const targetSlPrice = crossedPrice * (1 - 0.5 / 100);
        if (targetSlPrice > pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} trailing -> ${targetSlPrice}`);
          }
        }
      } else if (autoManaged && breakEvenEnabled && marketMovePercent >= 0.5) {
        const targetSlPrice = pos.entryPrice * (1 + entryComm) / (1 - comm);
        if (targetSlPrice > pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} -> breakeven+fees`);
          }
        }
      }

      if (fixedManaged || stratManaged) {
        const stopTouched = currentPrice <= newSl || (recentLow !== null && recentLow <= newSl);
        const takeProfitTouched = hasTakeProfit && (currentPrice >= takeProfit || (recentHigh !== null && recentHigh >= takeProfit));
        if (stopTouched) {
          stopLossTriggered = true;
        } else if (takeProfitTouched) {
          takeProfitTriggered = true;
          // Track if TP was hit by recentHigh (candle high) or currentPrice (now)
          // Use recentHigh as fallback if it was the one that touched TP
          if (recentHigh !== null && recentHigh >= takeProfit && currentPrice < takeProfit) {
            // TP was hit by the candle high but price moved below it
            // Store the highest point that touched TP for fallback
            (pos as any)._tpTouchPrice = recentHigh;
          } else {
            (pos as any)._tpTouchPrice = currentPrice;
          }
        }
      }
    } else if (!exhaustionTriggered) { // short
      if (trendManaged && effectiveMovePercent > 1) {
        const targetSlPrice = pos.entryPrice * (1 - entryComm) / (1 + comm);
        if (targetSlPrice < pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} trend breakeven -> ${targetSlPrice}`);
          } else {
            results.push(`SL_SYNC_WARNING (${mode}): ${symbol} trend breakeven -> ${slResp.message}`);
          }
        }
      } else if (autoManaged && takeProfitAutoCloseEnabled && hasTakeProfit && currentPrice <= takeProfit) {
        takeProfitTriggered = true;
      } else if (adaptiveProtection && trailingEnabled && adaptiveProtection.stopPrice < pos.stopLoss) {
        const slResp = await syncStopOrder(symbol, positionContext.closeSide, adaptiveProtection.stopPrice, pos.quantity, mode, positionContext.closeTradeSide);
        if (slResp.ok) {
          newSl = adaptiveProtection.stopPrice;
          results.push(`SL_UPDATE (${mode}): ${symbol} adaptive ${adaptiveProtection.reason} -> ${adaptiveProtection.stopPrice}`);
        }
      } else if (adaptiveProtection && breakEvenEnabled && adaptiveProtection.reason === 'break_even' && adaptiveProtection.stopPrice < pos.stopLoss) {
        const slResp = await syncStopOrder(symbol, positionContext.closeSide, adaptiveProtection.stopPrice, pos.quantity, mode, positionContext.closeTradeSide);
        if (slResp.ok) {
          newSl = adaptiveProtection.stopPrice;
          results.push(`SL_UPDATE (${mode}): ${symbol} adaptive break-even -> ${adaptiveProtection.stopPrice}`);
        }
      } else if (effectiveSelfManaged) {
        const trailingStep = getSelfManagedTrailingStep(marketMovePercent);
        if (trailingStep !== null) {
          const targetSlPrice = pos.entryPrice * (1 - (trailingStep / 100));
          if (targetSlPrice < pos.stopLoss) {
            const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
            if (slResp.ok) {
              newSl = targetSlPrice;
              results.push(`SL_UPDATE (${mode}): ${symbol} self trailing -> ${targetSlPrice}`);
            }
          }
        } else if (marketMovePercent >= 0.5) {
          const targetSlPrice = pos.entryPrice * (1 - entryComm) / (1 + comm);
          if (targetSlPrice < pos.stopLoss) {
            const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
            if (slResp.ok) {
              newSl = targetSlPrice;
              results.push(`SL_UPDATE (${mode}): ${symbol} -> breakeven+fees`);
            }
          }
        }
      } else if (breakEvenOnlyEnabled && marketMovePercent >= 0.5) {
        const targetSlPrice = pos.entryPrice * (1 - entryComm) / (1 + comm);
        if (targetSlPrice < pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} breakeven -> ${targetSlPrice}`);
          } else {
            results.push(`SL_SYNC_WARNING (${mode}): ${symbol} breakeven -> ${slResp.message}`);
          }
        }
      } else if (autoManaged && trailingEnabled && marketMovePercent >= 1) {
        const crossedStep = Math.floor(marketMovePercent / 0.5) * 0.5;
        const crossedPrice = pos.entryPrice * (1 - crossedStep / 100);
        const targetSlPrice = crossedPrice * (1 + 0.5 / 100);
        if (targetSlPrice < pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} trailing -> ${targetSlPrice}`);
          }
        }
      } else if (autoManaged && breakEvenEnabled && marketMovePercent >= 0.5) {
        const targetSlPrice = pos.entryPrice * (1 - entryComm) / (1 + comm);
        if (targetSlPrice < pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} -> breakeven+fees`);
          }
        }
      }

      if (fixedManaged || stratManaged) {
        const stopTouched = currentPrice >= newSl || (recentHigh !== null && recentHigh >= newSl);
        const takeProfitTouched = hasTakeProfit && (currentPrice <= takeProfit || (recentLow !== null && recentLow <= takeProfit));
        if (stopTouched) {
          stopLossTriggered = true;
        } else if (takeProfitTouched) {
          takeProfitTriggered = true;
          // Track if TP was hit by recentLow (candle low) or currentPrice (now)
          // Use recentLow as fallback if it was the one that touched TP
          if (recentLow !== null && recentLow <= takeProfit && currentPrice > takeProfit) {
            // TP was hit by the candle low but price moved above it
            // Store the lowest point that touched TP for fallback
            (pos as any)._tpTouchPrice = recentLow;
          } else {
            (pos as any)._tpTouchPrice = currentPrice;
          }
        }
      }
    }

    if (stopLossTriggered || takeProfitTriggered || exhaustionTriggered) {
      const closeSide = positionContext.closeSide;
      await bitgetCancelAllOrders(symbol, mode);
      const closeResp = await bitgetClosePosition(symbol, closeSide, pos.quantity, mode, positionContext.closeTradeSide);

      if (bitgetOrderSuccess(closeResp)) {
        const stopWasMovedByTrailing = !trendManaged && Math.abs(newSl - previousStopLoss) > Math.max(1e-8, Math.abs(previousStopLoss) * 0.000001);
        const closeReason = exhaustionTriggered
          ? 'exhaustion'
          : stopLossTriggered
            ? (stopWasMovedByTrailing ? 'trailing_stop' : 'stop_loss')
            : 'take_profit';
        // Use TP price as fallback when closing by TP, SL price when closing by SL
        // If TP was touched by recentHigh/recentLow (stored in _tpTouchPrice), use that instead
        const fallbackExitPrice = takeProfitTriggered
          ? ((pos as any)._tpTouchPrice || takeProfit)
          : stopLossTriggered
            ? newSl
            : currentPrice;
        const exchangeClose = await resolveBitgetCloseExecution({
          position: pos as any,
          tradingMode: mode,
          targetTime: new Date(),
          fallbackExitPrice,
          knownCloseResp: closeResp,
          fallbackReason: closeReason,
        });
        const exitPrice = exchangeClose?.exitPrice || currentPrice;
        const closeMetrics = calculateCloseMetrics({
          positionType: pos.positionType,
          entryPrice: pos.entryPrice,
          quantity: pos.quantity,
          entryCommission: entryComm,
          exitCommission: comm,
          exitPrice,
        });
        await prisma.position.update({
          where: { id: pos.id },
          data: {
            status: 'closed',
            closedAt: exchangeClose?.closedAt || new Date(),
            profitLossPercent: closeMetrics.profitPercent,
            profitLossFiat: closeMetrics.profitFiat,
            maxProfitPercent,
            maxProfitAt,
            exitPrice,
            exitReason: exchangeClose?.exitReason || closeReason,
            exitOrderId: exchangeClose?.exitOrderId || null,
            exitSource: exchangeClose?.exitSource || null,
            closeOrigin: inferPositionCloseOrigin({
              exitReason: exchangeClose?.exitReason || closeReason,
              exitSource: exchangeClose?.exitSource || null,
            }),
          } as any,
        });
        await notifyPositiveClose({
          symbol,
          tradingMode: mode,
          profitFiat: closeMetrics.profitFiat,
          profitPercent: closeMetrics.profitPercent,
        }).catch((error) => {
          console.error('Failed to send positive close ntfy notification', error);
        });
        pushEvents.push({
          title: exhaustionTriggered
            ? `${symbol} cerrada por agotamiento`
            : stopLossTriggered
              ? `${symbol} stop ejecutado`
              : takeProfitTriggered
                ? `${symbol} take profit ejecutado`
                : `${symbol} cerrada`,
          body: exhaustionTriggered
            ? `La posicion #${pos.id} en ${mode.toUpperCase()} se cerro automaticamente por agotamiento.`
            : stopLossTriggered
              ? `La posicion #${pos.id} en ${mode.toUpperCase()} se cerro automaticamente por ${closeReason === 'trailing_stop' ? 'trailing stop' : 'stop loss'}.`
              : takeProfitTriggered
                ? `La posicion #${pos.id} en ${mode.toUpperCase()} se cerro automaticamente por take profit.`
                : `La posicion #${pos.id} en ${mode.toUpperCase()} se cerro automaticamente.`,
          data: {
            kind: exhaustionTriggered
              ? 'position_closed_exhaustion'
              : stopLossTriggered
                ? (closeReason === 'trailing_stop' ? 'position_closed_trailing_stop' : 'position_closed_stop_loss')
                : takeProfitTriggered
                  ? 'position_closed_take_profit'
                  : 'position_closed',
            positionId: pos.id,
            symbol,
            tradingMode: mode,
            profitPercent: Number(closeMetrics.profitPercent.toFixed(2)),
            profitFiat: Number(closeMetrics.profitFiat.toFixed(2)),
          },
        });
        results.push(
          exhaustionTriggered
            ? `EXHAUSTION_CERRADA (${mode}): Position #${pos.id} (${symbol}) cerrada por ${exhaustionReason === 'flat_timeout' ? 'lateralidad prolongada' : 'agotamiento con retroceso'}.`
            : stopLossTriggered
              ? `SL_CERRADA (${mode}): Position #${pos.id} (${symbol}) cerrada por ${closeReason === 'trailing_stop' ? 'trailing stop' : 'stop loss'}.`
              : takeProfitTriggered
                ? `TP_CERRADA (${mode}): Position #${pos.id} (${symbol}) closed por take profit.`
                : `CERRADA (${mode}): Position #${pos.id} (${symbol}) closed.`
        );
      }
    } else {
      await prisma.position.update({
        where: { id: pos.id },
        data: {
          stopLoss: newSl,
          profitLossPercent: profitPercent,
          profitLossFiat: profitFiat,
          maxProfitPercent,
          maxProfitAt,
        },
      });
      results.push(
        stratManaged
          ? `OK_STRAT (${mode}): #${pos.id} ${symbol} | Price: ${currentPrice} | PnL: ${profitPercent.toFixed(2)}% | ` +
          (trailingEnabled
            ? 'Trailing SELF activo'
            : breakEvenEnabled
              ? 'Breakeven activo'
              : 'SL/TP fijos')
          : trendManaged
            ? `OK_TREND (${mode}): #${pos.id} ${symbol} | Price: ${currentPrice} | PnL: ${profitPercent.toFixed(2)}% | Breakeven > 1%`
          : `OK (${mode}): #${pos.id} ${symbol} | Price: ${currentPrice} | PnL: ${profitPercent.toFixed(2)}%`
      );
    }
  }

  await writeAuditLog({
    action: 'monitor.run',
    userId: actorUserId,
    targetType: 'monitor',
    metadata: { resultCount: results.length },
    req,
  });

  for (const event of pushEvents) {
    await notifyAllActiveDevices(event).catch(() => undefined);
  }

  return ok({ results, snapshot: await buildDashboardSnapshot(dashboardMode) }, 'Monitor run completed');
}

export async function GET(req: NextRequest) {
  const internalSecret = req.headers.get('x-monitor-secret');
  if (MONITOR_INTERNAL_SECRET && internalSecret === MONITOR_INTERNAL_SECRET) {
    return runMonitor(req);
  }

  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  return runMonitor(req, auth.auth.user.id);
}

export async function POST(req: NextRequest) {
  const internalSecret = req.headers.get('x-monitor-secret');
  if (!MONITOR_INTERNAL_SECRET || internalSecret !== MONITOR_INTERNAL_SECRET) {
    return fail(401, 'Invalid monitor secret');
  }

  return runMonitor(req);
}
