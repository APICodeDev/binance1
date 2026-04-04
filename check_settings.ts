import { prisma } from './lib/db';

async function main() {
  const mode = await prisma.setting.findUnique({ where: { key: 'trading_mode' } });
  const botEnabled = await prisma.setting.findUnique({ where: { key: 'bot_enabled' } });
  const lastError = await prisma.setting.findUnique({ where: { key: 'last_entry_error' } });
  console.log('Trading Mode:', mode?.value);
  console.log('Bot Enabled:', botEnabled?.value);
  console.log('Last Error:', lastError?.value);
}

main().catch(console.error).finally(() => process.exit());
