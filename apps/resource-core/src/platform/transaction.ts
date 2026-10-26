import type { Prisma } from '../generated/prisma/client.js';
export async function transactionLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$queryRawUnsafe(
    'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))',
    key,
  );
}
export async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<{ now: Date }[]>('SELECT clock_timestamp() AS now');
  if (!rows[0]) throw new Error('Database clock unavailable');
  return rows[0].now;
}
