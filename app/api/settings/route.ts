// app/api/settings/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { ok } from '@/lib/apiResponse';
import { requireAuth, requireRole } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const botEnabled = await prisma.setting.findUnique({ where: { key: 'bot_enabled' } });
  const customAmount = await prisma.setting.findUnique({ where: { key: 'custom_amount' } });
  const lastEntryError = await prisma.setting.findUnique({ where: { key: 'last_entry_error' } });
  const tradingMode = await prisma.setting.findUnique({ where: { key: 'trading_mode' } });
  const leverageEnabled = await prisma.setting.findUnique({ where: { key: 'leverage_enabled' } });
  const leverageValue = await prisma.setting.findUnique({ where: { key: 'leverage_value' } });
  const profitSoundEnabled = await prisma.setting.findUnique({ where: { key: 'profit_sound_enabled' } });
  const profitSoundFile = await prisma.setting.findUnique({ where: { key: 'profit_sound_file' } });
  const apiStopMode = await prisma.setting.findUnique({ where: { key: 'api_stop_mode' } });
  
  return NextResponse.json({ 
    bot_enabled: botEnabled?.value || '1',
    custom_amount: customAmount?.value || '',
    last_entry_error: lastEntryError?.value || '',
    trading_mode: tradingMode?.value || 'demo',
    leverage_enabled: leverageEnabled?.value || '0',
    leverage_value: leverageValue?.value || '1',
    profit_sound_enabled: profitSoundEnabled?.value || '0',
    profit_sound_file: profitSoundFile?.value || '',
    api_stop_mode: apiStopMode?.value || 'signal'
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await req.json();

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
    { key: 'api_stop_mode', value: body.api_stop_mode }
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
