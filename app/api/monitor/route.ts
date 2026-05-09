// app/api/monitor/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { fail, ok } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { calculateCloseMetrics, normalizePositionManagementMode, resolveBitgetCloseExecution } from '@/lib/positions';
import { attachTakeProfitUpgradeMeta } from '@/lib/positionSignals';
import { notifyAllActiveDevices } from '@/lib/pushNotifications';
import {
  bitgetBuildPositionContext,
  bitgetGetPrice, 
  bitgetGetPositionMode,
  bitgetGetPositions, 
  bitgetGetSinglePosition,
  bitgetCancelAllOrders, 
  bitgetCancelAlgoOrders,
  bitgetGetPendingStopOrders,
  bitgetModifyStopOrder,
  bitgetCancelPlanOrdersByIds,
  bitgetOrderSuccess, 
  bitgetClosePosition, 
  bitgetPlaceStopMarket,
  bitgetGetCommissionRate
} from '@/lib/bitget';

const MONITOR_INTERNAL_SECRET = process.env.MONITOR_INTERNAL_SECRET || '';
const EXHAUSTION_MIN_MFE_PERCENT = 1.0;
const EXHAUSTION_MIN_STAGNATION_MS = 90 * 60 * 1000;
const EXHAUSTION_MIN_RETRACEMENT_RATIO = 0.35;
const EXHAUSTION_FLAT_MIN_MFE_PERCENT = 1.5;
const EXHAUSTION_FLAT_MIN_PROFIT_PERCENT = 1.0;
const EXHAUSTION_FLAT_MIN_STAGNATION_MS = 120 * 60 * 1000;
const EXHAUSTION_FLAT_MAX_GIVEBACK_PERCENT = 0.25;
const DASHBOARD_SETTING_KEYS = [
  'bot_enabled',
  'custom_amount',
  'last_entry_error',
  'trading_mode',
  'leverage_enabled',
  'leverage_value',
  'profit_sound_enabled',
  'profit_sound_file',
  'api_stop_mode',
  'exhaustion_guard_enabled',
  'take_profit_auto_close_enabled',
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
      trading_mode: settingsMap.trading_mode || 'demo',
      leverage_enabled: settingsMap.leverage_enabled || '0',
      leverage_value: settingsMap.leverage_value || '1',
      profit_sound_enabled: settingsMap.profit_sound_enabled || '0',
      profit_sound_file: settingsMap.profit_sound_file || '',
      api_stop_mode: settingsMap.api_stop_mode || 'signal',
      exhaustion_guard_enabled: settingsMap.exhaustion_guard_enabled || '1',
      take_profit_auto_close_enabled: settingsMap.take_profit_auto_close_enabled || '0',
    },
  };
}

