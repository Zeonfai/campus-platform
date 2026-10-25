import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { hashPassword } from '../apps/resource-core/dist/modules/d/password.js';

// Only this run's random database is written or removed. Shared policies,
// application databases, demo credentials and local configuration are preserved.
const root = fileURLToPath(new URL('../', import.meta.url));
const requireCore = createRequire(new URL('../apps/resource-core/package.json', import.meta.url));
const { Client } = requireCore('pg');
const { parse } = requireCore('dotenv');
const coreConfig = parse(readFileSync(resolve(root, 'apps/resource-core/.env'), 'utf8'));
const localConfig = parse(readFileSync(resolve(root, 'infra/local/.env'), 'utf8'));
assert.ok(
  coreConfig.DATABASE_URL && localConfig.POSTGRES_ADMIN_PASSWORD,
  'Local configuration required',
);
const sourceUrl = new URL(coreConfig.DATABASE_URL);
assert.equal(
  sourceUrl.hostname,
  '127.0.0.1',
  'This verification uses only the local PostgreSQL instance',
);
const applicationRole = decodeURIComponent(sourceUrl.username);
assert.match(applicationRole, /^[A-Za-z_][A-Za-z0-9_]*$/);
const databaseName = 'it_admin_' + randomBytes(8).toString('hex');
assert.match(databaseName, /^it_admin_[a-f0-9]{16}$/);
const testUrl = new URL(sourceUrl);
testUrl.pathname = '/' + databaseName;
const adminUrl = new URL(sourceUrl);
adminUrl.username = 'campus_local_admin';
adminUrl.password = localConfig.POSTGRES_ADMIN_PASSWORD;
adminUrl.pathname = '/postgres';
const adminDb = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 3000 });
const db = new Client({ connectionString: testUrl.href, connectionTimeoutMillis: 3000 });
const prefix = 'it-admin-' + randomBytes(6).toString('hex');
const userId = (kind) => prefix + '-' + kind;
const roleId = (kind) => prefix + '-role-' + kind;
const departmentId = (kind) => prefix + '-department-' + kind;
const roomId = (kind) => prefix + '-room-' + kind;
const password = randomBytes(24).toString('base64url');
const address = '127.81.' + randomBytes(1)[0] + '.1';
const specification = JSON.parse(
  readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'),
);
const permissionIds = [
  ...new Set(
    Object.values(specification.paths).flatMap((methods) =>
      Object.values(methods)
        .map((op) => op['x-permission'])
        .filter((permission) => /^(d|m1|m2|m3)\./.test(permission)),
    ),
  ),
];
const tokens = {};
let processHandle,
  port,
  createdDatabase = false,
  adminConnected = false,
  dbConnected = false,
  passed = 0;
