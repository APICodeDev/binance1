import { prisma } from '@/lib/db';

type PositionWithId = {
  id: number;
  positionType: string;
  entryPrice: number;
  takeProfit?: number | null;
};

type TakeProfitUpgradeMeta = {
  takeProfitExpanded: boolean;
  takeProfitExpandedAt: string | null;
  takeProfitExpandedFrom: number | null;
  takeProfitExpandedTo: number | null;
  takeProfitExpansionCount: number;
  takeProfitPending: boolean;
  takeProfitPendingAt: string | null;
  takeProfitPendingCode: string | null;
  takeProfitPendingAttempts: number;
  requestedTakeProfitPercent: number | null;
  requestedTakeProfitInputSource: string | null;
  takeProfitTargetPercent: number | null;
};

const POSITION_OPEN_ACTION = 'position.open';
const TAKE_PROFIT_UPGRADE_ACTION = 'position.tp_upgraded_from_signal';
const TAKE_PROFIT_PENDING_ACTION = 'position.open.tp_pending';

const parseOptionalNumber = (value: unknown) => {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const parseOptionalString = (value: unknown) => {
  const raw = String(value ?? '').trim();
  return raw ? raw : null;
};

const computeDirectionalTakeProfitPercent = (
  entryPrice: number,
  takeProfitPrice: number | null,
  positionType: string
) => {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(takeProfitPrice) || !takeProfitPrice || takeProfitPrice <= 0) {
    return null;
  }

  if (positionType === 'sell') {
    return ((entryPrice - takeProfitPrice) / entryPrice) * 100;
  }

  return ((takeProfitPrice - entryPrice) / entryPrice) * 100;
};

