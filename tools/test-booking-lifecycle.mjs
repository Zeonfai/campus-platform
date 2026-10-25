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

// Every database write, including default-policy updates, is isolated in this run's
// freshly created database. No application database, demo account or env is changed.
const root = fileURLToPath(new URL('../', import.meta.url));
const requireBackend = createRequire(
  new URL('../apps/resource-core/package.json', import.meta.url),
);
const { Client } = requireBackend('pg');
const { parse } = requireBackend('dotenv');
const config = parse(readFileSync(resolve(root, 'apps/resource-core/.env'), 'utf8'));
const local = parse(readFileSync(resolve(root, 'infra/local/.env'), 'utf8'));
assert.ok(
  config.DATABASE_URL && local.POSTGRES_ADMIN_PASSWORD,
  'Existing local configuration required',
);
const sourceUrl = new URL(config.DATABASE_URL);
assert.equal(sourceUrl.hostname, '127.0.0.1', 'Only the local PostgreSQL instance is allowed');
const databaseName = 'it_lifecycle_' + randomBytes(8).toString('hex');
assert.match(databaseName, /^it_lifecycle_[a-f0-9]{16}$/);
const applicationRole = decodeURIComponent(sourceUrl.username);
assert.match(applicationRole, /^[A-Za-z_][A-Za-z0-9_]*$/);
const testUrl = new URL(sourceUrl);
testUrl.pathname = '/' + databaseName;
const adminUrl = new URL(sourceUrl);
adminUrl.username = 'campus_local_admin';
adminUrl.password = local.POSTGRES_ADMIN_PASSWORD;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 3000 });
const db = new Client({ connectionString: testUrl.href, connectionTimeoutMillis: 3000 });
const prefix = 'it-life-' + randomBytes(6).toString('hex');
const userId = (kind) => prefix + '-' + kind;
const roomId = (kind) => prefix + '-room-' + kind;
const password = randomBytes(24).toString('base64url');
const address = '127.79.' + randomBytes(1)[0] + '.1';
const processes = new Set();
const tokens = {};
const ownedBookings = [];
let server,
  createdDatabase = false,
  dbConnected = false,
  adminConnected = false,
  passed = 0;
