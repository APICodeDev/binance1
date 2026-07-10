export const PROTECTION_SETTING_DEFINITIONS = [
  { key: 'trend_break_even_enabled', defaultValue: '1' },
  { key: 'auto_break_even_activation_percent', defaultValue: '0.5' },
  { key: 'auto_trailing_activation_percent', defaultValue: '1' },
  { key: 'auto_trailing_step_percent', defaultValue: '0.5' },
  { key: 'self_break_even_activation_percent', defaultValue: '0.5' },
  { key: 'self_trailing_activation_percent', defaultValue: '1.25' },
  { key: 'self_trailing_step_percent', defaultValue: '1' },
  { key: 'trend_break_even_activation_percent', defaultValue: '1' },
] as const;

export type ProtectionSettingKey = typeof PROTECTION_SETTING_DEFINITIONS[number]['key'];

export type ProtectionThresholdSettings = {
  trendBreakEvenEnabled: boolean;
  autoBreakEvenActivationPercent: number;
  autoTrailingActivationPercent: number;
  autoTrailingStepPercent: number;
  selfBreakEvenActivationPercent: number;
  selfTrailingActivationPercent: number;
  selfTrailingStepPercent: number;
  trendBreakEvenActivationPercent: number;
};

const PROTECTION_SETTING_KEY_MAP: Record<ProtectionSettingKey, keyof ProtectionThresholdSettings> = {
  trend_break_even_enabled: 'trendBreakEvenEnabled',
  auto_break_even_activation_percent: 'autoBreakEvenActivationPercent',
  auto_trailing_activation_percent: 'autoTrailingActivationPercent',
  auto_trailing_step_percent: 'autoTrailingStepPercent',
  self_break_even_activation_percent: 'selfBreakEvenActivationPercent',
  self_trailing_activation_percent: 'selfTrailingActivationPercent',
  self_trailing_step_percent: 'selfTrailingStepPercent',
  trend_break_even_activation_percent: 'trendBreakEvenActivationPercent',
};

export const DEFAULT_PROTECTION_THRESHOLD_SETTINGS: ProtectionThresholdSettings = {
  trendBreakEvenEnabled: true,
  autoBreakEvenActivationPercent: 0.5,
  autoTrailingActivationPercent: 1,
  autoTrailingStepPercent: 0.5,
  selfBreakEvenActivationPercent: 0.5,
  selfTrailingActivationPercent: 1.25,
  selfTrailingStepPercent: 1,
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
  return String(value ?? '').trim() === '1';
}

export function resolveProtectionThresholdSettingsFromMap(
  settingsMap: Partial<Record<string, string | null | undefined>>
) {
  const resolved: ProtectionThresholdSettings = {
    ...DEFAULT_PROTECTION_THRESHOLD_SETTINGS,
  };

  for (const definition of PROTECTION_SETTING_DEFINITIONS) {
    if (definition.key === 'trend_break_even_enabled') {
      const rawValue = settingsMap[definition.key];
      (resolved as any)[PROTECTION_SETTING_KEY_MAP[definition.key]] = (
        rawValue === undefined || rawValue === null || rawValue === ''
          ? DEFAULT_PROTECTION_THRESHOLD_SETTINGS[PROTECTION_SETTING_KEY_MAP[definition.key]]
          : parseBooleanSetting(rawValue)
      );
      continue;
    }

    const parsed = parsePositivePercentSetting(settingsMap[definition.key]);
    (resolved as any)[PROTECTION_SETTING_KEY_MAP[definition.key]] =
      parsed ?? DEFAULT_PROTECTION_THRESHOLD_SETTINGS[PROTECTION_SETTING_KEY_MAP[definition.key]];
  }

  return resolved;
}

export function buildProtectionThresholdSettingsSnapshot(settings: ProtectionThresholdSettings) {
  return {
    trend_break_even_enabled: settings.trendBreakEvenEnabled ? '1' : '0',
    auto_break_even_activation_percent: settings.autoBreakEvenActivationPercent.toString(),
    auto_trailing_activation_percent: settings.autoTrailingActivationPercent.toString(),
    auto_trailing_step_percent: settings.autoTrailingStepPercent.toString(),
    self_break_even_activation_percent: settings.selfBreakEvenActivationPercent.toString(),
    self_trailing_activation_percent: settings.selfTrailingActivationPercent.toString(),
    self_trailing_step_percent: settings.selfTrailingStepPercent.toString(),
    trend_break_even_activation_percent: settings.trendBreakEvenActivationPercent.toString(),
  };
}
