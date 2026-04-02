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

  const realPositions = await binanceGetPositions();
  const apiOk = Array.isArray(realPositions) && realPositions.length > 0;
  const results: string[] = [];

  if (apiOk) {
    const realMap: Record<string, any> = {};
    realPositions.forEach((rp: any) => {
      if (rp.symbol && parseFloat(rp.positionAmt) !== 0) {
        realMap[rp.symbol.toUpperCase()] = rp;
      }
    });

    for (const pos of positions) {
      const symbol = pos.symbol.toUpperCase();
      if (!realMap[symbol]) {
        // Closed on Binance, sync DB
        const currentPrice = (await binanceGetPrice(symbol)) || pos.entryPrice;
        const comm = await binanceGetCommissionRate(symbol);
        const entryCost = pos.entryPrice * pos.quantity * ((pos as any).commission ?? 0.0004);
        const exitCost = currentPrice * pos.quantity * comm;

        const profitFiat = pos.positionType === 'buy'
          ? ((currentPrice - pos.entryPrice) * pos.quantity) - entryCost - exitCost
          : ((pos.entryPrice - currentPrice) * pos.quantity) - entryCost - exitCost;
        
        const profitPercent = (profitFiat / (pos.entryPrice * pos.quantity)) * 100;

        await binanceCancelAllOrders(symbol);
        await prisma.position.update({
          where: { id: pos.id },
          data: {
            status: 'closed',
            closedAt: new Date(),
            profitLossPercent: profitPercent,
            profitLossFiat: profitFiat,
          },
        });
        results.push(`SINC_CERRADA: Position #${pos.id} (${symbol}) closed on Binance. Updated DB.`);
      }
    }
  } else {
    results.push('ADVERTENCIA: Binance API not available or empty. Skipping sync, only local trailing SL.');
  }

  // Reload open positions
  const freshPositions = await prisma.position.findMany({ where: { status: 'open' } });

  for (const pos of freshPositions) {
    const symbol = pos.symbol.toUpperCase();
    const currentPrice = await binanceGetPrice(symbol);
    if (!currentPrice) {
      results.push(`ERROR: Failed to fetch price for ${symbol}.`);
      continue;
    }

    const comm = await binanceGetCommissionRate(symbol);
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
      // 0.5% -> 0.0%, 1.0% -> 0.5%, 1.5% -> 1.0%, ...
      targetProfitSlPercent = Math.floor(profitPercent / 0.5) * 0.5 - 0.5;
    }

    if (pos.positionType === 'buy') {
      if (currentPrice <= pos.stopLoss) {
        slTriggered = true;
      } else if (targetProfitSlPercent !== null) {
        // Calculate price that gives targetProfitSlPercent for a BUY position
        const targetSlPrice = pos.entryPrice * (targetProfitSlPercent / 100 + 1 + ((pos as any).commission ?? 0.0004)) / (1 - comm);
        
        if (targetSlPrice > pos.stopLoss) {
          // Cancel existing SL algo orders first, then place the new SL
          await binanceCancelAlgoOrders(symbol);
          const slResp = await binancePlaceStopMarket(symbol, 'SELL', targetSlPrice, pos.quantity);
          if (binanceOrderSuccess(slResp)) {
            newSl = targetSlPrice;
            results.push(`TRAILING_SL: Profit=${profitPercent.toFixed(2)}% | SL moved to ${targetProfitSlPercent}% (${newSl.toFixed(6)})`);
          } else {
            results.push(`ERROR_SL: Failed to move SL for ${symbol} on Binance. Resp: ${JSON.stringify(slResp)}`);
          }
        }
      }
    } else { // short
      if (currentPrice >= pos.stopLoss) {
        slTriggered = true;
      } else if (targetProfitSlPercent !== null) {
        // Calculate price that gives targetProfitSlPercent for a SELL position
        const targetSlPrice = pos.entryPrice * (1 - ((pos as any).commission ?? 0.0004) - (targetProfitSlPercent / 100)) / (1 + comm);

        if (targetSlPrice < pos.stopLoss) {
          // Cancel existing SL algo orders first, then place the new SL
          await binanceCancelAlgoOrders(symbol);
          const slResp = await binancePlaceStopMarket(symbol, 'BUY', targetSlPrice, pos.quantity);
          if (binanceOrderSuccess(slResp)) {
            newSl = targetSlPrice;
            results.push(`TRAILING_SL: Profit=${profitPercent.toFixed(2)}% | SL moved to ${targetProfitSlPercent}% (${newSl.toFixed(6)})`);
          } else {
            results.push(`ERROR_SL: Failed to move SL for ${symbol} on Binance. Resp: ${JSON.stringify(slResp)}`);
          }
        }
      }
    }

    if (slTriggered) {
      const closeSide = (pos.positionType === 'buy' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
      await binanceCancelAllOrders(symbol);
      const closeResp = await binanceClosePosition(symbol, closeSide, pos.quantity);

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
        results.push(`SL_CERRADA: Position #${pos.id} (${symbol}) closed by local SL at ${currentPrice}.`);
      } else {
        results.push(`SL_ERROR: Failed to close #${pos.id} on Binance.`);
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
      results.push(`OK: #${pos.id} ${symbol} | Price: ${currentPrice} | SL: ${newSl} | PnL: ${profitPercent.toFixed(2)}%`);
    }
  }

  return NextResponse.json({ results });
}
