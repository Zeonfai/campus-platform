import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  const identity = await db.serviceMetadata.upsert({
    where: { key: 'service-name' },
    create: { key: 'service-name', value: 'workflow' },
    update: {},
  });
  if (identity.value !== 'workflow')
    throw new Error('Existing service identity does not match this service');
  await db.m2Policy.upsert({
    where: { id_revision: { id: 'default', revision: 1 } },
    create: {
      id: 'default',
      revision: 1,
      name: '院系与教室两级审批',
      timeoutMinutes: 2880,
      createdBy: 'system-bootstrap',
      steps: [
        { roleId: 'demo-role-department', scope: 'DEPARTMENT' },
        { roleId: 'demo-role-managed', scope: 'MANAGED_ROOMS' },
      ],
    },
    update: {},
  });
  await db.m3Policy.upsert({
    where: { id_revision: { id: 'default', revision: 1 } },
    create: {
      id: 'default',
      revision: 1,
      name: '默认维修 SLA',
      responseMinutes: 1440,
      repairMinutes: 2880,
      acceptanceMinutes: 1440,
      createdBy: 'system-bootstrap',
    },
    update: {},
  });
  console.log(
    'Infrastructure and create-only default M2/M3 policy seeds applied; existing policy versions are preserved.',
  );
} finally {
  await db.$disconnect();
}