const day = new Date(Date.now() + 2 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const at = (hour) => day + 'T' + String(hour).padStart(2, '0') + ':00:00+08:00';
const bookingInput = (seatId, start = 9, end = 10) => ({
  seatId,
  startsAt: at(start),
  endsAt: at(end),
});
function call(path, { method = 'GET', body, token = tokens.admin, key } = {}) {
  return new Promise((done, reject) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    if (key) headers['idempotency-key'] = key;
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers, localAddress: address },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            done({ status: res.statusCode, body: data ? JSON.parse(data) : undefined });
          } catch {
            reject(new Error('Invalid owned HTTP response'));
          }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error('Owned HTTP request timed out')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const write = (path, method, body, token = tokens.admin, key = randomUUID()) =>
  call(path, { method, body, token, key });
const uuid = (value) =>
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
function pass(message) {
  console.log('PASS ' + ++passed + ': ' + message);
}
async function collect(path, token = tokens.admin, limit = 2) {
  const items = [];
  let cursor;
  for (let page = 0; page < 1000; page++) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const result = await call(path + (path.includes('?') ? '&' : '?') + params, { token });
    assert.equal(result.status, 200);
    items.push(...result.body.items);
    const next = result.body.nextCursor;
    if (!next) return items;
    assert.notEqual(next, cursor, 'Pagination cursor must advance');
    cursor = next;
  }
  assert.fail('Owned pagination did not terminate');
}
async function login(kind) {
  const result = await call('/api/v1/auth/login', {
    method: 'POST',
    token: null,
    body: { username: userId(kind), password },
  });
  assert.equal(result.status, 200, 'Owned fixture login failed');
  tokens[kind] = result.body.accessToken;
  return tokens[kind];
}
async function user(kind) {
  const result = (await collect('/api/v1/users', tokens.admin, 100)).find(
    (item) => item.id === userId(kind),
  );
  assert.ok(result, 'Owned user must be visible to administrator');
  assert.ok(Number.isInteger(result.revision) && result.revision >= 1);
  assert.ok(Array.isArray(result.roleIds) && Array.isArray(result.managedRoomIds));
  return result;
}
const accessBody = (current, changes = {}) => ({
  roleIds: current.roleIds,
  managedRoomIds: current.managedRoomIds,
  enabled: current.enabled,
  reason: 'Owned management integration change',
  expectedRevision: current.revision,
  ...changes,
});
async function start() {
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  port = socket.address().port;
  await new Promise((done) => socket.close(done));
  processHandle = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(root, 'apps/resource-core'),
    env: {
      ...process.env,
      DATABASE_URL: testUrl.href,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'silent',
      API_DOCS_ENABLED: 'false',
      FRONTEND_ORIGINS: 'http://localhost:5173',
      M2_SERVICE_TOKEN: randomBytes(32).toString('base64url'),
      M3_SERVICE_TOKEN: randomBytes(32).toString('base64url'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drain output without exposing credentials or rejected request bodies.
  for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on('data', () => {});
  for (let attempt = 0; attempt < 120; attempt++) {
    if (processHandle.exitCode !== null) throw new Error('Owned application exited before ready');
    try {
      if ((await call('/health/ready', { token: null })).status === 200) return;
    } catch {
      /* Await this owned process only. */
    }
    await delay(100);
  }
  throw new Error('Owned application readiness timed out');
}
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const closed = new Promise((done) => processHandle.once('close', done));
  processHandle.kill('SIGTERM');
  const timer = setTimeout(() => processHandle.kill('SIGKILL'), 5000);
  await closed;
  clearTimeout(timer);
}
async function roomLockProbe(id, action) {
  await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', ['room:' + id]);
  let pending,
    settled = false;
  try {
    pending = action().then((result) => {
      settled = true;
      return result;
    });
    await delay(300);
    assert.equal(settled, false, 'Management write must wait for the exact shared room lock');
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['room:' + id]);
  }
  const result = await pending;
  assert.equal(result.status, 200);
  return result.body;
}
async function setup() {
  await adminDb.connect();
  adminConnected = true;
  await adminDb.query('CREATE DATABASE "' + databaseName + '" OWNER "' + applicationRole + '"');
  createdDatabase = true;
  await db.connect();
  dbConnected = true;
  const migrations = resolve(root, 'apps/resource-core/prisma/migrations');
  for (const name of readdirSync(migrations)
    .filter((value) => /^\d{14}_/.test(value))
    .sort())
    await db.query(readFileSync(resolve(migrations, name, 'migration.sql'), 'utf8'));
  await db.query(
    "INSERT INTO d_service_metadata (key,value) VALUES ('service-name','resource-core')",
  );
  await db.query('INSERT INTO d_booking_policy (id,"maxHours") VALUES (\'default\',4)');
  for (const id of permissionIds)
    await db.query('INSERT INTO d_permissions (id,description) VALUES ($1,$1)', [id]);
  for (const dep of ['a', 'b'])
    await db.query('INSERT INTO d_departments (id,name) VALUES ($1,$1)', [departmentId(dep)]);
  const digest = await hashPassword(password);
  const definitions = [
    ['admin', 'ALL', permissionIds, 'a'],
    [
      'department',
      'DEPARTMENT',
      [
        'd.rooms.write',
        'd.rooms.read',
        'd.departments.write',
        'd.roles.write',
        'd.users.write',
        'd.audit.read',
      ],
      'a',
    ],
    ['managed', 'MANAGED_ROOMS', ['d.rooms.write', 'd.rooms.read'], 'b'],
    ['reader', 'DEPARTMENT', ['d.rooms.read', 'd.departments.read'], 'a'],
    ['target', 'MANAGED_ROOMS', ['d.rooms.read'], 'a'],
    ['limited', 'ALL', ['d.roles.write'], 'a'],
    ['access-limited', 'ALL', ['d.users.write'], 'a'],
  ];
  for (const [kind, scope, permissions, dep] of definitions) {
    await db.query('INSERT INTO d_roles (id,name,scope) VALUES ($1,$1,$2)', [roleId(kind), scope]);
    for (const permission of permissions)
      await db.query('INSERT INTO d_role_permissions ("roleId","permissionId") VALUES ($1,$2)', [
        roleId(kind),
        permission,
      ]);
    await db.query(
      'INSERT INTO d_users (id,username,"displayName","passwordHash","departmentId") VALUES ($1,$1,$1,$2,$3)',
      [userId(kind), digest, departmentId(dep)],
    );
    await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
      userId(kind),
      roleId(kind),
    ]);
  }
  // An unrelated ALL grant must not expand department-scoped resource writes.
  await db.query("INSERT INTO d_roles (id,name,scope) VALUES ($1,$1,'ALL')", [roleId('unrelated')]);
  await db.query(
    'INSERT INTO d_role_permissions ("roleId","permissionId") VALUES ($1,\'d.rooms.read\')',
    [roleId('unrelated')],
  );
  await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
    userId('department'),
    roleId('unrelated'),
  ]);
  for (const [kind, dep, restricted] of [
    ['a', 'a', true],
    ['b', 'b', true],
    ['public', 'b', false],
  ]) {
    await db.query(
      'INSERT INTO d_rooms (id,code,name,"departmentId","restrictedToDepartment") VALUES ($1,$1,$1,$2,$3)',
      [roomId(kind), departmentId(dep), restricted],
    );
    await db.query(
      'INSERT INTO d_seats (id,"roomId",code,"powerType") VALUES ($1,$2,\'S1\',\'FIXED\')',
      [roomId(kind) + '-seat', roomId(kind)],
    );
    for (let weekday = 0; weekday < 7; weekday++)
      await db.query(
        'INSERT INTO d_opening_rules ("roomId",weekday,"opensHour","closesHour") VALUES ($1,$2,8,22)',
        [roomId(kind), weekday],
      );
  }
  await db.query('INSERT INTO d_managed_rooms ("userId","roomId") VALUES ($1,$2)', [
    userId('managed'),
    roomId('a'),
  ]);
  await start();
  for (const [kind] of definitions) await login(kind);
}

