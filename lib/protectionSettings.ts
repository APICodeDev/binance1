type ProtectionSettingDefinition =
  | { key: string; defaultValue: string; kind: 'boolean' }
  | { key: string; defaultValue: string; kind: 'percent' }
  | { key: string; defaultValue: string; kind: 'enum'; allowedValues: readonly string[] };

export const PROTECTION_SETTING_DEFINITIONS = [
  { key: 'trend_break_even_enabled', defaultValue: '1', kind: 'boolean' },
  { key: 'trend_trailing_percent', defaultValue: '0.5', kind: 'percent' },
  { key: 'auto_break_even_activation_percent', defaultValue: '0.5', kind: 'percent' },
  { key: 'auto_trailing_activation_percent', defaultValue: '1', kind: 'percent' },
  { key: 'auto_trailing_step_percent', defaultValue: '0.5', kind: 'percent' },
  { key: 'self_break_even_activation_percent', defaultValue: '0.5', kind: 'percent' },
  { key: 'self_trailing_activation_percent', defaultValue: '1.25', kind: 'percent' },
  { key: 'self_trailing_step_percent', defaultValue: '1', kind: 'percent' },
  { key: 'self_native_trailing_enabled', defaultValue: '0', kind: 'boolean' },
  { key: 'self_native_trailing_callback_percent', defaultValue: '0.5', kind: 'percent' },
  { key: 'self_native_trailing_activation_percent', defaultValue: '1.25', kind: 'percent' },
  {
    key: 'self_native_trailing_trigger_type',
    defaultValue: 'fill_price',
    kind: 'enum',
    allowedValues: ['fill_price', 'mark_price'] as const,
  },
  {
    key: 'self_native_trailing_fallback_mode',
    defaultValue: 'abort',
    kind: 'enum',
    allowedValues: ['abort', 'fallback_to_app'] as const,
  },
  { key: 'trend_break_even_activation_percent', defaultValue: '1', kind: 'percent' },
] as const satisfies readonly ProtectionSettingDefinition[];

export type ProtectionSettingKey = typeof PROTECTION_SETTING_DEFINITIONS[number]['key'];

export type ProtectionThresholdSettings = {
  trendBreakEvenEnabled: boolean;
  trendTrailingPercent: number;
  autoBreakEvenActivationPercent: number;
  autoTrailingActivationPercent: number;
  autoTrailingStepPercent: number;
  selfBreakEvenActivationPercent: number;
  selfTrailingActivationPercent: number;
  selfTrailingStepPercent: number;
  selfNativeTrailingEnabled: boolean;
  selfNativeTrailingCallbackPercent: number;
  selfNativeTrailingActivationPercent: number;
  selfNativeTrailingTriggerType: 'fill_price' | 'mark_price';
  selfNativeTrailingFallbackMode: 'abort' | 'fallback_to_app';
  trendBreakEvenActivationPercent: number;
};

const PROTECTION_SETTING_KEY_MAP: Record<ProtectionSettingKey, keyof ProtectionThresholdSettings> = {
  trend_break_even_enabled: 'trendBreakEvenEnabled',
  trend_trailing_percent: 'trendTrailingPercent',
  auto_break_even_activation_percent: 'autoBreakEvenActivationPercent',
  auto_trailing_activation_percent: 'autoTrailingActivationPercent',
  auto_trailing_step_percent: 'autoTrailingStepPercent',
  self_break_even_activation_percent: 'selfBreakEvenActivationPercent',
  self_trailing_activation_percent: 'selfTrailingActivationPercent',
  self_trailing_step_percent: 'selfTrailingStepPercent',
  self_native_trailing_enabled: 'selfNativeTrailingEnabled',
  self_native_trailing_callback_percent: 'selfNativeTrailingCallbackPercent',
  self_native_trailing_activation_percent: 'selfNativeTrailingActivationPercent',
  self_native_trailing_trigger_type: 'selfNativeTrailingTriggerType',
  self_native_trailing_fallback_mode: 'selfNativeTrailingFallbackMode',
  trend_break_even_activation_percent: 'trendBreakEvenActivationPercent',
};

