// lib/db.ts
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

const globalForPrisma = global as unknown as { prisma: PrismaClient };
const connectionString = process.env.DATABASE_URL;
const isNeonConnection = typeof connectionString === 'string' && connectionString.includes('neon.tech');

if (isNeonConnection) {
  neonConfig.webSocketConstructor = ws;
}

const pool = isNeonConnection && connectionString ? new Pool({ connectionString }) : null;

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter: pool ? new PrismaNeon(pool) : null,
    log: ['query'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
