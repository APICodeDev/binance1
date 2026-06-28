export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/apiResponse';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';
import {
  getManualTrailingOverride,
  isBreakEvenEffectivelyEnabled,
  isTrailingEffectivelyEnabled,
} from '@/lib/positions';
import {
  bitgetBuildPositionContext,
  bitgetEnsureVerifiedStopOrder,
  bitgetGetCommissionRate,
  getDefaultBitgetFeeRate,
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

  const requestedBreakEvenEnabled = typeof body?.breakEvenEnabled === 'boolean'
    ? body.breakEvenEnabled
    : typeof body?.stratBreakEvenEnabled === 'boolean'
      ? body.stratBreakEvenEnabled
      : undefined;
  const requestedTrailingEnabled = typeof body?.trailingEnabled === 'boolean'
    ? body.trailingEnabled
    : typeof body?.stratTrailingEnabled === 'boolean'
      ? body.stratTrailingEnabled
      : undefined;

  if (typeof requestedBreakEvenEnabled !== 'boolean' && typeof requestedTrailingEnabled !== 'boolean') {
    return fail(400, 'At least one protection control flag is required');
  }

  const position = await prisma.position.findUnique({ where: { id } });
  if (!position || position.status !== 'open') {
    return fail(404, 'Open position not found');
  }

  if (requestedBreakEvenEnabled === false) {
    return fail(400, 'Breakeven cannot be manually deactivated once available');
  }

  const previousBreakEvenEnabled = isBreakEvenEffectivelyEnabled(position as any);
  const previousTrailingEnabled = isTrailingEffectivelyEnabled(position as any);
  const previousManualTrailingOverride = getManualTrailingOverride(position as any);
  const nextManualBreakEvenEnabled = Boolean((position as any).manualBreakEvenEnabled) ||
    requestedBreakEvenEnabled === true ||
    requestedTrailingEnabled === true;
  const nextManualTrailingOverride = typeof requestedTrailingEnabled === 'boolean'
    ? requestedTrailingEnabled
    : previousManualTrailingOverride;
  const nextEffectivePosition = {
    ...position,
    manualBreakEvenEnabled: nextManualBreakEvenEnabled,
    manualTrailingOverride: nextManualTrailingOverride,
  } as any;
  const nextBreakEvenEnabled = isBreakEvenEffectivelyEnabled(nextEffectivePosition);
  const nextTrailingEnabled = isTrailingEffectivelyEnabled(nextEffectivePosition);

  const tradingMode = ((position as any).tradingMode || 'demo') as 'demo' | 'live';
  const symbol = position.symbol.toUpperCase();
  const trailingJustEnabled = nextTrailingEnabled && !previousTrailingEnabled;

  let updatedStopLoss = position.stopLoss;
  let immediateSyncMessage: string | null = null;

  if (nextBreakEvenEnabled || nextTrailingEnabled) {
    const [currentPrice, exitCommission, positionMode] = await Promise.all([
      bitgetGetPrice(symbol, tradingMode).catch(() => false),
      bitgetGetCommissionRate(symbol, tradingMode).catch(() => getDefaultBitgetFeeRate(tradingMode)),
      bitgetGetPositionMode(symbol, tradingMode).catch(() => 'one_way_mode' as const),
    ]);

    if (typeof currentPrice === 'number' && Number.isFinite(currentPrice) && currentPrice > 0) {
      const entryCommission = exitCommission;
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
        immediateSyncMessage = trailingJustEnabled
          ? `Trailing enabled. Stop synchronized: ${syncResult.message}.`
          : syncResult.message;
      }
    }
  }

  const updated = await prisma.position.update({
    where: { id: position.id },
    data: {
      manualBreakEvenEnabled: nextManualBreakEvenEnabled,
      manualTrailingOverride: nextManualTrailingOverride,
      stopLoss: updatedStopLoss,
    } as any,
  });

  await writeAuditLog({
    action: 'position.protection_controls_updated',
    userId: auth.auth.user.id,
    targetType: 'position',
    targetId: String(position.id),
    metadata: {
      symbol,
      tradingMode,
      previousBreakEvenEnabled,
      previousTrailingEnabled,
      stratBreakEvenEnabled: nextBreakEvenEnabled,
      stratTrailingEnabled: nextTrailingEnabled,
      manualBreakEvenEnabled: nextManualBreakEvenEnabled,
      manualTrailingOverride: nextManualTrailingOverride,
      previousStopLoss: position.stopLoss,
      updatedStopLoss,
      immediateSyncMessage,
      trailingJustEnabled,
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
