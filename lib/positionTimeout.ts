export const POSITION_TIMEOUT_OPTIONS = [3, 6, 12, 24] as const;

export type PositionTimeoutHours = typeof POSITION_TIMEOUT_OPTIONS[number];

export function parsePositionTimeoutHours(value: unknown): PositionTimeoutHours | null | undefined {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return POSITION_TIMEOUT_OPTIONS.includes(parsed as PositionTimeoutHours)
    ? parsed as PositionTimeoutHours
    : undefined;
}

export function isPositionTimeoutExpired(
  position: { createdAt: Date | string; timeoutHours?: number | null },
  now = Date.now()
) {
  const timeoutHours = parsePositionTimeoutHours(position.timeoutHours);
  if (timeoutHours == null) return false;
  const createdAt = new Date(position.createdAt).getTime();
  return Number.isFinite(createdAt) && now >= createdAt + timeoutHours * 60 * 60 * 1000;
}

// The timeout arms at the selected age. A winning position remains open while
// its net PnL is positive and is closed as soon as it is no longer profitable.
export function shouldClosePositionForTimeout(
  position: { createdAt: Date | string; timeoutHours?: number | null },
  netProfitFiat: number,
  now = Date.now()
) {
  return isPositionTimeoutExpired(position, now) && Number.isFinite(netProfitFiat) && netProfitFiat <= 0;
}
