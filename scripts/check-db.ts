import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const settings = await prisma.setting.findMany();
  console.log('Current Settings:', JSON.stringify(settings, null, 2));
  const positions = await prisma.position.findMany({ where: { status: 'open' } });
  console.log('Open Positions:', JSON.stringify(positions, null, 2));
}
main().catch(console.error);