export async function attachTakeProfitUpgradeMeta<T extends PositionWithId>(positions: T[]): Promise<Array<T & TakeProfitUpgradeMeta>> {
  if (positions.length === 0) {
    return positions.map((position) => ({
      ...position,
      takeProfitExpanded: false,
      takeProfitExpandedAt: null,
      takeProfitExpandedFrom: null,
      takeProfitExpandedTo: null,
      takeProfitExpansionCount: 0,
      takeProfitPending: false,
      takeProfitPendingAt: null,
      takeProfitPendingCode: null,
      takeProfitPendingAttempts: 0,
      requestedTakeProfitPercent: null,
      requestedTakeProfitInputSource: null,
      takeProfitTargetPercent: null,
    }));
  }

  const ids = positions.map((position) => String(position.id));
  const logs = await prisma.auditLog.findMany({
    where: {
      action: { in: [POSITION_OPEN_ACTION, TAKE_PROFIT_UPGRADE_ACTION, TAKE_PROFIT_PENDING_ACTION] },
      targetType: 'position',
      targetId: { in: ids },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      action: true,
      targetId: true,
      createdAt: true,
      metadata: true,
    },
  });

  const summaryByPositionId = new Map<number, TakeProfitUpgradeMeta>();

  for (const log of logs) {
    const positionId = Number.parseInt(String(log.targetId || ''), 10);
    if (!Number.isFinite(positionId)) {
      continue;
    }

    const metadata = log.metadata && typeof log.metadata === 'object' ? log.metadata as Record<string, unknown> : {};
    const previous = summaryByPositionId.get(positionId);
    const next = previous || {
      takeProfitExpanded: false,
      takeProfitExpandedAt: null,
      takeProfitExpandedFrom: null,
      takeProfitExpandedTo: null,
      takeProfitExpansionCount: 0,
      takeProfitPending: false,
      takeProfitPendingAt: null,
      takeProfitPendingCode: null,
      takeProfitPendingAttempts: 0,
      requestedTakeProfitPercent: null,
      requestedTakeProfitInputSource: null,
      takeProfitTargetPercent: null,
    };

    if (log.action === POSITION_OPEN_ACTION || log.action === TAKE_PROFIT_UPGRADE_ACTION) {
      const requestedTakeProfitPercent = parseOptionalNumber(metadata.requestedTakeProfitPercent);
      const requestedTakeProfitInputSource = parseOptionalString(metadata.requestedTakeProfitInputSource);
      const appliedTakeProfit = parseOptionalNumber(metadata.appliedTakeProfit) ??
        parseOptionalNumber(metadata.appliedTakeProfitPrice) ??
        parseOptionalNumber(metadata.resolvedRequestedTakeProfitPrice);

      summaryByPositionId.set(positionId, {
        ...next,
        requestedTakeProfitPercent,
        requestedTakeProfitInputSource,
        takeProfitTargetPercent: requestedTakeProfitPercent,
        takeProfitExpanded: log.action === TAKE_PROFIT_UPGRADE_ACTION ? true : next.takeProfitExpanded,
        takeProfitExpandedAt: log.action === TAKE_PROFIT_UPGRADE_ACTION ? log.createdAt.toISOString() : next.takeProfitExpandedAt,
        takeProfitExpandedFrom: log.action === TAKE_PROFIT_UPGRADE_ACTION ? parseOptionalNumber(metadata.previousTakeProfit) : next.takeProfitExpandedFrom,
        takeProfitExpandedTo: log.action === TAKE_PROFIT_UPGRADE_ACTION ? appliedTakeProfit : next.takeProfitExpandedTo,
        takeProfitExpansionCount: log.action === TAKE_PROFIT_UPGRADE_ACTION ? (next.takeProfitExpansionCount || 0) + 1 : next.takeProfitExpansionCount,
      });
      continue;
    }

    if (log.action === TAKE_PROFIT_PENDING_ACTION) {
      summaryByPositionId.set(positionId, {
        ...next,
        takeProfitPending: true,
        takeProfitPendingAt: log.createdAt.toISOString(),
        takeProfitPendingCode: String(metadata.responseCode || '') || null,
        takeProfitPendingAttempts: Number.parseInt(String(metadata.attempts || '0'), 10) || 0,
      });
    }
  }

  return positions.map((position) => {
    const meta = summaryByPositionId.get(position.id);
    const pendingResolvedByUpgrade = Boolean(
      meta?.takeProfitPending &&
      meta?.takeProfitPendingAt &&
      meta?.takeProfitExpandedAt &&
      new Date(meta.takeProfitExpandedAt).getTime() >= new Date(meta.takeProfitPendingAt).getTime()
    );
    const fallbackTakeProfitPercent = computeDirectionalTakeProfitPercent(
      position.entryPrice,
      typeof position.takeProfit === 'number' ? position.takeProfit : null,
      position.positionType
    );
    const requestedTakeProfitPercent = meta?.requestedTakeProfitPercent ?? null;
    const takeProfitTargetPercent = requestedTakeProfitPercent ?? fallbackTakeProfitPercent;

    return {
      ...position,
      takeProfitExpanded: meta?.takeProfitExpanded || false,
      takeProfitExpandedAt: meta?.takeProfitExpandedAt || null,
      takeProfitExpandedFrom: meta?.takeProfitExpandedFrom ?? null,
      takeProfitExpandedTo: meta?.takeProfitExpandedTo ?? (typeof position.takeProfit === 'number' ? position.takeProfit : null),
      takeProfitExpansionCount: meta?.takeProfitExpansionCount || 0,
      takeProfitPending: pendingResolvedByUpgrade ? false : (meta?.takeProfitPending || false),
      takeProfitPendingAt: pendingResolvedByUpgrade ? null : (meta?.takeProfitPendingAt || null),
      takeProfitPendingCode: pendingResolvedByUpgrade ? null : (meta?.takeProfitPendingCode || null),
      takeProfitPendingAttempts: pendingResolvedByUpgrade ? 0 : (meta?.takeProfitPendingAttempts || 0),
      requestedTakeProfitPercent,
      requestedTakeProfitInputSource: meta?.requestedTakeProfitInputSource || null,
      takeProfitTargetPercent,
    };
  });
}
