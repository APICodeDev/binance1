import { prisma } from '@/lib/db';

type PositionWithId = {
  id: number;
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
};

const TAKE_PROFIT_UPGRADE_ACTION = 'position.tp_upgraded_from_signal';
const TAKE_PROFIT_PENDING_ACTION = 'position.open.tp_pending';

const parseOptionalNumber = (value: unknown) => {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
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
    }));
  }

  const ids = positions.map((position) => String(position.id));
  const logs = await prisma.auditLog.findMany({
    where: {
      action: { in: [TAKE_PROFIT_UPGRADE_ACTION, TAKE_PROFIT_PENDING_ACTION] },
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
    };

    if (log.action === TAKE_PROFIT_UPGRADE_ACTION) {
      const previousTakeProfit = parseOptionalNumber(metadata.previousTakeProfit);
      const appliedTakeProfit = parseOptionalNumber(metadata.appliedTakeProfit);
      summaryByPositionId.set(positionId, {
        ...next,
        takeProfitExpanded: true,
        takeProfitExpandedAt: log.createdAt.toISOString(),
        takeProfitExpandedFrom: previousTakeProfit,
        takeProfitExpandedTo: appliedTakeProfit,
        takeProfitExpansionCount: (next.takeProfitExpansionCount || 0) + 1,
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

    return {
      ...position,
      takeProfitExpanded: Boolean(meta),
      takeProfitExpandedAt: meta?.takeProfitExpandedAt || null,
      takeProfitExpandedFrom: meta?.takeProfitExpandedFrom ?? null,
      takeProfitExpandedTo: meta?.takeProfitExpandedTo ?? (typeof position.takeProfit === 'number' ? position.takeProfit : null),
      takeProfitExpansionCount: meta?.takeProfitExpansionCount || 0,
      takeProfitPending: pendingResolvedByUpgrade ? false : (meta?.takeProfitPending || false),
      takeProfitPendingAt: pendingResolvedByUpgrade ? null : (meta?.takeProfitPendingAt || null),
      takeProfitPendingCode: pendingResolvedByUpgrade ? null : (meta?.takeProfitPendingCode || null),
      takeProfitPendingAttempts: pendingResolvedByUpgrade ? 0 : (meta?.takeProfitPendingAttempts || 0),
    };
  });
}
