// app/api/monitor/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { 
  binanceGetPrice, 
  binanceGetPositions, 
  binanceCancelAllOrders, 
  binanceCancelAlgoOrders,
  binanceOrderSuccess, 
  binanceClosePosition, 
  binancePlaceStopMarket,
  binanceGetCommissionRate
} from '@/lib/binance';

export async function GET() {
  const positions = await prisma.position.findMany({ where: { status: 'open' } });

  if (positions.length === 0) {
    return NextResponse.json({ message: 'No open positions to monitor.' });
  }

  // Fetch real positions for both worlds
  const realDemo = await binanceGetPositions('demo');
  const realLive = await binanceGetPositions('live');

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

  const demoMap = buildMap(realDemo);
  const liveMap = buildMap(realLive);

  const results: string[] = [];

  for (const pos of positions) {
    const mode = ((pos as any).tradingMode || 'demo') as 'demo' | 'live';
    const realMap = mode === 'live' ? liveMap : demoMap;
    const symbol = pos.symbol.toUpperCase();

    // 1. Sync with Binance (Closure check)
    if (!realMap[symbol]) {
      const currentPrice = (await binanceGetPrice(symbol, mode)) || pos.entryPrice;
      const comm = await binanceGetCommissionRate(symbol, mode);
      const entryCost = pos.entryPrice * pos.quantity * ((pos as any).commission ?? 0.0004);
      const exitCost = currentPrice * pos.quantity * comm;

      const profitFiat = pos.positionType === 'buy'
        ? ((currentPrice - pos.entryPrice) * pos.quantity) - entryCost - exitCost
        : ((pos.entryPrice - currentPrice) * pos.quantity) - entryCost - exitCost;
      
      const profitPercent = (profitFiat / (pos.entryPrice * pos.quantity)) * 100;

      await binanceCancelAllOrders(symbol, mode);
      await prisma.position.update({
        where: { id: pos.id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          profitLossPercent: profitPercent,
          profitLossFiat: profitFiat,
        },
      });
      results.push(`SINC_CERRADA (${mode}): Position #${pos.id} (${symbol}) closed on Binance.`);
      continue; // Move to next position
    }

    // 2. Trailing Stop and Local SL Check
    const currentPrice = await binanceGetPrice(symbol, mode);
    if (!currentPrice) {
      results.push(`ERROR: Failed to fetch price for ${symbol} in ${mode}.`);
      continue;
    }

    const comm = await binanceGetCommissionRate(symbol, mode);
    const entryCost = pos.entryPrice * pos.quantity * ((pos as any).commission ?? 0.0004);
    const exitCost = currentPrice * pos.quantity * comm;

    const profitFiat = pos.positionType === 'buy'
      ? ((currentPrice - pos.entryPrice) * pos.quantity) - entryCost - exitCost
      : ((pos.entryPrice - currentPrice) * pos.quantity) - entryCost - exitCost;
    
    const profitPercent = (profitFiat / (pos.entryPrice * pos.quantity)) * 100;

    let newSl = pos.stopLoss;
    let slTriggered = false;

    // Trailing SL logic (Staircase)
    let targetProfitSlPercent: number | null = null;
    if (profitPercent >= 0.5) {
      targetProfitSlPercent = Math.floor(profitPercent / 0.5) * 0.5 - 0.5;
    }

    if (pos.positionType === 'buy') {
      if (currentPrice <= pos.stopLoss) {
        slTriggered = true;
      } else if (targetProfitSlPercent !== null) {
        const targetSlPrice = pos.entryPrice * (targetProfitSlPercent / 100 + 1 + ((pos as any).commission ?? 0.0004)) / (1 - comm);
        if (targetSlPrice > pos.stopLoss) {
          await binanceCancelAlgoOrders(symbol, mode);
          const slResp = await binancePlaceStopMarket(symbol, 'SELL', targetSlPrice, pos.quantity, mode);
          if (binanceOrderSuccess(slResp)) {
            newSl = targetSlPrice;
          }
        }
      }
    } else { // short
      if (currentPrice >= pos.stopLoss) {
        slTriggered = true;
      } else if (targetProfitSlPercent !== null) {
        const targetSlPrice = pos.entryPrice * (1 - ((pos as any).commission ?? 0.0004) - (targetProfitSlPercent / 100)) / (1 + comm);
        if (targetSlPrice < pos.stopLoss) {
          await binanceCancelAlgoOrders(symbol, mode);
          const slResp = await binancePlaceStopMarket(symbol, 'BUY', targetSlPrice, pos.quantity, mode);
          if (binanceOrderSuccess(slResp)) {
            newSl = targetSlPrice;
          }
        }
      }
    }

    if (slTriggered) {
      const closeSide = (pos.positionType === 'buy' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
      await binanceCancelAllOrders(symbol, mode);
      const closeResp = await binanceClosePosition(symbol, closeSide, pos.quantity, mode);

      if (binanceOrderSuccess(closeResp)) {
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
