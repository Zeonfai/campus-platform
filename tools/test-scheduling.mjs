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
import { ResourceCoreClient, ResourceApiError } from '../packages/contracts/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireBackend = createRequire(
  new URL('../apps/resource-core/package.json', import.meta.url),
);
const { Client } = requireBackend('pg');
const { parse } = requireBackend('dotenv');
const config = parse(readFileSync(resolve(root, 'apps/resource-core/.env'), 'utf8'));
assert.ok(
  config.DATABASE_URL && new URL(config.DATABASE_URL).hostname === '127.0.0.1',
  'Local database only',
);
const db = new Client({ connectionString: config.DATABASE_URL });
const prefix = `it-m1-${randomUUID().slice(0, 12)}`;
const password = randomBytes(24).toString('base64url');
const serviceToken = randomBytes(32).toString('base64url');
const address = `127.78.${randomBytes(1)[0]}.1`;
const day = new Date(Date.now() + 2 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const at = (hour) => `${day}T${String(hour).padStart(2, '0')}:00:00+08:00`;
const mainRoom = `${prefix}-room-a`,
  seatA = `${mainRoom}-seat-0`,
  seatB = `${mainRoom}-seat-1`;
let child, port, resource;
const tokens = {};
let passed = 0;
const bucketKeys = new Set([hashToken(`login:ip:${address}`)]);
function call(path, { method = 'GET', body, token, key } = {}) {
  return new Promise((done, reject) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers, localAddress: address },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          try {
            done({ status: res.statusCode, body: data ? JSON.parse(data) : undefined });
          } catch {
            reject(new Error('Invalid JSON response'));
          }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function start() {
  const reserve = createServer();
  await new Promise((done) => reserve.listen(0, '127.0.0.1', done));
  port = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  child = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(root, 'apps/resource-core'),
    env: {
      ...process.env,
      DATABASE_URL: config.DATABASE_URL,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'silent',
      API_DOCS_ENABLED: 'false',
      FRONTEND_ORIGINS: 'http://localhost:5173',
      M2_SERVICE_TOKEN: serviceToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => {
    output = (output + String(c)).slice(-3000);
  });
  child.stderr.on('data', (c) => {
    output = (output + String(c)).slice(-3000);
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw new Error(`Owned core exited: ${output.replaceAll(config.DATABASE_URL, '[REDACTED]')}`);
    try {
      if ((await call('/health/ready')).status === 200) break;
    } catch {
      /* temporary process is still starting */
    }
    if (i === 99) throw new Error('Owned core not ready');
    await delay(100);
  }
  resource = new ResourceCoreClient({
    baseUrl: `http://127.0.0.1:${port}`,
    serviceToken: () => serviceToken,
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const p = child;
  p.kill('SIGTERM');
  const timer = setTimeout(() => p.kill('SIGKILL'), 5000);
  await new Promise((done) => p.once('close', done));
  clearTimeout(timer);
  child = undefined;
}
const bookingBody = (seatId = seatA, start = 9, end = 10) => ({
  seatId,
  startsAt: at(start),
  endsAt: at(end),
});
const book = (body = bookingBody(), key = randomUUID(), token = tokens.a) =>
  call('/api/v1/bookings', { method: 'POST', body, key, token });
const cancel = (id, token = tokens.a, key = randomUUID()) =>
  call(`/api/v1/bookings/${id}/cancel`, {
    method: 'POST',
    body: { reason: 'Owned integration test cancellation' },
    key,
    token,
  });
const command = (revision = 1) => ({
  operationId: randomUUID(),
  revision,
  actorId: `${prefix}-approver`,
  reason: 'Owned integration test resource command',
});
const occupy = (source, input = command(), start = 11, end = 12) =>
  resource.occupy(source, { ...input, roomId: mainRoom, startsAt: at(start), endsAt: at(end) });
const search = (start = 9, end = 10, extra = '') =>
  call(
    `/api/v1/availability/seats?${new URLSearchParams({ startsAt: at(start), endsAt: at(end), roomId: mainRoom })}${extra}`,
    { token: tokens.a },
  );
function pass(message) {
  passed++;
  console.log(`PASS ${passed}: ${message}`);
}
async function setup() {
  const digest = await hashPassword(password);
  await db.query('BEGIN');
  try {
    for (const dep of ['a', 'b'])
      await db.query('INSERT INTO d_departments (id,name) VALUES ($1,$1)', [
        `${prefix}-dep-${dep}`,
      ]);
    for (const permission of ['m1.bookings.create', 'm2.approvals.decide'])
      await db.query(
        'INSERT INTO d_permissions (id,description) VALUES ($1,$1) ON CONFLICT DO NOTHING',
        [permission],
      );
    for (const [kind, scope, permission] of [
      ['booker', 'SELF', 'm1.bookings.create'],
      ['approver', 'DEPARTMENT', 'm2.approvals.decide'],
    ]) {
      await db.query('INSERT INTO d_roles (id,name,scope) VALUES ($1,$1,$2)', [
        `${prefix}-role-${kind}`,
        scope,
      ]);
      await db.query('INSERT INTO d_role_permissions ("roleId","permissionId") VALUES ($1,$2)', [
        `${prefix}-role-${kind}`,
        permission,
      ]);
    }
    for (const kind of ['a', 'other', 'foreign', 'approver', 'none']) {
      await db.query(
        'INSERT INTO d_users (id,username,"displayName","passwordHash","departmentId") VALUES ($1,$1,$1,$2,$3)',
        [`${prefix}-${kind}`, digest, `${prefix}-dep-${kind === 'foreign' ? 'b' : 'a'}`],
      );
      if (kind !== 'none')
        await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
          `${prefix}-${kind}`,
          `${prefix}-role-${kind === 'approver' ? 'approver' : 'booker'}`,
        ]);
    }
    for (const room of ['a', 'b', 'disabled', 'no-rules']) {
      const id = `${prefix}-room-${room}`;
      await db.query(
        'INSERT INTO d_rooms (id,code,name,"departmentId","restrictedToDepartment",enabled) VALUES ($1,$1,$1,$2,true,$3)',
        [id, `${prefix}-dep-${room === 'b' ? 'b' : 'a'}`, room !== 'disabled'],
      );
      for (let i = 0; i < 2; i++)
        await db.query('INSERT INTO d_seats (id,"roomId",code,"powerType") VALUES ($1,$2,$3,$4)', [
          `${id}-seat-${i}`,
          id,
          `S${i}`,
          i === 0 ? 'FIXED' : 'RAIL',
        ]);
      if (room !== 'no-rules')
        for (let weekday = 0; weekday < 7; weekday++)
          await db.query(
            'INSERT INTO d_opening_rules ("roomId",weekday,"opensHour","closesHour") VALUES ($1,$2,8,22)',
            [id, weekday],
          );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
async function cleanup() {
  await db.query('BEGIN');
  try {
    for (const [table, column] of [
      ['m1_commands', 'sourceId'],
      ['m1_resource_effects', 'sourceId'],
      ['m1_write_receipts', 'id'],
      ['m1_bookings', 'userId'],
      ['d_audit_events', 'actorId'],
      ['d_users', 'id'],
      ['d_roles', 'id'],
      ['d_opening_rules', 'roomId'],
      ['d_seats', 'roomId'],
      ['d_rooms', 'id'],
      ['d_departments', 'id'],
    ])
      await db.query(`DELETE FROM ${table} WHERE "${column}" LIKE $1`, [`${prefix}-%`]);
    await db.query('DELETE FROM d_login_buckets WHERE key=ANY($1::text[])', [[...bucketKeys]]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function sharedRoomLockProbe() {
  await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`room:${mainRoom}`]);
  let pending,
    settled = false,
    result;
  try {
    pending = book(bookingBody(seatA, 12, 13)).then((x) => {
      settled = true;
      result = x;
      return x;
    });
    await delay(350);
    assert.equal(settled, false, 'Reservation must wait for the exact shared room lock');
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`room:${mainRoom}`]);
    if (pending) await pending;
  }
  assert.equal(result.status, 201);
  await cancel(result.body.id);
}

await db.connect();
try {
  await setup();
  await start();
  for (const kind of ['a', 'other', 'foreign', 'approver', 'none']) {
    const username = `${prefix}-${kind}`;
    bucketKeys.add(hashToken(`login:account:${username}`));
    const result = await call('/api/v1/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    assert.equal(result.status, 200, 'Fixture login must succeed');
    tokens[kind] = result.body.accessToken;
  }
  if (process.argv.includes('--lock-only')) {
    await sharedRoomLockProbe();
    pass('shared room lock probe');
  } else {
    const context = await resource.getUserContext(`Bearer ${tokens.a}`);
    assert.equal(context.user.id, `${prefix}-a`);
    assert.deepEqual(context.roleIds, [`${prefix}-role-booker`]);
    assert.deepEqual(context.grants, [{ permission: 'm1.bookings.create', scope: 'SELF' }]);
    await assert.rejects(
      () => resource.getUserContext(`Bearer ${'x'.repeat(43)}`),
      (e) => e instanceof ResourceApiError && e.status === 401,
    );
    assert.equal(
      (await call('/internal/v1/identity/context', { token: serviceToken })).status,
      401,
    );
    assert.equal((await call('/api/v1/bookings')).status, 401);
    assert.equal((await book(bookingBody(), randomUUID(), tokens.none)).status, 403);
    assert.equal(
      (await call('/api/v1/bookings', { method: 'POST', body: bookingBody(), token: tokens.a }))
        .status,
      400,
    );
    assert.equal((await book({ ...bookingBody(), extra: true })).status, 400);
    assert.equal((await book({ ...bookingBody(), startsAt: `${day}T09:30:00+08:00` })).status, 400);
    assert.equal((await book({ ...bookingBody(), startsAt: `${day}T09:00:00` })).status, 400);
    assert.equal((await book(bookingBody(seatA, 9, 14))).status, 400);
    assert.equal((await book(bookingBody(seatA, 7, 8))).status, 409);
    assert.equal((await book(bookingBody(`${prefix}-room-disabled-seat-0`))).status, 409);
    assert.equal((await book(bookingBody(`${prefix}-room-no-rules-seat-0`))).status, 409);
    assert.equal((await book(bookingBody(), randomUUID(), tokens.foreign)).status, 403);
    assert.equal((await call('/api/v1/bookings/not-a-uuid', { token: tokens.a })).status, 400);
    assert.equal(
      (await call('/api/v1/bookings?cursor=not-a-uuid', { token: tokens.a })).status,
      400,
    );
    const parallelSearches = await Promise.all(Array.from({ length: 5 }, () => search()));
    assert.ok(
      parallelSearches.every((result) => result.status === 200),
      'Concurrent searches must not exhaust the connection pool',
    );
    const filtered = await search(9, 10, '&powerType=FIXED');
    assert.equal(filtered.status, 200);
    assert.deepEqual(
      filtered.body.items.map((x) => x.seat.id),
      [seatA],
    );
    pass('input/time/opening/department/enabled/permission checks and socket filtering');

    const sharedKey = randomUUID();
    const duplicate = await Promise.all([
      book(bookingBody(), sharedKey),
      book(bookingBody(), sharedKey),
    ]);
    assert.ok(duplicate.every((x) => x.status === 201));
    assert.equal(duplicate[0].body.id, duplicate[1].body.id);
    const first = duplicate[0].body;
    assert.equal((await book(bookingBody(seatB), sharedKey)).status, 409);
    assert.equal((await call(`/api/v1/bookings/${first.id}`, { token: tokens.other })).status, 404);
    assert.equal((await cancel(first.id, tokens.other)).status, 404);
    assert.equal((await call('/api/v1/bookings', { token: tokens.other })).body.items.length, 0);
    assert.equal((await cancel(first.id)).status, 200);
    assert.equal(
      (await book(bookingBody(), sharedKey)).body.status,
      'BOOKED',
      'Creation replay is the historical receipt',
    );
    assert.equal(
      (await call(`/api/v1/bookings/${first.id}`, { token: tokens.a })).body.status,
      'CANCELLED',
    );
    pass(
      'concurrent identical request is idempotent, payload mismatch rejected and owner-only reads/cancellation',
    );

    const contenders = await Promise.all(Array.from({ length: 6 }, () => book()));
    assert.equal(contenders.filter((x) => x.status === 201).length, 1);
    assert.equal(contenders.filter((x) => x.status === 409).length, 5);
    const winner = contenders.find((x) => x.status === 201).body;
    const next = await book(bookingBody(seatA, 10, 11));
    assert.equal(next.status, 201);
    let exclusion;
    try {
      await db.query(
        'INSERT INTO m1_bookings (id,"roomId","seatId","userId","startsAt","endsAt",status) VALUES ($1,$2,$3,$4,$5,$6,\'BOOKED\')',
        [randomUUID(), mainRoom, seatA, `${prefix}-a`, at(9), at(10)],
      );
    } catch (error) {
      exclusion = error.code;
    }
    assert.equal(
      exclusion,
      '23P01',
      'Database exclusion constraint must reject a bypassed overlap',
    );
    await cancel(winner.id);
    await cancel(next.body.id);
    pass(
      'six-way seat contention, adjacent intervals and independent PostgreSQL exclusion constraint',
    );

    await sharedRoomLockProbe();
    pass('actual HTTP reservation waits for the shared transaction room lock');

    assert.equal(
      (await call(`/internal/v1/room-occupancies/${prefix}-no-auth`, { token: tokens.a })).status,
      401,
    );
    await assert.rejects(
      () => occupy(`${prefix}-bad-actor`, { ...command(), actorId: `${prefix}-none` }),
      (e) => e instanceof ResourceApiError && e.status === 403,
    );
    const source = `${prefix}-source`;
    const establish = command();
    const receipt = await occupy(source, establish, 14, 15);
    assert.equal(receipt.state, 'ACTIVE');
    assert.deepEqual(await resource.getOccupancy(source), receipt);
    assert.deepEqual(await occupy(source, establish, 14, 15), receipt);
    await assert.rejects(
      () => occupy(source, { ...establish, reason: 'changed' }, 14, 15),
      (e) => e instanceof ResourceApiError && e.status === 409,
    );
    assert.equal((await search(14, 15)).body.items.length, 0);
    const release = command(2);
    assert.equal((await resource.releaseOccupancy(source, release)).state, 'RELEASED');
    assert.equal(
      (await occupy(source, establish, 14, 15)).state,
      'ACTIVE',
      'Replay returns the old receipt without reactivation',
    );
    assert.equal(
      (await call(`/internal/v1/room-occupancies/${source}`, { token: serviceToken })).body.state,
      'RELEASED',
    );
    await assert.rejects(
      () => occupy(source, command(1), 14, 15),
      (e) => e instanceof ResourceApiError && e.status === 409,
    );
    await assert.rejects(
      () => occupy(source, command(3), 14, 15),
      (e) => e instanceof ResourceApiError && e.status === 409,
    );
    assert.equal((await search(14, 15)).body.items.length, 2);
    const early = `${prefix}-release-first`;
    await resource.releaseOccupancy(early, command(3));
    await assert.rejects(
      () => occupy(early, command(1)),
      (e) => e instanceof ResourceApiError && e.status === 409,
    );
    pass(
      'real HTTP service identity, actor permission, receipts, stale revisions and release-first tombstones',
    );

    for (let i = 0; i < 5; i++) {
      const id = `${prefix}-race-${i}`;
      const active = await Promise.all([
        book(bookingBody(seatA, 11, 12)),
        occupy(id, command()).catch((error) => ({ failure: error })),
      ]);
      const bookingWon = active[0].status === 201;
      const occupancyWon = active[1].state === 'ACTIVE';
      assert.equal(
        Number(bookingWon) + Number(occupancyWon),
        1,
        'Personal and whole-room allocation cannot both succeed',
      );
      if (bookingWon) {
        assert.ok(
          active[1].failure instanceof ResourceApiError && active[1].failure.status === 409,
        );
        await cancel(active[0].body.id);
      } else {
        assert.equal(active[0].status, 409);
        await resource.releaseOccupancy(id, command(2));
      }
    }
    pass('five real concurrent personal-versus-whole-room allocation races have one winner');

    const blocking = await book(bookingBody(seatA, 16, 17));
    assert.equal(blocking.status, 201);
    const failedSource = `${prefix}-immutable-conflict`;
    const failedCommand = command();
    await assert.rejects(
      () => occupy(failedSource, failedCommand, 16, 17),
      (e) => e instanceof ResourceApiError && e.status === 409,
    );
    await cancel(blocking.body.id);
    await assert.rejects(
      () => occupy(failedSource, failedCommand, 16, 17),
      (e) => e instanceof ResourceApiError && e.status === 409,
      'A durable failure must not turn into a success',
    );
    const layered = `${prefix}-layered`;
    await occupy(layered, command(), 16, 17);
    await db.query(
      'INSERT INTO m1_resource_effects ("sourceModule","sourceId","roomId","startsAt",state,revision,"operationId","actorId",reason) VALUES (\'M3\',$1,$2,$3,\'ACTIVE\',1,$4,$5,\'Fixture maintenance source\')',
      [`${prefix}-maintenance`, mainRoom, at(16), randomUUID(), `${prefix}-approver`],
    );
    await resource.releaseOccupancy(layered, command(2));
    assert.equal((await search(16, 17)).body.items.length, 0);
    assert.equal(
      (
        await db.query(
          'SELECT state FROM m1_resource_effects WHERE "sourceModule"=\'M3\' AND "sourceId"=$1',
          [`${prefix}-maintenance`],
        )
      ).rows[0].state,
      'ACTIVE',
    );
    await stop();
    await start();
    assert.equal(
      (await call(`/internal/v1/room-occupancies/${source}`, { token: serviceToken })).body.state,
      'RELEASED',
    );
    await assert.rejects(
      () => occupy(failedSource, failedCommand, 16, 17),
      (e) => e instanceof ResourceApiError && e.status === 409,
    );
    assert.equal((await resource.getOccupancy(source)).state, 'RELEASED');
    pass(
      'persisted conflicts survive restart and releasing M2 preserves another maintenance source',
    );
  }
} finally {
  await stop();
  try {
    await cleanup();
  } finally {
    await db.end();
  }
}
console.log(
  `${passed} scheduling groups passed; owned fixtures/processes removed. M3 fixture is not an implemented M3 workflow.`,
);
