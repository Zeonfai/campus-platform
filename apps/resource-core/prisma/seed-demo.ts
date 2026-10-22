import 'dotenv/config';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type DScope } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/modules/d/password.js';

const connectionString = process.env.DATABASE_URL;
if (
  !connectionString ||
  !['development', 'test'].includes(process.env.NODE_ENV ?? 'development') ||
  new URL(connectionString).hostname !== '127.0.0.1'
)
  throw new Error('Demo seed only supports development/test on the local database');
const root = new URL('../../../', import.meta.url);
const local = new URL('.local/', root);
const credentialFile = new URL('demo-accounts.json', local);
interface DemoAccount {
  id: string;
  username: string;
  displayName: string;
  departmentId: string;
  roleId: string;
  password: string;
}
const definitions = [
  ['student-a', '演示学生甲', 'demo-department-a', 'demo-role-reader'],
  ['student-b', '演示学生乙', 'demo-department-b', 'demo-role-reader'],
  ['manager-a', '演示教室管理员', 'demo-department-a', 'demo-role-managed'],
  ['department-a', '演示院系管理员', 'demo-department-a', 'demo-role-department'],
  ['admin', '演示全域管理员', 'demo-department-a', 'demo-role-all'],
] as const;
let accounts: DemoAccount[];
await mkdir(local, { recursive: true, mode: 0o700 });
try {
  const existing = JSON.parse(await readFile(credentialFile, 'utf8')) as {
    accounts?: DemoAccount[];
  };
  if (
    !Array.isArray(existing.accounts) ||
    existing.accounts.length !== definitions.length ||
    existing.accounts.some(
      (a, i) =>
        a.id !== `demo-user-${definitions[i]?.[0]}` ||
        typeof a.password !== 'string' ||
        a.password.length < 20,
    )
  )
    throw new Error('Existing demo credential file is invalid; do not overwrite it automatically');
  accounts = existing.accounts;
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  const probe = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const existingUsers = await probe.dUser.count({
      where: { id: { in: definitions.map(([username]) => `demo-user-${username}`) } },
    });
    if (existingUsers)
      throw new Error(
        'Demo accounts already exist but the local credential file is missing. Recover it or request an explicit password reset; seed does not reset passwords.',
        { cause: error },
      );
  } finally {
    await probe.$disconnect();
  }
  accounts = definitions.map(([username, displayName, departmentId, roleId]) => ({
    id: `demo-user-${username}`,
    username: `demo-${username}`,
    displayName,
    departmentId,
    roleId,
    password: randomBytes(24).toString('base64url'),
  }));
  await writeFile(
    credentialFile,
    JSON.stringify(
      { warning: 'LOCAL SYNTHETIC DEMO ONLY. DO NOT COMMIT OR DEPLOY.', accounts },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
}
await chmod(credentialFile, 0o600);
const specification = JSON.parse(
  await readFile(new URL('packages/contracts/openapi.json', root), 'utf8'),
) as { paths: Record<string, Record<string, { 'x-permission': string; summary: string }>> };
const catalog = new Map<string, string>();
for (const methods of Object.values(specification.paths))
  for (const operation of Object.values(methods)) {
    const permission = operation['x-permission'];
    if (/^(d|m1|m2|m3)\./.test(permission)) catalog.set(permission, operation.summary);
  }
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  // Expensive password derivation stays outside the database transaction.
  const passwords = new Map<string, string>();
  for (const account of accounts) {
    if (!(await db.dUser.findUnique({ where: { id: account.id }, select: { id: true } })))
      passwords.set(account.id, await hashPassword(account.password));
  }
  await db.$transaction(async (tx) => {
    for (const [id, description] of catalog)
      await tx.dPermission.upsert({ where: { id }, create: { id, description }, update: {} });
    for (const [id, name] of [
      ['demo-department-a', '演示计算机学院'],
      ['demo-department-b', '演示文学院'],
    ]) {
      if (id && name)
        await tx.dDepartment.upsert({ where: { id }, create: { id, name }, update: {} });
    }
    const roles: [string, string, DScope, string[]][] = [
      ['demo-role-reader', '演示目录读者', 'DEPARTMENT', ['d.rooms.read', 'd.departments.read']],
      [
        'demo-role-managed',
        '演示指定教室管理员',
        'MANAGED_ROOMS',
        ['d.rooms.read', 'd.departments.read'],
      ],
      [
        'demo-role-department',
        '演示院系管理员',
        'DEPARTMENT',
        ['d.rooms.read', 'd.departments.read'],
      ],
      ['demo-role-all', '演示全域管理员', 'ALL', [...catalog.keys()]],
    ];
    for (const [id, name, scope, permissions] of roles) {
      // Nested creates only run when absent: replay never restores a removed grant.
      await tx.dRole.upsert({
        where: { id },
        create: {
          id,
          name,
          scope,
          permissions: { create: permissions.map((permissionId) => ({ permissionId })) },
        },
        update: {},
      });
    }
    for (const [id, code, name, departmentId, restrictedToDepartment] of [
      ['demo-room-a', 'DEMO-A101', '演示教室 A101', 'demo-department-a', true],
      ['demo-room-b', 'DEMO-B201', '演示教室 B201', 'demo-department-b', true],
      ['demo-room-public', 'DEMO-P001', '演示公共自习室', 'demo-department-b', false],
    ] as const) {
      await tx.dRoom.upsert({
        where: { id },
        create: { id, code, name, departmentId, restrictedToDepartment },
        update: {},
      });
      for (const [index, powerType] of ['NONE', 'FIXED', 'RAIL'].entries()) {
        const seatId = `${id}-seat-${index + 1}`;
        if (powerType !== 'NONE' && powerType !== 'FIXED' && powerType !== 'RAIL')
          throw new Error('Invalid demo power type');
        await tx.dSeat.upsert({
          where: { id: seatId },
          create: { id: seatId, roomId: id, code: `S0${index + 1}`, enabled: true, powerType },
          update: {},
        });
      }
    }
    for (const roomId of ['demo-room-a', 'demo-room-b', 'demo-room-public']) {
      for (let weekday = 0; weekday < 7; weekday++)
        await tx.dOpeningRule.upsert({
          where: { roomId_weekday_opensHour: { roomId, weekday, opensHour: 8 } },
          create: { roomId, weekday, opensHour: 8, closesHour: 22 },
          update: {},
        });
    }
    for (const account of accounts) {
      const passwordHash = passwords.get(account.id);
      if (passwordHash)
        await tx.dUser.upsert({
          where: { id: account.id },
          create: {
            id: account.id,
            username: account.username,
            displayName: account.displayName,
            departmentId: account.departmentId,
            passwordHash,
            roles: { create: { roleId: account.roleId } },
            ...(account.username === 'demo-manager-a'
              ? { managedRooms: { create: { roomId: 'demo-room-a' } } }
              : {}),
          },
          update: {},
        });
    }
    // Versioned create-only demo additions do not restore revoked grants on replay.
    for (const [id, name, scope, permissions, users] of [
      [
        'demo-role-m3-reporter-v1',
        '演示报修人',
        'SELF',
        ['m3.work-orders.create', 'm3.cancel', 'm3.rate', 'm3.policies.read'],
        ['demo-user-student-a', 'demo-user-student-b'],
      ],
      [
        'demo-role-m3-repairer-v1',
        '演示维修人员',
        'DEPARTMENT',
        ['m3.repair', 'm3.policies.read'],
        ['demo-user-department-a'],
      ],
      [
        'demo-role-m3-manager-v1',
        '演示维修管理与独立验收',
        'MANAGED_ROOMS',
        ['m3.dispatch', 'm3.accept', 'm3.cancel', 'm3.policies.read'],
        ['demo-user-manager-a'],
      ],
      [
        'demo-role-m3-policy-admin-v1',
        '演示维修政策管理',
        'ALL',
        ['m3.policies.read', 'm3.policies.write'],
        ['demo-user-admin'],
      ],
      [
        'demo-role-m2-applicant-v1',
        '演示整室申请人',
        'SELF',
        ['m2.applications.create', 'm2.policies.read'],
        ['demo-user-student-a', 'demo-user-student-b'],
      ],
      [
        'demo-role-m2-department-v1',
        '演示院系审批权限',
        'DEPARTMENT',
        ['m2.approvals.decide', 'm2.policies.read'],
        ['demo-user-department-a'],
      ],
      [
        'demo-role-m2-manager-v1',
        '演示教室审批权限',
        'MANAGED_ROOMS',
        ['m2.approvals.decide', 'm2.policies.read'],
        ['demo-user-manager-a'],
      ],
    ] as [string, string, DScope, string[], string[]][]) {
      await tx.dRole.upsert({
        where: { id },
        create: {
          id,
          name,
          scope,
          permissions: { create: permissions.map((permissionId) => ({ permissionId })) },
          users: { create: users.map((userId) => ({ userId })) },
        },
        update: {},
      });
    }
    await tx.dRole.upsert({
      where: { id: 'demo-role-booker-v1' },
      create: {
        id: 'demo-role-booker-v1',
        name: '演示个人预约人',
        scope: 'SELF',
        permissions: { create: { permissionId: 'm1.bookings.create' } },
        users: {
          create: ['demo-user-student-a', 'demo-user-student-b'].map((userId) => ({ userId })),
        },
      },
      update: {},
    });
  });
  console.log(
    `Local synthetic demo seed applied. Credentials stay in ${fileURLToPath(credentialFile)} (0600, ignored by Git); values are not logged.`,
  );
} finally {
  await db.$disconnect();
}
