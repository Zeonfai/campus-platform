// Real local PostgreSQL and HTTP behavior tests. Never resets a database or a volume.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { hashPassword } from '../apps/resource-core/dist/modules/d/password.js';
import { hashToken } from '../apps/resource-core/dist/modules/d/identity.service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const backendRequire = createRequire(
  new URL('../apps/resource-core/package.json', import.meta.url),
);
const { parse } = backendRequire('dotenv');
const { Client } = backendRequire('pg');
const configuration = parse(readFileSync(resolve(root, 'apps/resource-core/.env'), 'utf8'));
const database = configuration.DATABASE_URL;
assert.ok(
  database && new URL(database).hostname === '127.0.0.1',
  'Only the local database is allowed',
);
const db = new Client({ connectionString: database });
const prefix = `it-auth-${randomUUID().slice(0, 12)}`;
const password = randomBytes(24).toString('base64url');
const bucketKeys = new Set();
const addresses = new Map();
const ipSegment = randomBytes(1)[0];
let addressIndex = 1;
let processHandle;
let processOutput = '';
let port;
let passed = 0;
function sourceAddress(name) {
  if (!addresses.has(name)) addresses.set(name, `127.77.${ipSegment}.${addressIndex++}`);
  const address = addresses.get(name);
  bucketKeys.add(hashToken(`login:ip:${address}`));
  return address;
}
function call(path, { method = 'GET', body, token, key, source = 'normal' } = {}) {
  return new Promise((done, reject) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const request = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers, localAddress: sourceAddress(source) },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          try {
            done({
              status: response.statusCode,
              headers: response.headers,
              body: data ? JSON.parse(data) : undefined,
            });
          } catch {
            reject(new Error('Response is not JSON'));
          }
        });
      },
    );
    request.setTimeout(12000, () => request.destroy(new Error('HTTP timeout')));
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function login(kind, source = 'normal', supplied = password) {
  const username = `${prefix}-${kind}`;
  bucketKeys.add(hashToken(`login:account:${username}`));
  return call('/api/v1/auth/login', {
    method: 'POST',
    body: { username, password: supplied },
    source,
  });
}
async function session(kind, source = 'normal') {
  const result = await login(kind, source);
  assert.equal(result.status, 200, `Login must succeed for fixture ${kind}`);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(result.body.accessToken), 'Opaque token shape');
  return result.body.accessToken;
}
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const child = processHandle;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await new Promise((done) => child.once('close', done));
  clearTimeout(timer);
  processHandle = undefined;
}
async function start() {
  const reservation = createServer();
  await new Promise((done, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', done);
  });
  port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  processHandle = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(root, 'apps/resource-core'),
    env: {
      ...process.env,
      DATABASE_URL: database,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      FRONTEND_ORIGINS: 'http://localhost:5173',
      API_DOCS_ENABLED: 'false',
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processOutput = '';
  processHandle.stdout.on('data', (chunk) => {
    processOutput = (processOutput + String(chunk)).slice(-6000);
  });
  processHandle.stderr.on('data', (chunk) => {
    processOutput = (processOutput + String(chunk)).slice(-6000);
  });
  for (let i = 0; i < 100; i++) {
    if (processHandle.exitCode !== null)
      throw new Error(
        `Temporary service exited: ${processOutput.replaceAll(database, '[REDACTED]')}`,
      );
    try {
      if ((await call('/health/ready')).status === 200) return;
    } catch {
      /* process starting */
    }
    await delay(100);
  }
  throw new Error('Temporary service did not become ready');
}
function success(name) {
  passed++;
  console.log(`PASS ${passed}: ${name}`);
}
async function setup() {
  const hash = await hashPassword(password);
  await db.query('BEGIN');
  try {
    for (const [id, name] of [
      ['a', 'Department A'],
      ['b', 'Department B'],
    ])
      await db.query('INSERT INTO d_departments (id,name) VALUES ($1,$2)', [
        `${prefix}-dept-${id}`,
        `${prefix}-${name}`,
      ]);
    for (const id of ['d.rooms.read', 'd.departments.read', 'd.roles.read', 'd.roles.write'])
      await db.query(
        'INSERT INTO d_permissions (id,description) VALUES ($1,$1) ON CONFLICT DO NOTHING',
        [id],
      );
    for (const [kind, scope, permissions] of [
      ['all', 'ALL', ['d.rooms.read', 'd.departments.read', 'd.roles.read', 'd.roles.write']],
      ['department', 'DEPARTMENT', ['d.rooms.read', 'd.departments.read']],
      ['managed', 'MANAGED_ROOMS', ['d.rooms.read', 'd.departments.read']],
      ['self', 'SELF', ['d.rooms.read', 'd.departments.read']],
      ['unrelated', 'ALL', ['d.departments.read']],
      ['none', 'SELF', []],
    ]) {
      await db.query('INSERT INTO d_roles (id,name,scope) VALUES ($1,$1,$2)', [
        `${prefix}-role-${kind}`,
        scope,
      ]);
      for (const permission of permissions)
        await db.query('INSERT INTO d_role_permissions ("roleId","permissionId") VALUES ($1,$2)', [
          `${prefix}-role-${kind}`,
          permission,
        ]);
    }
    for (const kind of [
      'all',
      'department',
      'managed',
      'self',
      'none',
      'disabled',
      'account-limit',
    ]) {
      const id = `${prefix}-${kind}`;
      await db.query(
        'INSERT INTO d_users (id,username,"displayName","passwordHash",enabled,"departmentId") VALUES ($1,$1,$1,$2,$3,$4)',
        [id, hash, kind !== 'disabled', `${prefix}-dept-a`],
      );
      const role = ['disabled', 'account-limit'].includes(kind) ? 'none' : kind;
      await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
        id,
        `${prefix}-role-${role}`,
      ]);
    }
    // ALL for another permission must not expand the room permission's department scope.
    await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
      `${prefix}-department`,
      `${prefix}-role-unrelated`,
    ]);
    for (const [kind, department, restricted] of [
      ['a', 'a', true],
      ['b', 'b', true],
      ['public', 'b', false],
    ]) {
      const id = `${prefix}-room-${kind}`;
      await db.query(
        'INSERT INTO d_rooms (id,code,name,"departmentId","restrictedToDepartment") VALUES ($1,$1,$1,$2,$3)',
        [id, `${prefix}-dept-${department}`, restricted],
      );
      for (const [index, power] of ['NONE', 'FIXED', 'RAIL'].entries())
        await db.query('INSERT INTO d_seats (id,"roomId",code,"powerType") VALUES ($1,$2,$3,$4)', [
          `${id}-seat-${index}`,
          id,
          `S${index}`,
          power,
        ]);
    }
    await db.query('INSERT INTO d_managed_rooms ("userId","roomId") VALUES ($1,$2)', [
      `${prefix}-managed`,
      `${prefix}-room-a`,
    ]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
async function cleanup() {
  // Only rows belonging to this run, by exact IDs/hashes. Does not delete the demo data.
  await db.query('BEGIN');
  try {
    await db.query('DELETE FROM d_audit_events WHERE "actorId" LIKE $1', [`${prefix}-%`]);
    await db.query('DELETE FROM d_users WHERE id LIKE $1', [`${prefix}-%`]);
    await db.query('DELETE FROM d_roles WHERE id LIKE $1', [`${prefix}-%`]);
    await db.query('DELETE FROM d_seats WHERE id LIKE $1', [`${prefix}-%`]);
    await db.query('DELETE FROM d_rooms WHERE id LIKE $1', [`${prefix}-%`]);
    await db.query('DELETE FROM d_departments WHERE id LIKE $1', [`${prefix}-%`]);
    await db.query('DELETE FROM d_login_buckets WHERE key = ANY($1::text[])', [[...bucketKeys]]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

await db.connect();
try {
  await setup();
  await start();
  assert.equal((await call('/api/v1/rooms')).status, 401);
  assert.equal(
    (
      await call('/api/v1/auth/login', {
        method: 'POST',
        body: { username: 'x', password, injected: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (await call('/api/v1/auth/login', { method: 'POST', body: { username: [], password } })).status,
    400,
  );
  const bad = await login('all', 'wrong', 'incorrect');
  const missing = await login('nonexistent', 'missing');
  const disabled = await login('disabled', 'disabled');
  assert.equal(bad.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(disabled.status, 401);
  assert.equal(bad.body.error.message, missing.body.error.message);
  assert.equal(bad.body.error.message, disabled.body.error.message);
  assert.ok(bad.body.error.traceId);
  success('input validation, unauthenticated rejection and uniform invalid credentials');

  const globalToken = await session('all');
  const current = await call('/api/v1/auth/me', { token: globalToken });
  assert.equal(current.status, 200);
  assert.equal(current.body.id, `${prefix}-all`);
  assert.equal(current.headers['cache-control'], 'no-store');
  assert.equal('passwordHash' in current.body, false);
  const stored = (
    await db.query('SELECT "tokenHash" FROM d_sessions WHERE "userId"=$1', [`${prefix}-all`])
  ).rows;
  assert.equal(stored.length, 1);
  assert.ok(stored[0].tokenHash === hashToken(globalToken));
  const noPermission = await session('none');
  assert.equal(
    (await call('/api/v1/rooms', { token: noPermission })).status,
    403,
    'An authenticated user without room permission must be denied',
  );
  success('real session persistence stores only token digest and enforces backend permissions');

  const departmentToken = await session('department');
  const managedToken = await session('managed');
  const selfToken = await session('self');
  const departmentRooms = await call('/api/v1/rooms?limit=100', { token: departmentToken });
  assert.equal(departmentRooms.status, 200);
  assert.deepEqual(
    departmentRooms.body.items
      .filter((r) => r.id.startsWith(prefix))
      .map((r) => r.id)
      .sort(),
    [`${prefix}-room-a`, `${prefix}-room-public`].sort(),
  );
  const managedRooms = await call('/api/v1/rooms?limit=100', { token: managedToken });
  assert.deepEqual(
    managedRooms.body.items.map((r) => r.id),
    [`${prefix}-room-a`],
  );
  assert.deepEqual((await call('/api/v1/rooms', { token: selfToken })).body.items, []);
  assert.deepEqual((await call('/api/v1/departments', { token: selfToken })).body.items, []);
  const managedDepartments = await call('/api/v1/departments', { token: managedToken });
  assert.deepEqual(
    managedDepartments.body.items.map((item) => item.id),
    [prefix + '-dept-a'],
  );
  assert.equal(
    (await call(`/api/v1/rooms/${prefix}-room-b/seats`, { token: departmentToken })).status,
    404,
  );
  assert.equal((await call('/api/v1/roles', { token: departmentToken })).status, 403);
  assert.equal((await call('/api/v1/roles', { token: globalToken })).status, 200);
  assert.equal((await call('/api/v1/permissions', { token: globalToken })).status, 200);
  success(
    'department/managed/SELF isolation, hidden foreign seats and permission-specific scope union',
  );

  const seatResponse = await call(`/api/v1/rooms/${prefix}-room-a/seats?limit=100`, {
    token: managedToken,
  });
  assert.equal(seatResponse.status, 200);
  assert.deepEqual(seatResponse.body.items.map((s) => s.powerType).sort(), [
    'FIXED',
    'NONE',
    'RAIL',
  ]);
  const seen = new Set();
  let cursor;
  for (let i = 0; i < 100; i++) {
    const result = await call(
      `/api/v1/rooms?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { token: globalToken },
    );
    assert.equal(result.status, 200);
    for (const room of result.body.items) {
      assert.equal(seen.has(room.id), false);
      seen.add(room.id);
    }
    cursor = result.body.nextCursor;
    if (!cursor) break;
  }
  assert.equal([...seen].filter((id) => id.startsWith(prefix)).length, 3);
  for (const query of ['limit=0', 'limit=101', 'limit=no', 'limit=1&extra=true', 'cursor='])
    assert.equal((await call(`/api/v1/rooms?${query}`, { token: globalToken })).status, 400);
  success('three socket types, stable pagination and strict query validation');

  await db.query('DELETE FROM d_role_permissions WHERE "roleId"=$1 AND "permissionId"=$2', [
    `${prefix}-role-managed`,
    'd.rooms.read',
  ]);
  assert.equal(
    (await call('/api/v1/rooms', { token: managedToken })).status,
    403,
    'Existing sessions must reflect revocation',
  );
  await db.query('UPDATE d_users SET enabled=false WHERE id=$1', [`${prefix}-managed`]);
  assert.equal((await call('/api/v1/auth/me', { token: managedToken })).status, 401);
  await db.query(
    'UPDATE d_sessions SET "expiresAt"=CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE "tokenHash"=$1',
    [hashToken(selfToken)],
  );
  assert.equal((await call('/api/v1/auth/me', { token: selfToken })).status, 401);
  success(
    'live role revocation, user disablement and server-side expiry invalidate existing access',
  );

  assert.equal(
    (await call('/api/v1/auth/logout', { method: 'POST', token: departmentToken })).status,
    400,
  );
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      call('/api/v1/auth/logout', { method: 'POST', token: departmentToken, key: randomUUID() }),
    ),
  );
  assert.ok(results.every((r) => r.status === 204));
  assert.equal((await call('/api/v1/auth/me', { token: departmentToken })).status, 401);
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int AS count FROM d_audit_events WHERE "actorId"=$1 AND action=\'auth.logout\'',
        [`${prefix}-department`],
      )
    ).rows[0].count,
    1,
  );
  success('concurrent idempotent logout, immediate invalidation and one transactional audit event');

  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, i) => login(`burst-${i}`, 'parallel')),
  );
  assert.ok(concurrent.some((r) => r.status === 429));
  assert.ok(concurrent.filter((r) => r.status === 401).length <= 2);
  for (let i = 0; i < 10; i++)
    assert.equal((await login('account-limit', 'account-limit', 'incorrect')).status, 401);
  assert.equal((await login('account-limit', 'account-limit')).status, 429);
  success('parallel password-computation bound and persistent per-account throttle');

  await Promise.all(Array.from({ length: 30 }, (_, i) => login(`ip-limit-${i}`, 'ip-limit')));
  assert.equal((await login('all', 'ip-limit')).status, 429);
  await stop();
  await start();
  assert.equal((await login('account-limit', 'account-limit')).status, 429);
  assert.equal((await login('all', 'ip-limit')).status, 429);
  assert.equal((await call('/api/v1/auth/me', { token: globalToken })).status, 200);
  success('account/IP throttles and valid sessions survive service restart');
} finally {
  await stop();
  try {
    await cleanup();
  } finally {
    await db.end();
  }
}
console.log(
  `${passed} real database/HTTP identity groups passed. Owned processes and test fixtures removed.`,
);
