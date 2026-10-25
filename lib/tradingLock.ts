import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';

// Database CAS, shared across Vercel instances. A crashed special order also
// leaves a separate durable intent, so lease expiry never resubmits that order.
export async function withTradingLock<T>(run: () => Promise<T>): Promise<T> {
  const key = 'entry_execution_lock';
  const value = JSON.stringify({ owner: randomUUID(), expires: Date.now() + 300_000 });
  const deadline = Date.now() + 60_000;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    const current = await prisma.setting.findUnique({ where: { key } });
    if (!current) {
      try {
        await prisma.setting.create({ data: { key, value } });
        acquired = true;
      } catch (error: any) {
        if (error?.code !== 'P2002') throw error;
      }
    } else {
      let expires = Infinity;
      try { expires = JSON.parse(current.value).expires; } catch {}
      if (expires < Date.now()) {
        const result = await prisma.setting.updateMany({ where: { key, value: current.value }, data: { value } });
        acquired = result.count === 1;
      }
    }
    if (!acquired) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!acquired) throw new Error('Trading ocupado: no se ha enviado ninguna orden. Reintentar la senal.');
  try { return await run(); }
  finally { await prisma.setting.deleteMany({ where: { key, value } }); }
}
