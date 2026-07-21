export const BLOCKED_ENTRY_SYMBOLS_SETTING_KEY = 'blocked_entry_symbols';
export const DEFAULT_BLOCKED_ENTRY_SYMBOLS = ['AVAXUSDT', 'LTCUSDT'] as const;

export function normalizeBlockedEntrySymbols(value: unknown) {
  const parsed = String(value ?? '')
    .split(/[\s,;]+/)
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);

  return Array.from(new Set(parsed));
}

export function resolveBlockedEntrySymbols(value: unknown) {
  const parsed = normalizeBlockedEntrySymbols(value);
  return parsed.length > 0 ? parsed : [...DEFAULT_BLOCKED_ENTRY_SYMBOLS];
}

export function isEntrySymbolBlocked(symbol: string, blockedSymbols: string[]) {
  return blockedSymbols.includes(String(symbol || '').trim().toUpperCase());
}