try {
  await setup();
  assert.equal((await call('/api/v1/users', { token: null })).status, 401);
  assert.equal((await call('/api/v1/users', { token: tokens.reader })).status, 403);
  assert.equal((await call('/api/v1/audit-events', { token: tokens.department })).status, 403);
  assert.equal(
    (
      await write(
        '/api/v1/departments',
        'POST',
        { name: 'Scoped security refusal' },
        tokens.department,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await write(
        '/api/v1/roles',
        'POST',
        { name: 'Scoped role refusal', scope: 'SELF', permissionIds: [] },
        tokens.department,
      )
    ).status,
    403,
  );
  const publicRoom = (await collect('/api/v1/rooms', tokens.department, 100)).find(
    (item) => item.id === roomId('public'),
  );
  assert.ok(publicRoom, 'Public directory reads may be visible without management authority');
  assert.equal(
    (
      await write(
        '/api/v1/rooms/' + publicRoom.id,
        'PATCH',
        {
          code: publicRoom.code,
          name: publicRoom.name,
          departmentId: publicRoom.departmentId,
          restrictedToDepartment: false,
          enabled: false,
          expectedRevision: publicRoom.revision,
        },
        tokens.department,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await write(
        '/api/v1/rooms/' + roomId('public') + '/seats',
        'POST',
        { code: 'Denied', enabled: true, powerType: 'NONE' },
        tokens.managed,
      )
    ).status,
    403,
  );
  const users = await collect('/api/v1/users', tokens.admin, 2);
  assert.equal(users.length, 7);
  const serializedUsers = JSON.stringify(users);
  for (const field of ['passwordHash', 'tokenHash', 'accessToken'])
    assert.ok(!serializedUsers.includes(field));
  assert.ok(!serializedUsers.includes(password));
  pass(
    'real authentication, exact global security authority, strict public-room management scope and sanitized user pagination',
  );

  const depInput = { name: prefix + ' New department' },
    depKey = randomUUID();
  assert.equal((await call('/api/v1/departments', { method: 'POST', body: depInput })).status, 400);
  assert.equal(
    (await write('/api/v1/departments', 'POST', { ...depInput, id: 'injected' })).status,
    400,
  );
  const duplicate = await Promise.all([
    write('/api/v1/departments', 'POST', depInput, tokens.admin, depKey),
    write('/api/v1/departments', 'POST', depInput, tokens.admin, depKey),
  ]);
  assert.ok(duplicate.every((result) => result.status === 201));
  assert.equal(duplicate[0].body.id, duplicate[1].body.id);
  const department = duplicate[0].body;
  uuid(department.id);
  assert.equal(department.revision, 1);
  assert.equal(
    (
      await write(
        '/api/v1/departments',
        'POST',
        { name: depInput.name + ' mismatch' },
        tokens.admin,
        depKey,
      )
    ).status,
    409,
  );
  assert.equal((await write('/api/v1/departments', 'POST', depInput)).status, 409);
  const patches = [
    { name: prefix + ' revision A', expectedRevision: department.revision },
    { name: prefix + ' revision B', expectedRevision: department.revision },
  ];
  const patchKeys = [randomUUID(), randomUUID()];
  const race = await Promise.all(
    patches.map((body, index) =>
      write('/api/v1/departments/' + department.id, 'PATCH', body, tokens.admin, patchKeys[index]),
    ),
  );
  assert.equal(race.filter((result) => result.status === 200).length, 1);
  assert.equal(race.filter((result) => result.status === 409).length, 1);
  const winner = race.findIndex((result) => result.status === 200);
  assert.equal(race[winner].body.revision, 2);
  assert.deepEqual(
    (
      await write(
        '/api/v1/departments/' + department.id,
        'PATCH',
        patches[winner],
        tokens.admin,
        patchKeys[winner],
      )
    ).body,
    race[winner].body,
  );
  assert.equal(
    (await write('/api/v1/departments/' + department.id, 'PATCH', { name: 'Missing revision' }))
      .status,
    400,
  );
  pass(
    'server-owned department IDs, durable same-key concurrency, uniqueness and revision CAS without lost updates',
  );

  const roleInput = {
    name: prefix + ' Dynamic booker',
    scope: 'SELF',
    permissionIds: ['m1.bookings.create'],
  };
  assert.equal(
    (await write('/api/v1/roles', 'POST', roleInput, tokens.admin, depKey)).status,
    409,
    'D write keys span different management actions',
  );
  assert.equal(
    (await write('/api/v1/roles', 'POST', { ...roleInput, permissionIds: ['missing.permission'] }))
      .status,
    400,
  );
  assert.equal(
    (
      await write('/api/v1/roles', 'POST', {
        ...roleInput,
        permissionIds: ['m1.bookings.create', 'm1.bookings.create'],
      })
    ).status,
    400,
  );
  assert.equal((await write('/api/v1/roles', 'POST', { ...roleInput, scope: 'ROOT' })).status, 400);
  assert.equal(
    (
      await write(
        '/api/v1/roles',
        'POST',
        {
          ...roleInput,
          name: prefix + ' escalated',
          scope: 'ALL',
          permissionIds: ['d.rooms.write'],
        },
        tokens.limited,
      )
    ).status,
    403,
  );
  const createdRole = await write('/api/v1/roles', 'POST', roleInput);
  assert.equal(createdRole.status, 201);
  uuid(createdRole.body.id);
  const dynamicRole = createdRole.body;
  assert.equal(dynamicRole.revision, 1);
  const listedRole = (await collect('/api/v1/roles', tokens.admin, 2)).find(
    (item) => item.id === dynamicRole.id,
  );
  assert.deepEqual(listedRole.permissionIds, ['m1.bookings.create']);
  assert.equal(listedRole.scope, 'SELF');
  pass(
    'role references and duplicate grants validated, unrelated authority cannot escalate permissions, dynamic role is persisted',
  );

  let target = await user('target');
  const oldTargetToken = tokens.target;
  const grantKey = randomUUID();
  const grant = accessBody(target, { roleIds: [...target.roleIds, dynamicRole.id] });
  const granted = await write(
    '/api/v1/users/' + target.id + '/access',
    'PUT',
    grant,
    tokens.admin,
    grantKey,
  );
  assert.equal(granted.status, 200);
  assert.equal(granted.body.revision, target.revision + 1);
  assert.equal(
    (await call('/api/v1/auth/me', { token: oldTargetToken })).status,
    401,
    'Access updates must revoke old sessions atomically',
  );
  assert.deepEqual(
    (await write('/api/v1/users/' + target.id + '/access', 'PUT', grant, tokens.admin, grantKey))
      .body,
    granted.body,
  );
  assert.equal(
    (
      await write(
        '/api/v1/users/' + target.id + '/access',
        'PUT',
        { ...grant, reason: 'Changed key payload' },
        tokens.admin,
        grantKey,
      )
    ).status,
    409,
  );
  await login('target');
  assert.ok(
    (await call('/api/v1/auth/me', { token: tokens.target })).body.permissions.includes(
      'm1.bookings.create',
    ),
  );
  const targetBooking = await write(
    '/api/v1/bookings',
    'POST',
    bookingInput(roomId('a') + '-seat'),
    tokens.target,
  );
  assert.equal(targetBooking.status, 201, 'New role must change actual backend behavior');
  const roleChanged = await write('/api/v1/roles/' + dynamicRole.id, 'PATCH', {
    ...roleInput,
    permissionIds: [],
    expectedRevision: dynamicRole.revision,
  });
  assert.equal(roleChanged.status, 200);
  const revoked = await write(
    '/api/v1/bookings',
    'POST',
    bookingInput(roomId('a') + '-seat', 10, 11),
    tokens.target,
  );
  assert.equal(revoked.status, 401, 'Role changes revoke affected user sessions');
  await login('target');
  target = await user('target');
  const beforeDisable = tokens.target;
  const disabled = await write(
    '/api/v1/users/' + target.id + '/access',
    'PUT',
    accessBody(target, { enabled: false }),
  );
  assert.equal(disabled.status, 200);
  assert.equal((await call('/api/v1/auth/me', { token: beforeDisable })).status, 401);
  const disabledLogin = await call('/api/v1/auth/login', {
    method: 'POST',
    token: null,
    body: { username: userId('target'), password },
  });
  assert.equal(disabledLogin.status, 401);
  target = await user('target');
  assert.equal(
    (
      await write(
        '/api/v1/users/' + target.id + '/access',
        'PUT',
        accessBody(target, { enabled: true }),
      )
    ).status,
    200,
  );
  await login('target');
  assert.equal((await call('/api/v1/auth/me', { token: tokens.target })).status, 200);
  pass(
    'new roles affect real booking behavior, role revocation is immediate, user access writes revoke sessions and disablement persists',
  );

  const currentAdmin = await user('admin');
  assert.equal(
    (
      await write(
        '/api/v1/users/' + currentAdmin.id + '/access',
        'PUT',
        accessBody(currentAdmin, { enabled: false }),
      )
    ).status,
    403,
    'An administrator must not change their own access',
  );
  const lastAdminRole = (await collect('/api/v1/roles', tokens.admin, 100)).find(
    (item) => item.id === roleId('admin'),
  );
  assert.equal(
    (
      await write('/api/v1/roles/' + lastAdminRole.id, 'PATCH', {
        name: lastAdminRole.name,
        scope: lastAdminRole.scope,
        permissionIds: lastAdminRole.permissionIds.filter((id) => id !== 'd.users.write'),
        expectedRevision: lastAdminRole.revision,
      })
    ).status,
    409,
    'The final fully authorized security administrator must remain usable',
  );
  assert.equal((await call('/api/v1/users')).status, 200);
  assert.equal(
    (
      await write('/api/v1/departments/' + randomUUID(), 'PATCH', {
        name: 'Missing entity',
        expectedRevision: 1,
      })
    ).status,
    404,
  );
  target = await user('target');
  assert.equal(
    (
      await write(
        '/api/v1/users/' + target.id + '/access',
        'PUT',
        accessBody(target, { roleIds: [randomUUID()] }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await write(
        '/api/v1/users/' + target.id + '/access',
        'PUT',
        accessBody(target, { reason: '' }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await write(
        '/api/v1/users/' + target.id + '/access',
        'PUT',
        accessBody(target, { managedRoomIds: [roomId('a')] }),
        tokens['access-limited'],
      )
    ).status,
    403,
    'Keeping roles unchanged must not bypass grant limits when expanding managed rooms',
  );
  await db.query(
    'INSERT INTO d_users (id,username,"displayName","passwordHash","departmentId",enabled) SELECT $1,$1,$1,"passwordHash","departmentId",false FROM d_users WHERE id=$2',
    [userId('revival'), userId('target')],
  );
  await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
    userId('revival'),
    roleId('target'),
  ]);
  await db.query('INSERT INTO d_managed_rooms ("userId","roomId") VALUES ($1,$2)', [
    userId('revival'),
    roomId('a'),
  ]);
  const revival = await user('revival');
  assert.equal(
    (
      await write(
        '/api/v1/users/' + revival.id + '/access',
        'PUT',
        accessBody(revival, { enabled: true }),
        tokens['access-limited'],
      )
    ).status,
    403,
    'Re-enabling unchanged roles still grants effective access and requires the grant ceiling',
  );
  pass(
    'self-access changes and last-administrator removal blocked, invalid references rejected, unchanged roles cannot hide new access grants',
  );

  const roomInput = {
    code: prefix + '-CREATED',
    name: 'Owned created classroom',
    departmentId: department.id,
    restrictedToDepartment: true,
    enabled: true,
  };
  assert.equal(
    (await write('/api/v1/rooms', 'POST', { ...roomInput, id: 'injected' })).status,
    400,
  );
  assert.equal(
    (await write('/api/v1/rooms', 'POST', { ...roomInput, departmentId: null })).status,
    400,
  );
  assert.equal(
    (await write('/api/v1/rooms', 'POST', { ...roomInput, departmentId: randomUUID() })).status,
    400,
  );
  assert.equal((await write('/api/v1/rooms', 'POST', roomInput, tokens.managed)).status, 403);
  assert.equal(
    (
      await write(
        '/api/v1/rooms',
        'POST',
        { ...roomInput, departmentId: departmentId('b') },
        tokens.department,
      )
    ).status,
    403,
  );
  const createRoomKey = randomUUID();
  const roomCreated = await write('/api/v1/rooms', 'POST', roomInput, tokens.admin, createRoomKey);
  assert.equal(roomCreated.status, 201);
  let managedRoom = roomCreated.body;
  uuid(managedRoom.id);
  assert.equal(managedRoom.revision, 1);
  assert.deepEqual(
    (await write('/api/v1/rooms', 'POST', roomInput, tokens.admin, createRoomKey)).body,
    managedRoom,
  );
  assert.equal((await write('/api/v1/rooms', 'POST', roomInput)).status, 409);
  const roomPatch = (changes) => ({
    ...roomInput,
    name: managedRoom.name,
    enabled: managedRoom.enabled,
    expectedRevision: managedRoom.revision,
    ...changes,
  });
  assert.equal(
    (
      await write(
        '/api/v1/rooms/' + managedRoom.id,
        'PATCH',
        roomPatch({ departmentId: departmentId('b') }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await write(
        '/api/v1/rooms/' + managedRoom.id,
        'PATCH',
        roomPatch({ restrictedToDepartment: false }),
      )
    ).status,
    409,
  );
  managedRoom = await roomLockProbe(managedRoom.id, () =>
    write(
      '/api/v1/rooms/' + managedRoom.id,
      'PATCH',
      roomPatch({ name: 'Owned renamed classroom' }),
    ),
  );
  assert.equal(managedRoom.name, 'Owned renamed classroom');
  const withinDepartment = await write(
    '/api/v1/rooms',
    'POST',
    {
      code: prefix + '-DEPT',
      name: 'Department owned classroom',
      departmentId: departmentId('a'),
      restrictedToDepartment: true,
      enabled: true,
    },
    tokens.department,
  );
  assert.equal(withinDepartment.status, 201);
  assert.equal(
    (
      await write(
        '/api/v1/rooms/' + roomId('a'),
        'PATCH',
        {
          code: roomId('a'),
          name: 'Managed-room write succeeds',
          departmentId: departmentId('a'),
          restrictedToDepartment: true,
          enabled: true,
          expectedRevision: 1,
        },
        tokens.managed,
      )
    ).status,
    200,
  );
  pass(
    'classroom creation scope, immutable department ownership, unique codes and shared-lock metadata updates',
  );

  const seatInput = { code: 'OWNED-1', powerType: 'FIXED', enabled: true };
  const seatKey = randomUUID();
  const seatCreated = await write(
    '/api/v1/rooms/' + managedRoom.id + '/seats',
    'POST',
    seatInput,
    tokens.admin,
    seatKey,
  );
  assert.equal(seatCreated.status, 201);
  let managedSeat = seatCreated.body;
  uuid(managedSeat.id);
  assert.equal(managedSeat.revision, 1);
  assert.deepEqual(
    (
      await write(
        '/api/v1/rooms/' + managedRoom.id + '/seats',
        'POST',
        seatInput,
        tokens.admin,
        seatKey,
      )
    ).body,
    managedSeat,
  );
  assert.equal(
    (await write('/api/v1/rooms/' + managedRoom.id + '/seats', 'POST', seatInput)).status,
    409,
  );
  assert.equal(
    (
      await write('/api/v1/rooms/' + managedRoom.id + '/seats', 'POST', {
        ...seatInput,
        code: 'BAD',
        powerType: 'USB',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await write('/api/v1/seats/' + managedSeat.id, 'PATCH', {
        ...seatInput,
        expectedRevision: 1,
        roomId: roomId('b'),
      })
    ).status,
    400,
  );
  managedSeat = await roomLockProbe(managedRoom.id, () =>
    write('/api/v1/seats/' + managedSeat.id, 'PATCH', {
      ...seatInput,
      code: 'OWNED-RENAMED',
      expectedRevision: managedSeat.revision,
    }),
  );
  assert.equal(managedSeat.revision, 2);
  assert.equal(
    (await write('/api/v1/seats/' + managedSeat.id, 'PATCH', { ...seatInput, expectedRevision: 1 }))
      .status,
    409,
  );
  const seatList = await collect('/api/v1/rooms/' + managedRoom.id + '/seats', tokens.admin, 1);
  assert.equal(seatList.length, 1);
  assert.equal(seatList[0].code, 'OWNED-RENAMED');
  pass(
    'seat identity, socket enumeration, per-room uniqueness, immutable room binding and versioned room-lock writes',
  );

  const openingPath = '/api/v1/rooms/' + managedRoom.id + '/opening-rules';
  let opening = (await call(openingPath)).body;
  assert.equal(opening.roomId, managedRoom.id);
  assert.equal(opening.revision, managedRoom.revision);
  assert.deepEqual(opening.rules, []);
  const openingBody = (changes) => ({
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    opensAt: '08:00',
    closesAt: '22:00',
    timezone: 'Asia/Shanghai',
    expectedRevision: opening.revision,
    ...changes,
  });
  assert.equal((await write(openingPath, 'PUT', openingBody({ weekdays: [0] }))).status, 400);
  assert.equal((await write(openingPath, 'PUT', openingBody({ opensAt: '08:30' }))).status, 400);
  assert.equal((await write(openingPath, 'PUT', openingBody({ closesAt: '07:00' }))).status, 400);
  assert.equal((await write(openingPath, 'PUT', openingBody({ timezone: 'UTC' }))).status, 400);
  assert.equal(
    (await write('/api/v1/bookings', 'POST', bookingInput(managedSeat.id))).status,
    409,
    'No opening rule means no allocation',
  );
  opening = await roomLockProbe(managedRoom.id, () => write(openingPath, 'PUT', openingBody()));
  assert.equal(opening.rules.length, 7);
  assert.equal(opening.timezone, 'Asia/Shanghai');
  assert.equal(
    (await write(openingPath, 'PUT', openingBody({ expectedRevision: opening.revision - 1 })))
      .status,
    409,
  );
  const booked = await write('/api/v1/bookings', 'POST', bookingInput(managedSeat.id));
  assert.equal(booked.status, 201);
  assert.equal(
    (await write('/api/v1/bookings', 'POST', bookingInput(managedSeat.id))).status,
    409,
    'Existing personal allocation remains exclusive',
  );
  managedSeat = (await collect('/api/v1/rooms/' + managedRoom.id + '/seats', tokens.admin, 100))[0];
  const disabledSeat = await write('/api/v1/seats/' + managedSeat.id, 'PATCH', {
    code: managedSeat.code,
    powerType: managedSeat.powerType,
    enabled: false,
    expectedRevision: managedSeat.revision,
  });
  assert.equal(disabledSeat.status, 200);
  managedSeat = disabledSeat.body;
  assert.equal(
    (await write('/api/v1/bookings', 'POST', bookingInput(managedSeat.id, 10, 11))).status,
    409,
  );
  assert.equal(
    (await call('/api/v1/bookings/' + booked.body.id)).body.status,
    'BOOKED',
    'Disabling a resource preserves existing history',
  );
  const enabledSeat = await write('/api/v1/seats/' + managedSeat.id, 'PATCH', {
    code: managedSeat.code,
    powerType: managedSeat.powerType,
    enabled: true,
    expectedRevision: managedSeat.revision,
  });
  assert.equal(enabledSeat.status, 200);
  managedSeat = enabledSeat.body;
  managedRoom = (await collect('/api/v1/rooms', tokens.admin, 100)).find(
    (item) => item.id === managedRoom.id,
  );
  const disabledRoom = await write(
    '/api/v1/rooms/' + managedRoom.id,
    'PATCH',
    roomPatch({ enabled: false }),
  );
  assert.equal(disabledRoom.status, 200);
  managedRoom = disabledRoom.body;
  assert.equal(
    (await write('/api/v1/bookings', 'POST', bookingInput(managedSeat.id, 10, 11))).status,
    409,
  );
  assert.equal((await call('/api/v1/bookings/' + booked.body.id)).body.status, 'BOOKED');
  const enabledRoom = await write(
    '/api/v1/rooms/' + managedRoom.id,
    'PATCH',
    roomPatch({ enabled: true }),
  );
  assert.equal(enabledRoom.status, 200);
  managedRoom = enabledRoom.body;
  opening = (await call(openingPath)).body;
  const closed = await write(openingPath, 'PUT', openingBody({ weekdays: [] }));
  assert.equal(closed.status, 200);
  opening = closed.body;
  assert.deepEqual((await call(openingPath)).body.rules, []);
  assert.equal(
    (await write('/api/v1/bookings', 'POST', bookingInput(managedSeat.id, 10, 11))).status,
    409,
  );
  const sunday = await write(openingPath, 'PUT', openingBody({ weekdays: [7], closesAt: '24:00' }));
  assert.equal(sunday.status, 200);
  opening = sunday.body;
  assert.deepEqual(opening.rules, [{ weekday: 7, opensHour: 8, closesHour: 24 }]);
  const storedSunday = (
    await db.query(
      'SELECT weekday,"opensHour","closesHour" FROM d_opening_rules WHERE "roomId"=$1',
      [managedRoom.id],
    )
  ).rows;
  assert.deepEqual(storedSunday, [{ weekday: 0, opensHour: 8, closesHour: 24 }]);
  pass(
    'weekly replacement including Sunday/24:00 and full closure, M1 reads real opening rules, resource disablement preserves existing bookings',
  );

  const audits = await collect(
    '/api/v1/audit-events?targetId=' + encodeURIComponent(managedRoom.id),
    tokens.admin,
    1,
  );
  assert.ok(audits.length >= 4);
  assert.equal(new Set(audits.map((event) => event.id)).size, audits.length);
  assert.ok(
    audits.every(
      (event) =>
        event.targetId === managedRoom.id && event.actorId === userId('admin') && event.traceId,
    ),
  );
  const changes = await collect(
    '/api/v1/audit-events?targetId=' + encodeURIComponent(userId('target')),
    tokens.admin,
    1,
  );
  assert.ok(changes.some((event) => event.reason === 'Owned management integration change'));
  const serializedAudit = JSON.stringify(audits.concat(changes));
  assert.ok(!serializedAudit.includes(password));
  for (const token of Object.values(tokens)) assert.ok(!serializedAudit.includes(token));
  assert.equal((await call('/api/v1/audit-events?cursor=invalid')).status, 400);
  const absentAction = await call('/api/v1/audit-events?action=no.such.owned.action');
  assert.equal(absentAction.status, 200);
  assert.deepEqual(absentAction.body.items, []);
  assert.equal(
    (await call('/api/v1/audit-events?targetId=' + managedRoom.id, { token: tokens.department }))
      .status,
    403,
  );
  pass(
    'management audit is transactional, scoped to exact filters and paginated without password or bearer leakage',
  );

  // The policy writer is authenticated before it waits on its own receipt lock.
  // A different real administrator then disables that user through the HTTP API.
  // The resumed write must recheck current authority, not its stale request identity.
  await db.query("INSERT INTO d_roles (id,name,scope) VALUES ($1,$1,'ALL')", [
    roleId('policy-writer'),
  ]);
  await db.query(
    'INSERT INTO d_role_permissions ("roleId","permissionId") VALUES ($1,\'d.settings.write\')',
    [roleId('policy-writer')],
  );
  await db.query(
    'INSERT INTO d_users (id,username,"displayName","passwordHash","departmentId") SELECT $1,$1,$1,"passwordHash","departmentId" FROM d_users WHERE id=$2',
    [userId('policy-writer'), userId('admin')],
  );
  await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
    userId('policy-writer'),
    roleId('policy-writer'),
  ]);
  await login('policy-writer');
  const policyWriter = await user('policy-writer');
  const beforePolicy = await call('/api/v1/settings/booking-policy');
  assert.equal(beforePolicy.status, 200);
  const policyKey = randomUUID();
  const receiptLock = 'd-write:' + policyWriter.id + ':' + policyKey;
  const policyBody = {
    ...beforePolicy.body,
    maxHours: beforePolicy.body.maxHours === 4 ? 3 : 4,
  };
  await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [receiptLock]);
  let pendingPolicy,
    policyResult,
    policySettled = false;
  try {
    pendingPolicy = write(
      '/api/v1/settings/booking-policy',
      'PUT',
      policyBody,
      tokens['policy-writer'],
      policyKey,
    ).then((result) => {
      policySettled = true;
      return result;
    });
    await delay(350);
    assert.equal(policySettled, false, 'Policy write must be pending on the owned receipt lock');
    const waiting = await db.query(
      "SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND l.locktype='advisory' AND NOT l.granted",
      [databaseName],
    );
    assert.ok(
      waiting.rows[0].count >= 1,
      'Authenticated policy request must have reached the database lock',
    );
    const disabledWriter = await write(
      '/api/v1/users/' + policyWriter.id + '/access',
      'PUT',
      accessBody(policyWriter, { enabled: false, reason: 'Owned policy authorization race' }),
    );
    assert.equal(
      disabledWriter.status,
      200,
      'Independent administrator must commit revocation before the write resumes',
    );
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [receiptLock]);
    if (pendingPolicy) policyResult = await pendingPolicy;
  }
  assert.equal(
    policyResult.status,
    403,
    'Resumed settings write must reject the now disabled actor',
  );
  const afterPolicy = await call('/api/v1/settings/booking-policy');
  assert.equal(afterPolicy.status, 200);
  assert.deepEqual(
    afterPolicy.body,
    beforePolicy.body,
    'Rejected stale authority must leave both policy contents and revision unchanged',
  );
  pass(
    'booking-policy writes revalidate authority after a real concurrent user revocation without changing the policy',
  );

  // Two administrators try to disable one another. Shared security serialization
  // plus a fresh actor check must allow at most one write, not zero usable admins.
  await db.query(
    'INSERT INTO d_users (id,username,"displayName","passwordHash","departmentId") SELECT $1,$1,$1,"passwordHash","departmentId" FROM d_users WHERE id=$2',
    [userId('backup'), userId('admin')],
  );
  await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
    userId('backup'),
    roleId('admin'),
  ]);
  await login('backup');
  const primary = await user('admin'),
    backup = await user('backup');
  const disableRace = await Promise.all([
    write(
      '/api/v1/users/' + backup.id + '/access',
      'PUT',
      accessBody(backup, { enabled: false }),
      tokens.admin,
    ),
    write(
      '/api/v1/users/' + primary.id + '/access',
      'PUT',
      accessBody(primary, { enabled: false }),
      tokens.backup,
    ),
  ]);
  assert.equal(
    disableRace.filter((result) => result.status === 200).length,
    1,
    'Exactly one mutually disabling administrator may commit',
  );
  assert.ok(
    disableRace
      .filter((result) => result.status !== 200)
      .every((result) => [401, 403, 409].includes(result.status)),
  );
  const remaining = (
    await db.query(
      'SELECT count(*)::int AS count FROM d_users u WHERE u.enabled AND EXISTS (SELECT 1 FROM d_user_roles ur JOIN d_roles r ON r.id=ur."roleId" JOIN d_role_permissions rp ON rp."roleId"=r.id WHERE ur."userId"=u.id AND r.scope=\'ALL\' AND rp."permissionId"=\'d.users.write\') AND EXISTS (SELECT 1 FROM d_user_roles ur JOIN d_roles r ON r.id=ur."roleId" JOIN d_role_permissions rp ON rp."roleId"=r.id WHERE ur."userId"=u.id AND r.scope=\'ALL\' AND rp."permissionId"=\'d.roles.write\')',
    )
  ).rows[0].count;
  assert.ok(remaining >= 1, 'A usable global security administrator must survive the race');
  pass(
    'concurrent security changes revalidate the actor and cannot eliminate every authorized administrator',
  );
} finally {
  await stop();
  if (dbConnected) await db.end();
  try {
    if (createdDatabase) {
      assert.match(databaseName, /^it_admin_[a-f0-9]{16}$/);
      await adminDb.query('DROP DATABASE "' + databaseName + '"');
      console.log(
        'Owned admin-management database removed; shared data and configuration preserved.',
      );
    }
  } finally {
    if (adminConnected) await adminDb.end();
  }
}
console.log(passed + ' admin-management groups passed with real PostgreSQL and HTTP.');