const futureDay = new Date(Date.now() + 2 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const pastDay = new Date(Date.now() - 2 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const at = (hour, day = futureDay) => day + 'T' + String(hour).padStart(2, '0') + ':00:00+08:00';
const range = (start = 9, end = 10, day = futureDay) => ({
  startsAt: at(start, day),
  endsAt: at(end, day),
});
const codePath = (room) => '/api/v1/rooms/' + room + '/check-in-code';
const bookingPath = (id) => '/api/v1/bookings/' + id;
function call(path, { method = 'GET', body, token = tokens.a, key, target = server } = {}) {
  assert.ok(target, 'Owned HTTP server must be running');
  return new Promise((done, reject) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    if (key) headers['idempotency-key'] = key;
    const req = httpRequest(
      { hostname: '127.0.0.1', port: target.port, path, method, headers, localAddress: address },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            done({
              status: res.statusCode,
              body: data ? JSON.parse(data) : undefined,
              headers: res.headers,
            });
          } catch {
            reject(new Error('Invalid JSON response'));
          }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error('Owned HTTP request timed out')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const checkIn = (id, code, token = tokens.a, key = randomUUID()) =>
  call(bookingPath(id) + '/check-in', { method: 'POST', body: { code }, token, key });
const repeat = (id, body, token = tokens.a, key = randomUUID()) =>
  call(bookingPath(id) + '/repeat', { method: 'POST', body, token, key });
const markRead = (id, token = tokens.a, key = randomUUID()) =>
  call('/api/v1/notifications/' + id + '/read', { method: 'POST', token, key });
const wrongCode = (code) => (code[0] === '0' ? '1' : '0') + code.slice(1);
const countEvent = async (id, suffix) =>
  (
    await db.query('SELECT count(*)::int AS count FROM d_notifications WHERE "eventKey"=$1', [
      'm1:' + id + ':' + suffix,
    ])
  ).rows[0].count;
function pass(message) {
  console.log('PASS ' + ++passed + ': ' + message);
}
async function until(probe, label, milliseconds = 14000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(100);
  }
  assert.fail(label);
}
async function start() {
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const child = spawn(process.execPath, ['dist/main.js'], {
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
  const owned = { child, port };
  processes.add(owned);
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-2000);
    });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) {
      // Avoid exposing configuration or server request payloads in a failed test.
      void output;
      throw new Error('Owned core exited before becoming ready');
    }
    try {
      if ((await call('/health/ready', { token: null, target: owned })).status === 200)
        return owned;
    } catch {
      /* Await this owned process only. */
    }
    await delay(100);
  }
  throw new Error('Owned core did not become ready');
}
async function stop(owned = server) {
  if (!owned || !processes.has(owned)) return;
  processes.delete(owned);
  if (owned.child.exitCode !== null) return;
  const closed = new Promise((done) => owned.child.once('close', done));
  owned.child.kill('SIGTERM');
  const timer = setTimeout(() => owned.child.kill('SIGKILL'), 5000);
  await closed;
  clearTimeout(timer);
}
async function fixture({
  room = 'a',
  user = 'a',
  startMinutes = 1,
  durationMinutes = 60,
  status = 'BOOKED',
  due = false,
  startsAt,
  endsAt,
  seat,
  checkInBeforeMinutes = 15,
  noShowAfterMinutes = 15,
} = {}) {
  const id = randomUUID();
  const index = ownedBookings.length;
  const chosenSeat = seat ?? roomId(room) + '-fixture-seat-' + index;
  if (!seat)
    await db.query(
      'INSERT INTO d_seats (id,"roomId",code,"powerType") VALUES ($1,$2,$1,\'NONE\')',
      [chosenSeat, roomId(room)],
    );
  const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  const start = startsAt ? new Date(startsAt) : new Date(+now + startMinutes * 60000);
  const end = endsAt ? new Date(endsAt) : new Date(+start + durationMinutes * 60000);
  await db.query(
    'INSERT INTO m1_bookings (id,"roomId","seatId","userId","startsAt","endsAt",status,"checkInBeforeMinutes","noShowAfterMinutes","reminderBeforeAt","reminderAfterAt","nextActionAt","checkedInAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$5::timestamptz - interval \'15 minutes\',$5::timestamptz + interval \'10 minutes\',$10,$11)',
    [
      id,
      roomId(room),
      chosenSeat,
      userId(user),
      start,
      end,
      status,
      checkInBeforeMinutes,
      noShowAfterMinutes,
      due ? new Date(+now - 1000) : null,
      ['CHECKED_IN', 'COMPLETED'].includes(status) ? start : null,
    ],
  );
  ownedBookings.push(id);
  return { id, roomId: roomId(room), seatId: chosenSeat, start, end };
}
async function row(id) {
  return (await db.query('SELECT * FROM m1_bookings WHERE id=$1', [id])).rows[0];
}
async function forceDue(id) {
  await db.query(
    'UPDATE m1_bookings SET "nextActionAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
    [id],
  );
}
async function setup() {
  await admin.connect();
  adminConnected = true;
  await admin.query('CREATE DATABASE "' + databaseName + '" OWNER "' + applicationRole + '"');
  createdDatabase = true;
  await db.connect();
  dbConnected = true;
  const directory = resolve(root, 'apps/resource-core/prisma/migrations');
  for (const migration of readdirSync(directory)
    .filter((name) => /^\d{14}_/.test(name))
    .sort())
    await db.query(readFileSync(resolve(directory, migration, 'migration.sql'), 'utf8'));
  await db.query(
    "INSERT INTO d_service_metadata (key,value) VALUES ('service-name','resource-core')",
  );
  await db.query('INSERT INTO d_booking_policy (id,"maxHours") VALUES (\'default\',4)');
  const digest = await hashPassword(password);
  const permissions = [
    'm1.bookings.create',
    'm1.checkin-code.display',
    'm1.resource-reasons.read',
    'm1.statistics.read',
    'd.settings.write',
    'd.rooms.read',
  ];
  for (const permission of permissions)
    await db.query('INSERT INTO d_permissions (id,description) VALUES ($1,$1)', [permission]);
  for (const dep of ['a', 'b'])
    await db.query('INSERT INTO d_departments (id,name) VALUES ($1,$1)', [prefix + '-dep-' + dep]);
  const definitions = [
    ['a', 'SELF', ['m1.bookings.create'], 'a'],
    ['other', 'SELF', ['m1.bookings.create'], 'a'],
    ['foreign', 'SELF', ['m1.bookings.create'], 'b'],
    ['department', 'DEPARTMENT', permissions.filter((p) => p !== 'm1.bookings.create'), 'a'],
    ['managed', 'MANAGED_ROOMS', permissions.filter((p) => p !== 'm1.bookings.create'), 'b'],
    ['admin', 'ALL', permissions, 'b'],
  ];
  for (const [kind, scope, grants, dep] of definitions) {
    const role = prefix + '-role-' + kind;
    await db.query('INSERT INTO d_roles (id,name,scope) VALUES ($1,$1,$2)', [role, scope]);
    for (const permission of grants)
      await db.query('INSERT INTO d_role_permissions ("roleId","permissionId") VALUES ($1,$2)', [
        role,
        permission,
      ]);
    await db.query(
      'INSERT INTO d_users (id,username,"displayName","passwordHash","departmentId") VALUES ($1,$1,$1,$2,$3)',
      [userId(kind), digest, prefix + '-dep-' + dep],
    );
    await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
      userId(kind),
      role,
    ]);
  }
  // An unrelated ALL permission must never widen the department manager's
  // check-in-code, source-detail or statistics scope.
  await db.query("INSERT INTO d_roles (id,name,scope) VALUES ($1,$1,'ALL')", [
    prefix + '-unrelated-all',
  ]);
  await db.query(
    'INSERT INTO d_role_permissions ("roleId","permissionId") VALUES ($1,\'d.rooms.read\')',
    [prefix + '-unrelated-all'],
  );
  await db.query('INSERT INTO d_user_roles ("userId","roleId") VALUES ($1,$2)', [
    userId('department'),
    prefix + '-unrelated-all',
  ]);
  for (const room of ['a', 'b', 'public', 'disabled', 'report']) {
    await db.query(
      'INSERT INTO d_rooms (id,code,name,"departmentId","restrictedToDepartment",enabled) VALUES ($1,$1,$1,$2,$3,$4)',
      [
        roomId(room),
        prefix + '-dep-' + (['b', 'public'].includes(room) ? 'b' : 'a'),
        room !== 'public',
        room !== 'disabled',
      ],
    );
    await db.query(
      'INSERT INTO d_seats (id,"roomId",code,"powerType") VALUES ($1,$2,\'NORMAL\',\'FIXED\')',
      [roomId(room) + '-normal', roomId(room)],
    );
    for (let weekday = 0; weekday < 7; weekday++)
      await db.query(
        'INSERT INTO d_opening_rules ("roomId",weekday,"opensHour","closesHour") VALUES ($1,$2,8,22)',
        [roomId(room), weekday],
      );
  }
  await db.query('INSERT INTO d_managed_rooms ("userId","roomId") VALUES ($1,$2)', [
    userId('managed'),
    roomId('a'),
  ]);
  server = await start();
  for (const [kind] of definitions) {
    const result = await call('/api/v1/auth/login', {
      method: 'POST',
      body: { username: userId(kind), password },
      token: null,
    });
    assert.equal(result.status, 200, 'Fixture login must succeed');
    tokens[kind] = result.body.accessToken;
  }
}

