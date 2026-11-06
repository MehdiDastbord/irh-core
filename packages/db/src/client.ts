/** Prisma client singleton. Kept separate to avoid circular imports. */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __irhPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__irhPrisma ??
  new PrismaClient({ log: process.env.PRISMA_LOG === 'true' ? ['warn', 'error'] : ['error'] });

if (process.env.NODE_ENV !== 'production') globalForPrisma.__irhPrisma = prisma;

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    /* already disconnected */
  }
}