export async function runMonitor(req: NextRequest, actorUserId?: number) {
  const dashboardMode = getDashboardMode(req);
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

  const syncStopOrder = async (
    symbol: string,
    side: 'BUY' | 'SELL',
    stopPrice: number,
    quantity: number,
    mode: 'demo' | 'live',
    tradeSide?: 'open' | 'close'
  ) => {
    const pending = await bitgetGetPendingStopOrders(symbol, mode);
    if (!pending.ok) {
      return { ok: false, message: pending.error || 'Unable to fetch pending stop orders' };
    }

    const stopOrders = pending.orders.filter((order: any) => order.planType === 'normal_plan');
    const primary = stopOrders[0];
    const extras = stopOrders.slice(1).map((order: any) => order.orderId).filter(Boolean);

    if (extras.length > 0) {
      await bitgetCancelPlanOrdersByIds(symbol, extras, mode);
    }

    if (primary?.orderId) {
      const currentTriggerPrice = Number.parseFloat(String(primary.triggerPrice || ''));
      if (Number.isFinite(currentTriggerPrice) && Math.abs(currentTriggerPrice - stopPrice) < Math.max(1e-8, stopPrice * 0.000001)) {
        return { ok: true, message: 'unchanged' };
      }

      const modifyResp = await bitgetModifyStopOrder(symbol, primary.orderId, stopPrice, mode);
      if (bitgetOrderSuccess(modifyResp)) {
        return { ok: true, message: 'modified' };
      }
    }

    await bitgetCancelAlgoOrders(symbol, mode);
    const placeResp = await bitgetPlaceStopMarket(symbol, side, stopPrice, quantity, mode, tradeSide);
    if (bitgetOrderSuccess(placeResp)) {
      return { ok: true, message: 'placed' };
    }

    return { ok: false, message: placeResp?.msg || placeResp?.message || JSON.stringify(placeResp) };
  };

  const getSelfManagedTrailingStep = (marketMovePercent: number) => {
    if (marketMovePercent < 1.25) {
      return null;
    }

    const lockedPercent = Math.floor((marketMovePercent - 0.25) + 1e-9);
    return lockedPercent >= 1 ? lockedPercent : null;
  };

  for (const pos of positions) {
    const mode = ((pos as any).tradingMode || 'demo') as 'demo' | 'live';
    const managementMode = normalizePositionManagementMode((pos as any).managementMode);
    const selfManaged = managementMode === 'self';
    const stratManaged = managementMode === 'strat';
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
      const entryComm = (pos as any).commission ?? comm;
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
        } as any,
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

    const comm = await bitgetGetCommissionRate(symbol, mode);
    const entryComm = (pos as any).commission ?? comm;
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
    const stagnationMs = maxProfitAt ? (Date.now() - maxProfitAt.getTime()) : 0;
    const retracementRatio = maxProfitPercent > 0
      ? Math.max(0, (maxProfitPercent - profitPercent) / maxProfitPercent)
      : 0;
    const givebackPercent = Math.max(0, maxProfitPercent - profitPercent);

    let newSl = pos.stopLoss;
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

    if (!selfManaged) {
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
      if (autoManaged && takeProfitAutoCloseEnabled && hasTakeProfit && currentPrice >= takeProfit) {
        takeProfitTriggered = true;
      } else if (selfManaged) {
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
      } else if (autoManaged && marketMovePercent >= 1) {
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
      } else if (autoManaged && marketMovePercent >= 0.5) {
        const targetSlPrice = pos.entryPrice * (1 + entryComm) / (1 - comm);
        if (targetSlPrice > pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} -> breakeven+fees`);
          }
        }
      }
    } else if (!exhaustionTriggered) { // short
      if (autoManaged && takeProfitAutoCloseEnabled && hasTakeProfit && currentPrice <= takeProfit) {
        takeProfitTriggered = true;
      } else if (selfManaged) {
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
      } else if (autoManaged && marketMovePercent >= 1) {
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
      } else if (autoManaged && marketMovePercent >= 0.5) {
        const targetSlPrice = pos.entryPrice * (1 - entryComm) / (1 + comm);
        if (targetSlPrice < pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, positionContext.closeSide, targetSlPrice, pos.quantity, mode, positionContext.closeTradeSide);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} -> breakeven+fees`);
          }
        }
      }
    }

    if (takeProfitTriggered || exhaustionTriggered) {
      const closeSide = positionContext.closeSide;
      await bitgetCancelAllOrders(symbol, mode);
      const closeResp = await bitgetClosePosition(symbol, closeSide, pos.quantity, mode, positionContext.closeTradeSide);

      if (bitgetOrderSuccess(closeResp)) {
        const exchangeClose = await resolveBitgetCloseExecution({
          position: pos as any,
          tradingMode: mode,
          targetTime: new Date(),
          fallbackExitPrice: currentPrice,
          knownCloseResp: closeResp,
          fallbackReason: exhaustionTriggered ? 'exhaustion' : 'take_profit',
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
            exitReason: exchangeClose?.exitReason || (exhaustionTriggered ? 'exhaustion' : 'take_profit'),
            exitOrderId: exchangeClose?.exitOrderId || null,
            exitSource: exchangeClose?.exitSource || null,
          } as any,
        });
        pushEvents.push({
          title: exhaustionTriggered
            ? `${symbol} cerrada por agotamiento`
            : takeProfitTriggered
              ? `${symbol} take profit ejecutado`
              : `${symbol} cerrada`,
          body: exhaustionTriggered
            ? `La posicion #${pos.id} en ${mode.toUpperCase()} se cerro automaticamente por agotamiento.`
            : takeProfitTriggered
              ? `La posicion #${pos.id} en ${mode.toUpperCase()} se cerro automaticamente por take profit.`
              : `La posicion #${pos.id} en ${mode.toUpperCase()} se cerro automaticamente.`,
          data: {
            kind: exhaustionTriggered
              ? 'position_closed_exhaustion'
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
          ? `OK_STRAT (${mode}): #${pos.id} ${symbol} | Price: ${currentPrice} | PnL: ${profitPercent.toFixed(2)}% | SL fijo sin trailing`
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