try {
  await setup();
  const codeA = await call(codePath(roomId('a')), { token: tokens.admin });
  const codeB = await call(codePath(roomId('b')), { token: tokens.admin });
  assert.equal(codeA.status, 200);
  assert.equal(codeB.status, 200);
  assert.match(codeA.body.code, /^[A-F0-9]{8}$/);
  assert.notEqual(codeA.body.code, codeB.body.code, 'Two rooms must not share the current code');
  assert.match(codeA.headers['cache-control'], /no-store/);
  assert.deepEqual((await call(codePath(roomId('a')), { token: tokens.admin })).body, codeA.body);
  assert.equal((await call(codePath(roomId('a')), { token: null })).status, 401);
  assert.equal((await call(codePath(roomId('a')))).status, 403);
  assert.equal((await call(codePath(roomId('a')), { token: tokens.department })).status, 200);
  assert.equal((await call(codePath(roomId('a')), { token: tokens.managed })).status, 200);
  assert.equal((await call(codePath(roomId('b')), { token: tokens.managed })).status, 403);
  assert.equal((await call(codePath(roomId('public')), { token: tokens.department })).status, 403);
  assert.equal((await call(codePath(roomId('disabled')), { token: tokens.admin })).status, 422);
  const today = (
    await db.query(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day",
    )
  ).rows[0].day;
  assert.equal(codeA.body.date, today);
  pass(
    'daily room-bound code, stable replay/no-store, identity and permission-specific management scope',
  );

  const early = await fixture({ startMinutes: 120 });
  const expired = await fixture({ startMinutes: -20 });
  const success = await fixture({ startMinutes: -5 });
  assert.equal((await checkIn(early.id, codeA.body.code)).status, 422);
  assert.equal((await checkIn(expired.id, codeA.body.code)).status, 422);
  assert.equal((await checkIn(success.id, codeA.body.code, tokens.other)).status, 404);
  assert.equal((await checkIn(success.id, codeB.body.code)).status, 400);
  let oldCode = wrongCode(codeA.body.code);
  if (oldCode === codeB.body.code) oldCode = (oldCode[0] === '2' ? '3' : '2') + oldCode.slice(1);
  await db.query('INSERT INTO m1_daily_codes ("roomId",date,code) VALUES ($1,$2,$3)', [
    roomId('a'),
    pastDay,
    oldCode,
  ]);
  assert.equal(
    (await checkIn(success.id, oldCode)).status,
    400,
    'Previous-date code cannot check in today',
  );
  assert.equal((await checkIn(success.id, codeA.body.code, tokens.a, 'invalid')).status, 400);
  const sameKey = randomUUID();
  const duplicate = await Promise.all([
    checkIn(success.id, codeA.body.code, tokens.a, sameKey),
    checkIn(success.id, codeA.body.code, tokens.a, sameKey),
  ]);
  assert.ok(duplicate.every((r) => r.status === 200));
  assert.deepEqual(duplicate[0].body, duplicate[1].body);
  assert.equal(duplicate[0].body.status, 'CHECKED_IN');
  assert.equal(
    (await checkIn(success.id, wrongCode(codeA.body.code), tokens.a, sameKey)).status,
    409,
  );
  assert.equal((await checkIn(success.id, codeA.body.code)).status, 422);
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int AS count FROM d_audit_events WHERE "targetId"=$1 AND action=\'m1.booking.checked-in\'',
        [success.id],
      )
    ).rows[0].count,
    1,
  );
  pass(
    'owner/time/code validation, previous-day rejection, concurrent idempotent check-in and immutable receipt',
  );

  const limited = await fixture({ startMinutes: -1 });
  for (let i = 0; i < 5; i++)
    assert.equal((await checkIn(limited.id, wrongCode(codeA.body.code))).status, 400);
  assert.equal((await checkIn(limited.id, codeA.body.code)).status, 429);
  assert.equal((await row(limited.id)).failedCodeAttempts, 5);
  await stop();
  server = await start();
  assert.equal(
    (await checkIn(limited.id, codeA.body.code)).status,
    429,
    'Rate limit survives process restart',
  );
  await db.query(
    'UPDATE m1_bookings SET "codeAttemptWindow"=clock_timestamp()-interval \'61 seconds\' WHERE id=$1',
    [limited.id],
  );
  assert.equal((await checkIn(limited.id, codeA.body.code)).status, 200);
  pass(
    'persistent five-attempt limit survives restart and a later rate window permits the valid code',
  );

  const before = await fixture({ startMinutes: 5, due: true });
  const late = await fixture({ startMinutes: -11, due: true });
  const missed = await fixture({ startMinutes: -20, due: true });
  const cancelled = await fixture({ status: 'CANCELLED', startMinutes: -20, due: true });
  await until(
    async () =>
      (await countEvent(before.id, 'before')) === 1 &&
      (await countEvent(late.id, 'late')) === 1 &&
      (await row(missed.id)).status === 'NO_SHOW',
    'Worker must deliver due reminders and cancel missed booking',
  );
  assert.ok((await row(missed.id)).violationAt);
  assert.equal(await countEvent(missed.id, 'expired'), 1);
  assert.equal(
    await countEvent(missed.id, 'before'),
    0,
    'Obsolete pre-start reminder must not be delivered',
  );
  assert.equal(
    await countEvent(missed.id, 'late'),
    0,
    'Obsolete late reminder must not be delivered',
  );
  assert.equal(await countEvent(cancelled.id, 'expired'), 0);
  await forceDue(before.id);
  await forceDue(late.id);
  await stop();
  server = await start();
  await until(
    async () =>
      +(await row(before.id)).nextActionAt > Date.now() &&
      +(await row(late.id)).nextActionAt > Date.now(),
    'Replayed work should advance its persisted next action',
  );
  assert.equal(await countEvent(before.id, 'before'), 1);
  assert.equal(await countEvent(late.id, 'late'), 1);
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int AS count FROM d_audit_events WHERE "targetId"=$1 AND action=\'m1.booking.no-show\'',
        [missed.id],
      )
    ).rows[0].count,
    1,
  );
  pass(
    'persistent reminders, restart deduplication, one no-show violation/notification and obsolete-stage suppression',
  );

  const disabled = await fixture({ room: 'disabled', startMinutes: -20, due: true });
  const repair = await fixture({ startMinutes: -20, due: true });
  await db.query(
    'INSERT INTO m1_resource_effects ("sourceModule","sourceId","roomId","startsAt",state,revision,"operationId","actorId",reason) VALUES (\'M3\',$1,$2,$3,\'ACTIVE\',1,$4,$5,\'Owned lifecycle maintenance\')',
    [
      prefix + '-repair',
      roomId('a'),
      new Date(+repair.start - 60000),
      randomUUID(),
      userId('admin'),
    ],
  );
  // Both the code endpoint and booking lookup remain real HTTP; this fixture only
  // supplies a persisted maintenance fact owned by this run.
  const legacy = await fixture({ room: 'report', startMinutes: -20 });
  await db.query(
    'UPDATE m1_bookings SET "enforceNoShow"=false,"nextActionAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
    [legacy.id],
  );
  const releaseBeforeWindow = await fixture({ room: 'public', startMinutes: -20 });
  const releaseInsideWindow = await fixture({ room: 'b', user: 'foreign', startMinutes: -20 });
  for (const [booking, sourceId, releasedAt] of [
    [
      releaseBeforeWindow,
      prefix + '-old-release',
      new Date(+releaseBeforeWindow.start - 16 * 60000),
    ],
    [releaseInsideWindow, prefix + '-window-release', new Date(+releaseInsideWindow.start - 60000)],
  ]) {
    await db.query(
      'INSERT INTO m1_resource_effects ("sourceModule","sourceId","roomId","startsAt",state,revision,"operationId","actorId",reason,"releasedAt") VALUES (\'M3\',$1,$2,$3,\'RELEASED\',2,$4,$5,\'Owned released maintenance boundary\',$6)',
      [
        sourceId,
        booking.roomId,
        new Date(+booking.start - 30 * 60000),
        randomUUID(),
        userId('admin'),
        releasedAt,
      ],
    );
    await forceDue(booking.id);
  }
  const maintained = await fixture({ startMinutes: -1 });
  assert.equal((await checkIn(maintained.id, codeA.body.code)).status, 409);
  await until(
    async () =>
      (await row(disabled.id)).status === 'CANCELLED' &&
      (await row(repair.id)).status === 'CANCELLED',
    'Unavailable resources must cancel without a violation',
  );
  assert.equal((await row(disabled.id)).violationAt, null);
  assert.equal((await row(repair.id)).violationAt, null);
  assert.equal(await countEvent(disabled.id, 'expired'), 1);
  assert.equal(await countEvent(repair.id, 'expired'), 1);
  await until(
    async () =>
      (await row(legacy.id)).status === 'CANCELLED' &&
      (await row(releaseBeforeWindow.id)).status === 'NO_SHOW' &&
      (await row(releaseInsideWindow.id)).status === 'CANCELLED',
    'Legacy snapshots and released-maintenance intervals must apply the correct exemption',
  );
  assert.equal((await row(legacy.id)).violationAt, null);
  assert.ok((await row(releaseBeforeWindow.id)).violationAt);
  assert.equal((await row(releaseInsideWindow.id)).violationAt, null);
  assert.equal(await countEvent(legacy.id, 'expired'), 1);
  assert.equal(await countEvent(releaseBeforeWindow.id, 'expired'), 1);
  assert.equal(await countEvent(releaseInsideWindow.id, 'expired'), 1);
  await db.query(
    'DELETE FROM m1_resource_effects WHERE "sourceModule"=\'M3\' AND "sourceId"=ANY($1::text[])',
    [[prefix + '-old-release', prefix + '-window-release']],
  );
  await db.query(
    'UPDATE m1_resource_effects SET state=\'RELEASED\',"updatedAt"=clock_timestamp() WHERE "sourceId"=$1',
    [prefix + '-repair'],
  );
  await db.query(
    'UPDATE m1_bookings SET "endsAt"=clock_timestamp()-interval \'1 second\',"nextActionAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1',
    [success.id],
  );
  await until(
    async () => (await row(success.id)).status === 'COMPLETED',
    'Checked-in booking must complete after its end',
  );
  assert.equal((await row(success.id)).violationAt, null);
  assert.ok((await row(success.id)).completedAt);
  pass(
    'legacy/maintenance/disabled exemptions and released-source boundaries preserve correct violation state',
  );

  const notices = await call('/api/v1/notifications?limit=1');
  assert.equal(notices.status, 200);
  assert.equal(notices.body.items.length, 1);
  assert.ok(notices.body.nextCursor);
  const all = [];
  let cursor;
  do {
    const response = await call(
      '/api/v1/notifications?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert.equal(response.status, 200);
    all.push(...response.body.items);
    cursor = response.body.nextCursor;
  } while (cursor);
  assert.equal(new Set(all.map((n) => n.id)).size, all.length);
  assert.ok(all.length >= 5);
  assert.equal((await call('/api/v1/notifications', { token: tokens.other })).body.items.length, 0);
  const readKey = randomUUID(),
    notification = all[0].id;
  assert.equal((await markRead(notification, tokens.other)).status, 404);
  assert.equal((await markRead(notification, tokens.a, readKey)).status, 204);
  assert.equal((await markRead(notification, tokens.a, readKey)).status, 204);
  assert.equal((await markRead(all[1].id, tokens.a, readKey)).status, 409);
  assert.equal((await call('/api/v1/notifications?cursor=invalid')).status, 400);
  assert.ok(
    (await call('/api/v1/notifications')).body.items.find((n) => n.id === notification)?.read,
  );
  pass(
    'owner-only inbox, deterministic pagination, mark-read replay and cross-notification key mismatch',
  );

  // Snapshot and successful settings writes use this test's default policy only.
  const initialPolicy = (await call('/api/v1/settings/booking-policy')).body;
  const original = await call('/api/v1/bookings', {
    method: 'POST',
    key: randomUUID(),
    body: { seatId: roomId('a') + '-normal', ...range(9, 10) },
  });
  assert.equal(original.status, 201);
  assert.equal(original.body.policyRevision, initialPolicy.revision);
  assert.equal(
    Date.parse(original.body.startsAt) - Date.parse(original.body.checkInOpensAt),
    initialPolicy.checkInBeforeMinutes * 60000,
  );
  const changed = {
    ...initialPolicy,
    maxHours: 3,
    checkInBeforeMinutes: 5,
    noShowAfterMinutes: 12,
  };
  const save = (body, token = tokens.admin, key = randomUUID()) =>
    call('/api/v1/settings/booking-policy', { method: 'PUT', body, token, key });
  assert.equal(
    (await save(changed, tokens.department)).status,
    403,
    'DEPARTMENT settings grant is not global settings authority',
  );
  assert.equal((await save({ ...changed, reminderAfterMinutes: 12 })).status, 400);
  const winnerKey = randomUUID(),
    competitorKey = randomUUID();
  const policyRace = await Promise.all([
    save(changed, tokens.admin, winnerKey),
    save(changed, tokens.admin, competitorKey),
  ]);
  assert.equal(policyRace.filter((r) => r.status === 200).length, 1);
  assert.equal(policyRace.filter((r) => r.status === 409).length, 1);
  const winningIndex = policyRace.findIndex((r) => r.status === 200);
  const replayKey = winningIndex === 0 ? winnerKey : competitorKey;
  assert.deepEqual(
    (await save(changed, tokens.admin, replayKey)).body,
    policyRace[winningIndex].body,
  );
  assert.equal((await save({ ...changed, maxHours: 2 }, tokens.admin, replayKey)).status, 409);
  assert.equal((await save(changed)).status, 409);
  const frozen = (await call(bookingPath(original.body.id))).body;
  assert.equal(frozen.policyRevision, initialPolicy.revision);
  assert.equal(frozen.checkInOpensAt, original.body.checkInOpensAt);
  const repeatBody = range(10, 11),
    repeatKey = randomUUID();
  assert.equal((await repeat(original.body.id, repeatBody, tokens.other)).status, 404);
  const next = await repeat(original.body.id, repeatBody, tokens.a, repeatKey);
  assert.equal(next.status, 200);
  assert.equal(next.body.seatId, original.body.seatId);
  assert.equal(next.body.status, 'BOOKED');
  assert.equal(next.body.policyRevision, initialPolicy.revision + 1);
  assert.equal(Date.parse(next.body.startsAt) - Date.parse(next.body.checkInOpensAt), 5 * 60000);
  assert.deepEqual(
    (await repeat(original.body.id, repeatBody, tokens.a, repeatKey)).body,
    next.body,
  );
  assert.equal(
    (await repeat(original.body.id, repeatBody)).status,
    409,
    'A new repeat command must recheck the now occupied interval',
  );
  assert.equal((await repeat(original.body.id, range(10, 12), tokens.a, repeatKey)).status, 409);
  pass(
    'isolated policy CAS/idempotency, immutable old snapshots and owner-only repeat with current conflict/rule validation',
  );

  // Stop normal scheduled processing while constructing the exact lock boundary.
  await stop();
  server = await start();
  const boundary = await fixture({ room: 'b', user: 'foreign', startMinutes: -15, due: false });
  await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', ['room:' + roomId('b')]);
  let pending,
    settled = false;
  try {
    await db.query(
      "UPDATE m1_bookings SET \"startsAt\"=clock_timestamp()-interval '15 minutes'+interval '300 milliseconds' WHERE id=$1",
      [boundary.id],
    );
    pending = checkIn(boundary.id, codeB.body.code, tokens.foreign).then((r) => {
      settled = true;
      return r;
    });
    await delay(650);
    assert.equal(settled, false, 'Check-in must wait for the same scheduling room lock');
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['room:' + roomId('b')]);
  }
  assert.equal(
    (await pending).status,
    422,
    'Deadline is checked using the database clock after acquiring the lock',
  );
  await forceDue(boundary.id);
  const checked = await fixture({ room: 'b', user: 'foreign', startMinutes: -1, due: true });
  const checkResult = await checkIn(checked.id, codeB.body.code, tokens.foreign);
  assert.equal(checkResult.status, 200);
  const second = await start();
  await until(
    async () => (await row(boundary.id)).status === 'NO_SHOW',
    'Expired boundary must reach no-show',
  );
  await stop(second);
  assert.equal((await row(checked.id)).status, 'CHECKED_IN');
  assert.equal((await row(checked.id)).violationAt, null);
  assert.equal(await countEvent(boundary.id, 'expired'), 1);
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int AS count FROM d_audit_events WHERE "targetId"=$1 AND action=\'m1.booking.no-show\'',
        [boundary.id],
      )
    ).rows[0].count,
    1,
  );
  pass(
    'shared room lock, exclusive closing boundary and concurrent workers never double-penalize a checked-in booking',
  );

  for (const [status, start, end] of [
    ['BOOKED', 9, 11],
    ['CHECKED_IN', 10, 13],
    ['COMPLETED', 10, 11],
    ['NO_SHOW', 11, 12],
    ['CANCELLED', 9, 12],
  ])
    await fixture({
      room: 'report',
      status,
      startsAt: at(start, pastDay),
      endsAt: at(end, pastDay),
    });
  const reportQuery = new URLSearchParams({ ...range(10, 12, pastDay), roomId: roomId('report') });
  const report = await call('/api/v1/statistics/bookings?' + reportQuery, {
    token: tokens.department,
  });
  assert.equal(report.status, 200);
  assert.equal(report.body.items.length, 1);
  const stats = report.body.items[0];
  assert.equal(stats.bookedHours, 4);
  assert.equal(stats.checkedInHours, 3);
  assert.equal(stats.bookingCount, 5);
  assert.equal(stats.noShowCount, 1);
  assert.equal(stats.cancelledCount, 1);
  const publicQuery = new URLSearchParams({ ...range(10, 12, pastDay), roomId: roomId('public') });
  const forbiddenStats = await call('/api/v1/statistics/bookings?' + publicQuery, {
    token: tokens.department,
  });
  assert.equal(forbiddenStats.status, 200);
  assert.equal(forbiddenStats.body.items.length, 0);
  const sourceQuery = new URLSearchParams({ ...range(10, 12, pastDay), limit: '1' });
  const invalidSourceCursor = new URLSearchParams(sourceQuery);
  invalidSourceCursor.set('cursor', 'M1:not-a-uuid');
  assert.equal(
    (
      await call('/api/v1/rooms/' + roomId('report') + '/resource-reasons?' + invalidSourceCursor, {
        token: tokens.department,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('/api/v1/rooms/' + roomId('public') + '/resource-reasons?' + sourceQuery, {
        token: tokens.department,
      })
    ).status,
    403,
  );
  assert.equal((await call('/api/v1/statistics/bookings?' + reportQuery)).status, 403);
  const seen = [];
  cursor = undefined;
  do {
    const q = new URLSearchParams(sourceQuery);
    if (cursor) q.set('cursor', cursor);
    const result = await call('/api/v1/rooms/' + roomId('report') + '/resource-reasons?' + q, {
      token: tokens.department,
    });
    assert.equal(result.status, 200);
    seen.push(...result.body.items);
    cursor = result.body.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen.map((r) => r.sourceModule + ':' + r.sourceId)).size, 5);
  assert.ok(seen.every((r) => r.sourceModule === 'M1' && !('userId' in r) && !('code' in r)));
  const roomPages = [];
  cursor = undefined;
  do {
    const q = new URLSearchParams({ ...range(10, 12, pastDay), limit: '1' });
    if (cursor) q.set('cursor', cursor);
    const result = await call('/api/v1/statistics/bookings?' + q, { token: tokens.admin });
    assert.equal(result.status, 200);
    roomPages.push(...result.body.items);
    cursor = result.body.nextCursor;
  } while (cursor);
  assert.equal(roomPages.length, 5);
  assert.equal(new Set(roomPages.map((r) => r.roomId)).size, 5);
  assert.equal(
    (
      await call(
        '/api/v1/statistics/bookings?startsAt=2026-01-01T00:00:00Z&endsAt=2026-03-01T00:00:00Z',
        { token: tokens.admin },
      )
    ).status,
    400,
  );
  pass(
    'clipped seat-hour statistics, explicit state counts, keyset paging and strict public-room management scope',
  );
} finally {
  for (const owned of [...processes]) await stop(owned);
  if (dbConnected) await db.end();
  try {
    if (createdDatabase) {
      assert.match(databaseName, /^it_lifecycle_[a-f0-9]{16}$/);
      await admin.query('DROP DATABASE "' + databaseName + '"');
      console.log(
        'Owned lifecycle database removed; existing databases and configuration preserved.',
      );
    }
  } finally {
    if (adminConnected) await admin.end();
  }
}
console.log(passed + ' booking lifecycle groups passed with real PostgreSQL and HTTP.');
