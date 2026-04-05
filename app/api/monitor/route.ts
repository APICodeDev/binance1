// app/api/monitor/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { 
  bitgetGetPrice, 
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

export async function GET() {
  const positions = await prisma.position.findMany({ where: { status: 'open' } });

  if (positions.length === 0) {
    return NextResponse.json({ message: 'No open positions to monitor.' });
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

  const syncStopOrder = async (
    symbol: string,
    side: 'BUY' | 'SELL',
    stopPrice: number,
    quantity: number,
    mode: 'demo' | 'live'
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
      const modifyResp = await bitgetModifyStopOrder(symbol, primary.orderId, stopPrice, mode);
      if (bitgetOrderSuccess(modifyResp)) {
        return { ok: true, message: 'modified' };
      }
    }

    await bitgetCancelAlgoOrders(symbol, mode);
    const placeResp = await bitgetPlaceStopMarket(symbol, side, stopPrice, quantity, mode);
    if (bitgetOrderSuccess(placeResp)) {
      return { ok: true, message: 'placed' };
    }

    return { ok: false, message: placeResp?.msg || placeResp?.message || JSON.stringify(placeResp) };
  };

  for (const pos of positions) {
    const mode = ((pos as any).tradingMode || 'demo') as 'demo' | 'live';
    const realMap = mode === 'live' ? liveMap : demoMap;
    const snapshot = mode === 'live' ? realLive : realDemo;
    const symbol = pos.symbol.toUpperCase();

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

      const currentPrice = (await bitgetGetPrice(symbol, mode)) || pos.entryPrice;
      const comm = await bitgetGetCommissionRate(symbol, mode);
      const entryCost = pos.entryPrice * pos.quantity * ((pos as any).commission ?? 0.0004);
      const exitCost = currentPrice * pos.quantity * comm;

      const profitFiat = pos.positionType === 'buy'
        ? ((currentPrice - pos.entryPrice) * pos.quantity) - entryCost - exitCost
        : ((pos.entryPrice - currentPrice) * pos.quantity) - entryCost - exitCost;
      
      const profitPercent = pos.positionType === 'buy'
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

      await bitgetCancelAllOrders(symbol, mode);
      await prisma.position.update({
        where: { id: pos.id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          profitLossPercent: profitPercent,
          profitLossFiat: profitFiat,
        },
      });
      results.push(`SINC_CERRADA (${mode}): Position #${pos.id} (${symbol}) cerrada en Bitget.`);
      continue; // Move to next position
    }

    // 2. Trailing Stop and Local SL Check
    const currentPrice = await bitgetGetPrice(symbol, mode);
    if (!currentPrice) {
      results.push(`ERROR: Failed to fetch price for ${symbol} in ${mode}.`);
      continue;
    }

    const comm = await bitgetGetCommissionRate(symbol, mode);
    const entryCost = pos.entryPrice * pos.quantity * ((pos as any).commission ?? 0.0004);
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

    let newSl = pos.stopLoss;
    let slTriggered = false;

    if (pos.positionType === 'buy') {
      if (currentPrice <= pos.stopLoss) {
        slTriggered = true;
      } else if (marketMovePercent >= 1) {
        const crossedStep = Math.floor(marketMovePercent / 0.5) * 0.5;
        const crossedPrice = pos.entryPrice * (1 + crossedStep / 100);
        const targetSlPrice = crossedPrice * (1 - 0.5 / 100);
        if (targetSlPrice > pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, 'SELL', targetSlPrice, pos.quantity, mode);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} trailing -> ${targetSlPrice}`);
          }
        }
      } else if (marketMovePercent >= 0.5) {
        const targetSlPrice = pos.entryPrice * (1 + ((pos as any).commission ?? 0.0004)) / (1 - comm);
        if (targetSlPrice > pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, 'SELL', targetSlPrice, pos.quantity, mode);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} -> breakeven+fees`);
          }
        }
      }
    } else { // short
      if (currentPrice >= pos.stopLoss) {
        slTriggered = true;
      } else if (marketMovePercent >= 1) {
        const crossedStep = Math.floor(marketMovePercent / 0.5) * 0.5;
        const crossedPrice = pos.entryPrice * (1 - crossedStep / 100);
        const targetSlPrice = crossedPrice * (1 + 0.5 / 100);
        if (targetSlPrice < pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, 'BUY', targetSlPrice, pos.quantity, mode);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} trailing -> ${targetSlPrice}`);
          }
        }
      } else if (marketMovePercent >= 0.5) {
        const targetSlPrice = pos.entryPrice * (1 - ((pos as any).commission ?? 0.0004)) / (1 + comm);
        if (targetSlPrice < pos.stopLoss) {
          const slResp = await syncStopOrder(symbol, 'BUY', targetSlPrice, pos.quantity, mode);
          if (slResp.ok) {
            newSl = targetSlPrice;
            results.push(`SL_UPDATE (${mode}): ${symbol} -> breakeven+fees`);
          }
        }
      }
    }

    if (slTriggered) {
      const closeSide = (pos.positionType === 'buy' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
      await bitgetCancelAllOrders(symbol, mode);
      const closeResp = await bitgetClosePosition(symbol, closeSide, pos.quantity, mode);

      if (bitgetOrderSuccess(closeResp)) {
        await prisma.position.update({
          where: { id: pos.id },
          data: {
            status: 'closed',
            closedAt: new Date(),
            profitLossPercent: profitPercent,
            profitLossFiat: profitFiat,
          },
        });
        results.push(`SL_CERRADA (${mode}): Position #${pos.id} (${symbol}) closed.`);
      }
    } else {
      await prisma.position.update({
        where: { id: pos.id },
        data: {
          stopLoss: newSl,
          profitLossPercent: profitPercent,
          profitLossFiat: profitFiat,
        },
      });
      results.push(`OK (${mode}): #${pos.id} ${symbol} | Price: ${currentPrice} | PnL: ${profitPercent.toFixed(2)}%`);
    }
  }

  return NextResponse.json({ results });
}
