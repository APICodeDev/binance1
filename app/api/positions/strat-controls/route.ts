export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { normalizePositionManagementMode } from '@/lib/positions';
import {
  bitgetBuildPositionContext,
  bitgetEnsureVerifiedStopOrder,
  bitgetGetCommissionRate,
  bitgetGetPositionMode,
  bitgetGetPrice,
} from '@/lib/bitget';

const getSelfManagedTrailingStep = (marketMovePercent: number) => {
  if (marketMovePercent < 1.25) {
    return null;
  }

  const lockedPercent = Math.floor((marketMovePercent - 0.25) + 1e-9);
  return lockedPercent >= 1 ? lockedPercent : null;
};

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await req.json().catch(() => null);
  const id = Number(body?.id || 0);

  if (!Number.isFinite(id) || id <= 0) {
    return fail(400, 'Position id is required');
  }

  if (typeof body?.stratBreakEvenEnabled !== 'boolean' && typeof body?.stratTrailingEnabled !== 'boolean') {
    return fail(400, 'At least one strat control flag is required');
  }

  const position = await prisma.position.findUnique({ where: { id } });
  if (!position || position.status !== 'open') {
    return fail(404, 'Open position not found');
  }

  if (normalizePositionManagementMode(position.managementMode) !== 'strat') {
    return fail(400, 'Strat controls are only available for strat positions');
  }

  const nextBreakEvenEnabled = typeof body.stratBreakEvenEnabled === 'boolean'
    ? body.stratBreakEvenEnabled
    : Boolean((position as any).stratBreakEvenEnabled);
  const nextTrailingEnabled = typeof body.stratTrailingEnabled === 'boolean'
    ? body.stratTrailingEnabled
    : Boolean((position as any).stratTrailingEnabled);

  const tradingMode = ((position as any).tradingMode || 'demo') as 'demo' | 'live';
  const symbol = position.symbol.toUpperCase();

  let updatedStopLoss = position.stopLoss;
  let immediateSyncMessage: string | null = null;

  if (nextBreakEvenEnabled || nextTrailingEnabled) {
    const [currentPrice, exitCommission, positionMode] = await Promise.all([
      bitgetGetPrice(symbol, tradingMode).catch(() => false),
      bitgetGetCommissionRate(symbol, tradingMode).catch(() => position.commission ?? 0.0006),
      bitgetGetPositionMode(symbol, tradingMode).catch(() => 'one_way_mode' as const),
    ]);

    if (typeof currentPrice === 'number' && Number.isFinite(currentPrice) && currentPrice > 0) {
      const entryCommission = position.commission ?? exitCommission;
      const marketMovePercent = position.positionType === 'buy'
        ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

      let candidateStop: number | null = null;
      if (nextTrailingEnabled) {
        const trailingStep = getSelfManagedTrailingStep(marketMovePercent);
        if (trailingStep !== null) {
          candidateStop = position.positionType === 'buy'
            ? position.entryPrice * (1 + (trailingStep / 100))
            : position.entryPrice * (1 - (trailingStep / 100));
        } else if (marketMovePercent >= 0.5) {
          candidateStop = position.positionType === 'buy'
            ? position.entryPrice * (1 + entryCommission) / (1 - exitCommission)
            : position.entryPrice * (1 - entryCommission) / (1 + exitCommission);
        }
      } else if (nextBreakEvenEnabled && marketMovePercent >= 0.5) {
        candidateStop = position.positionType === 'buy'
          ? position.entryPrice * (1 + entryCommission) / (1 - exitCommission)
          : position.entryPrice * (1 - entryCommission) / (1 + exitCommission);
      }

      const shouldImproveStop = candidateStop !== null && (
        (position.positionType === 'buy' && candidateStop > position.stopLoss) ||
        (position.positionType === 'sell' && candidateStop < position.stopLoss)
      );

      if (shouldImproveStop && candidateStop !== null) {
        const positionContext = bitgetBuildPositionContext(position.positionType as 'buy' | 'sell', positionMode || 'one_way_mode');
        const syncResult = await bitgetEnsureVerifiedStopOrder({
          symbol,
          side: positionContext.closeSide,
          stopPrice: candidateStop,
          quantity: position.quantity,
          tradingMode,
          tradeSide: positionContext.closeTradeSide,
        });

        if (!syncResult.ok) {
          return fail(500, `Unable to verify stop order on Bitget for ${symbol}`, syncResult.message);
        }

        updatedStopLoss = candidateStop;
        immediateSyncMessage = syncResult.message;
      }
    }
  }

  const updated = await prisma.position.update({
    where: { id: position.id },
    data: {
      stratBreakEvenEnabled: nextBreakEvenEnabled,
      stratTrailingEnabled: nextTrailingEnabled,
      stopLoss: updatedStopLoss,
    } as any,
  });

  await writeAuditLog({
    action: 'position.strat_controls_updated',
    userId: auth.auth.user.id,
    targetType: 'position',
    targetId: String(position.id),
    metadata: {
      symbol,
      tradingMode,
      stratBreakEvenEnabled: nextBreakEvenEnabled,
      stratTrailingEnabled: nextTrailingEnabled,
      previousStopLoss: position.stopLoss,
      updatedStopLoss,
      immediateSyncMessage,
    },
    req,
  });

  return ok({
    position: updated,
    immediateSyncMessage,
  }, immediateSyncMessage
    ? 'Strat controls updated and synchronized with Bitget'
    : 'Strat controls updated');
}
