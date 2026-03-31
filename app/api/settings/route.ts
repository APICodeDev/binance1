// app/api/settings/route.ts
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
  const botEnabled = await prisma.setting.findUnique({ where: { key: 'bot_enabled' } });
  const customAmount = await prisma.setting.findUnique({ where: { key: 'custom_amount' } });
  const lastEntryError = await prisma.setting.findUnique({ where: { key: 'last_entry_error' } });
  return NextResponse.json({ 
    bot_enabled: botEnabled?.value || '1',
    custom_amount: customAmount?.value || '',
    last_entry_error: lastEntryError?.value || ''
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (body.bot_enabled !== undefined) {
    await prisma.setting.upsert({
      where: { key: 'bot_enabled' },
      update: { value: body.bot_enabled.toString() },
      create: { key: 'bot_enabled', value: body.bot_enabled.toString() },
    });
  }
  if (body.custom_amount !== undefined) {
    await prisma.setting.upsert({
      where: { key: 'custom_amount' },
      update: { value: body.custom_amount.toString() },
      create: { key: 'custom_amount', value: body.custom_amount.toString() },
    });
  }
  return NextResponse.json({ success: true });
}