export const DEFAULT_PROTECTION_THRESHOLD_SETTINGS: ProtectionThresholdSettings = {
  trendBreakEvenEnabled: true,
  trendTrailingPercent: 0.5,
  autoBreakEvenActivationPercent: 0.5,
  autoTrailingActivationPercent: 1,
  autoTrailingStepPercent: 0.5,
  selfBreakEvenActivationPercent: 0.5,
  selfTrailingActivationPercent: 1.25,
  selfTrailingStepPercent: 1,
  selfNativeTrailingEnabled: false,
  selfNativeTrailingCallbackPercent: 0.5,
  selfNativeTrailingActivationPercent: 1.25,
  selfNativeTrailingTriggerType: 'fill_price',
  selfNativeTrailingFallbackMode: 'abort',
  trendBreakEvenActivationPercent: 1,
};

export function normalizePercentString(value: unknown) {
  return String(value ?? '').trim().replace(',', '.');
}

export function parsePositivePercentSetting(value: unknown) {
  const parsed = Number.parseFloat(normalizePercentString(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseBooleanSetting(value: unknown) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function parseEnumSetting<T extends readonly string[]>(value: unknown, allowedValues: T): T[number] | null {
  const raw = String(value ?? '').trim().toLowerCase();
  return allowedValues.includes(raw) ? raw as T[number] : null;
}

export function normalizeProtectionSettingValue(
  definition: typeof PROTECTION_SETTING_DEFINITIONS[number],
  value: unknown
) {
  if (definition.kind === 'boolean') {
    return parseBooleanSetting(value) ? '1' : '0';
  }

  if (definition.kind === 'percent') {
    const parsed = parsePositivePercentSetting(value);
    return parsed === null ? null : parsed.toString();
  }

  return parseEnumSetting(value, definition.allowedValues);
}

export function resolveProtectionThresholdSettingsFromMap(
  settingsMap: Partial<Record<string, string | null | undefined>>
) {
  const resolved: ProtectionThresholdSettings = {
    ...DEFAULT_PROTECTION_THRESHOLD_SETTINGS,
  };

  for (const definition of PROTECTION_SETTING_DEFINITIONS) {
    const mappedKey = PROTECTION_SETTING_KEY_MAP[definition.key];
    const rawValue = settingsMap[definition.key];

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      (resolved as any)[mappedKey] = DEFAULT_PROTECTION_THRESHOLD_SETTINGS[mappedKey];
      continue;
    }

    if (definition.kind === 'boolean') {
      (resolved as any)[mappedKey] = parseBooleanSetting(rawValue);
      continue;
    }

    if (definition.kind === 'percent') {
      const parsed = parsePositivePercentSetting(rawValue);
      (resolved as any)[mappedKey] = parsed ?? DEFAULT_PROTECTION_THRESHOLD_SETTINGS[mappedKey];
      continue;
    }

    const parsed = parseEnumSetting(rawValue, definition.allowedValues);
    (resolved as any)[mappedKey] = parsed ?? DEFAULT_PROTECTION_THRESHOLD_SETTINGS[mappedKey];
  }

  return resolved;
}

export function buildProtectionThresholdSettingsSnapshot(settings: ProtectionThresholdSettings) {
  return {
    trend_break_even_enabled: settings.trendBreakEvenEnabled ? '1' : '0',
    trend_trailing_percent: settings.trendTrailingPercent.toString(),
    auto_break_even_activation_percent: settings.autoBreakEvenActivationPercent.toString(),
    auto_trailing_activation_percent: settings.autoTrailingActivationPercent.toString(),
    auto_trailing_step_percent: settings.autoTrailingStepPercent.toString(),
    self_break_even_activation_percent: settings.selfBreakEvenActivationPercent.toString(),
    self_trailing_activation_percent: settings.selfTrailingActivationPercent.toString(),
    self_trailing_step_percent: settings.selfTrailingStepPercent.toString(),
    self_native_trailing_enabled: settings.selfNativeTrailingEnabled ? '1' : '0',
    self_native_trailing_callback_percent: settings.selfNativeTrailingCallbackPercent.toString(),
    self_native_trailing_activation_percent: settings.selfNativeTrailingActivationPercent.toString(),
    self_native_trailing_trigger_type: settings.selfNativeTrailingTriggerType,
    self_native_trailing_fallback_mode: settings.selfNativeTrailingFallbackMode,
    trend_break_even_activation_percent: settings.trendBreakEvenActivationPercent.toString(),
  };
}
