import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  const identity = await db.serviceMetadata.upsert({
    where: { key: 'service-name' },
    create: { key: 'service-name', value: 'resource-core' },
    update: {},
  });
  if (identity.value !== 'resource-core')
    throw new Error('Existing service identity does not match this service');
  await db.dBookingPolicy.upsert({
    where: { id: 'default' },
    create: { id: 'default', maxHours: 4 },
    update: {},
  });
  console.log('Infrastructure and default booking policy seed applied; no demo accounts created.');
} finally {
  await db.$disconnect();
}
