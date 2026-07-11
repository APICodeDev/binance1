// app/api/settings/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { ok } from '@/lib/apiResponse';
import { requireAuth, requireRole } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';
import {
  buildProtectionThresholdSettingsSnapshot,
  normalizeProtectionSettingValue,
  normalizePercentString,
  parseBooleanSetting,
  PROTECTION_SETTING_DEFINITIONS,
  resolveProtectionThresholdSettingsFromMap,
} from '@/lib/protectionSettings';

const DEFAULT_API_LEGACY_STOP_PERCENT = '1.2';

function resolveStoredLegacyStopPercent(rawValue?: string | null) {
  const parsed = Number.parseFloat(normalizePercentString(rawValue));
  return Number.isFinite(parsed) && parsed > 0
    ? parsed.toString()
    : DEFAULT_API_LEGACY_STOP_PERCENT;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const botEnabled = await prisma.setting.findUnique({ where: { key: 'bot_enabled' } });
  const customAmount = await prisma.setting.findUnique({ where: { key: 'custom_amount' } });
  const lastEntryError = await prisma.setting.findUnique({ where: { key: 'last_entry_error' } });
  const lastWebhookStatus = await prisma.setting.findUnique({ where: { key: 'last_webhook_status' } });
  const tradingMode = await prisma.setting.findUnique({ where: { key: 'trading_mode' } });
  const leverageEnabled = await prisma.setting.findUnique({ where: { key: 'leverage_enabled' } });
  const leverageValue = await prisma.setting.findUnique({ where: { key: 'leverage_value' } });
  const profitSoundEnabled = await prisma.setting.findUnique({ where: { key: 'profit_sound_enabled' } });
  const profitSoundFile = await prisma.setting.findUnique({ where: { key: 'profit_sound_file' } });
  const apiStopMode = await prisma.setting.findUnique({ where: { key: 'api_stop_mode' } });
  const apiLegacyStopPercent = await prisma.setting.findUnique({ where: { key: 'api_legacy_stop_percent' } });
  const exhaustionGuardEnabled = await prisma.setting.findUnique({ where: { key: 'exhaustion_guard_enabled' } });
  const takeProfitAutoCloseEnabled = await prisma.setting.findUnique({ where: { key: 'take_profit_auto_close_enabled' } });
  const reverseOnOppositeSignalEnabled = await prisma.setting.findUnique({ where: { key: 'reverse_on_opposite_signal_enabled' } });
  const protectionSettingsRows = await prisma.setting.findMany({
    where: {
      key: {
        in: PROTECTION_SETTING_DEFINITIONS.map((definition) => definition.key),
      },
    },
  });
  const protectionSettings = resolveProtectionThresholdSettingsFromMap(
    protectionSettingsRows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {})
  );
  
  return NextResponse.json({ 
    bot_enabled: botEnabled?.value || '1',
    custom_amount: customAmount?.value || '',
    last_entry_error: lastEntryError?.value || '',
    last_webhook_status: lastWebhookStatus?.value || '',
    trading_mode: tradingMode?.value || 'demo',
    leverage_enabled: leverageEnabled?.value || '0',
    leverage_value: leverageValue?.value || '1',
    profit_sound_enabled: profitSoundEnabled?.value || '0',
    profit_sound_file: profitSoundFile?.value || '',
    api_stop_mode: apiStopMode?.value || 'signal',
    api_legacy_stop_percent: resolveStoredLegacyStopPercent(apiLegacyStopPercent?.value),
    exhaustion_guard_enabled: exhaustionGuardEnabled?.value || '1',
    take_profit_auto_close_enabled: takeProfitAutoCloseEnabled?.value || '0',
    reverse_on_opposite_signal_enabled: reverseOnOppositeSignalEnabled?.value || '1',
    ...buildProtectionThresholdSettingsSnapshot(protectionSettings),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await req.json();
  if (body.api_legacy_stop_percent !== undefined) {
    const parsed = Number.parseFloat(normalizePercentString(body.api_legacy_stop_percent));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: true, message: 'api_legacy_stop_percent must be a positive number.' },
        { status: 400 }
      );
    }
    body.api_legacy_stop_percent = parsed.toString();
  }

  if (body.trend_break_even_enabled !== undefined) {
    body.trend_break_even_enabled = parseBooleanSetting(body.trend_break_even_enabled) ? '1' : '0';
  }

  for (const definition of PROTECTION_SETTING_DEFINITIONS) {
    if (body[definition.key] === undefined) {
      continue;
    }

    const normalized = normalizeProtectionSettingValue(definition, body[definition.key]);
    if (normalized === null) {
      return NextResponse.json(
        {
          error: true,
          message: definition.kind === 'percent'
            ? `${definition.key} must be a positive number.`
            : `${definition.key} has an invalid value.`,
        },
        { status: 400 }
      );
    }

    body[definition.key] = normalized;
  }

  if (body.trading_mode === 'live') {
    const roleCheck = await requireRole(req, ['admin']);
    if (!roleCheck.ok) {
      return roleCheck.response;
    }
  }
  
  const settingsToUpdate = [
    { key: 'bot_enabled', value: body.bot_enabled },
    { key: 'custom_amount', value: body.custom_amount },
    { key: 'trading_mode', value: body.trading_mode },
    { key: 'leverage_enabled', value: body.leverage_enabled },
    { key: 'leverage_value', value: body.leverage_value },
    { key: 'profit_sound_enabled', value: body.profit_sound_enabled },
    { key: 'profit_sound_file', value: body.profit_sound_file },
    { key: 'api_stop_mode', value: body.api_stop_mode },
    { key: 'api_legacy_stop_percent', value: body.api_legacy_stop_percent },
    { key: 'exhaustion_guard_enabled', value: body.exhaustion_guard_enabled },
    { key: 'take_profit_auto_close_enabled', value: body.take_profit_auto_close_enabled },
    { key: 'reverse_on_opposite_signal_enabled', value: body.reverse_on_opposite_signal_enabled },
    ...PROTECTION_SETTING_DEFINITIONS.map((definition) => ({
      key: definition.key,
      value: body[definition.key],
    })),
  ];

  for (const setting of settingsToUpdate) {
    if (setting.value !== undefined) {
      await prisma.setting.upsert({
        where: { key: setting.key },
        update: { value: setting.value.toString() },
        create: { key: setting.key, value: setting.value.toString() },
      });
    }
  }

  await writeAuditLog({
    action: 'settings.update',
    userId: auth.auth.user.id,
    targetType: 'setting',
    metadata: body,
    req,
  });

  return ok(undefined, 'Settings updated');
}
