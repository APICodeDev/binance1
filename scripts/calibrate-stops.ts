import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const MIN_CLEAN_TRADES = 30;
const MAX_CLEAN_TRADES = 50;

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function round(value: number | null, decimals = 3) {
  return value === null ? null : Number(value.toFixed(decimals));
}

async function main() {
  const rows = await prisma.position.findMany({
    where: {
      status: 'closed',
      closedAt: { not: null },
      // Manual/reconciled exits are not suitable for calibrating protective stops.
      closeOrigin: 'app_rules',
      maxAdverseAt: { not: null },
    } as any,
    select: {
      symbol: true,
      maxAdversePercent: true,
      createdAt: true,
      closedAt: true,
    } as any,
  });

  const bySymbol = new Map<string, number[]>();
  for (const row of rows as any[]) {
    const mae = Number(row.maxAdversePercent || 0);
    if (!(mae >= 0)) continue;
    const values = bySymbol.get(row.symbol) || [];
    values.push(mae);
    bySymbol.set(row.symbol, values);
  }

  const result = Array.from(bySymbol.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([symbol, maeValues]) => {
      const p85 = percentile(maeValues, 0.85);
      const eligible = maeValues.length >= MIN_CLEAN_TRADES;
      const recommendedStopPercent = eligible && p85 !== null
        ? Math.min(2.5, Math.max(0.35, p85 * 1.10))
        : null;

      return {
        symbol,
        cleanTrades: maeValues.length,
        minimumRequired: MIN_CLEAN_TRADES,
        targetSampleRange: `${MIN_CLEAN_TRADES}-${MAX_CLEAN_TRADES}`,
        status: eligible ? 'eligible_for_review' : 'collect_more_data',
        maeP50: round(percentile(maeValues, 0.50)),
        maeP85: round(p85),
        recommendedStopPercent: round(recommendedStopPercent),
      };
    });

  console.log(JSON.stringify({
    cleanDefinition: 'closed + closeOrigin=app_rules + maxAdverseAt recorded',
    minimumCleanTrades: MIN_CLEAN_TRADES,
    rows: result,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
