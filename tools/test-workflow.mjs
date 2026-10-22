import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { hashPassword } from '../apps/resource-core/dist/modules/d/password.js';
import { hashToken } from '../apps/resource-core/dist/modules/d/identity.service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireCore = createRequire(new URL('../apps/resource-core/package.json', import.meta.url));
const { Client } = requireCore('pg');
const { parse } = requireCore('dotenv');
const settings = Object.fromEntries(
  ['resource-core', 'workflow'].map((service) => [
    service,
    parse(readFileSync(resolve(root, `apps/${service}/.env`), 'utf8')),
  ]),
);
for (const config of Object.values(settings))
  assert.equal(new URL(config.DATABASE_URL).hostname, '127.0.0.1', 'Owned local integration only');
const coreDb = new Client({ connectionString: settings['resource-core'].DATABASE_URL });
const workflowDb = new Client({ connectionString: settings.workflow.DATABASE_URL });
const prefix = `it-m2-${randomUUID().slice(0, 12)}`;
const roomId = `${prefix}-room`,
  policyId = `${prefix}-policy`;
const password = randomBytes(24).toString('base64url'),
  serviceToken = randomBytes(32).toString('base64url');
const address = `127.79.${randomBytes(1)[0]}.1`;
const tokens = {},
  owned = new Set(),
  children = new Set();
const day = new Date(Date.now() + 3 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const at = (hour) => `${day}T${String(hour).padStart(2, '0')}:00:00+08:00`;
let corePort,
  workflowPort,
  proxyPort,
  proxy,
  workflowChild,
  gatewayMode = 'pass',
  groups = 0;
const seenCommands = [];
const pass = (label) => {
  groups++;
  console.log(`PASS ${groups}: ${label}`);
};
function call(port, path, { method = 'GET', body, token, key } = {}) {
  return new Promise((done, reject) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers, localAddress: address },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          try {
            done({ status: res.statusCode, body: text ? JSON.parse(text) : undefined });
          } catch {
            reject(new Error('Invalid test HTTP JSON'));
          }
        });
      },
    );
    req.setTimeout(12000, () => req.destroy(new Error('Owned HTTP request timed out')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function freePort() {
  const s = createServer();
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const p = s.address().port;
  await new Promise((done) => s.close(done));
  return p;
}
async function startService(service, port, worker = true) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(root, `apps/${service}`),
    env: {
      ...process.env,
      DATABASE_URL: settings[service].DATABASE_URL,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'silent',
      API_DOCS_ENABLED: 'false',
      FRONTEND_ORIGINS: 'http://localhost:5173',
      M2_SERVICE_TOKEN: serviceToken,
      RESOURCE_CORE_URL: `http://127.0.0.1:${proxyPort ?? corePort}`,
      M2_WORKER_ENABLED: String(worker),
      M2_WORKER_INTERVAL_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-2000);
    });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw new Error(
        `${service} failed to start: ${Object.values(settings).reduce((s, c) => s.replaceAll(c.DATABASE_URL, '[REDACTED]'), output)}`,
      );
    try {
      if ((await call(port, '/health/ready')).status === 200) return child;
    } catch {
      /* owned process starting */
    }
    await delay(100);
  }
  throw new Error(`Owned ${service} readiness timed out`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await new Promise((done) => child.once('close', done));
  clearTimeout(timer);
  children.delete(child);
}
async function startGateway() {
  proxy = createServer((req, res) => {
    const isCommand = req.url.startsWith('/internal/v1/room-occupancies/') && req.method !== 'GET';
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (isCommand)
        seenCommands.push({ ...JSON.parse(body.toString()), sourceId: req.url.split('/')[4] });
      if (isCommand && gatewayMode === 'block') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Owned test transport interruption' },
          }),
        );
        return;
      }
      const drop = isCommand && req.method === 'PUT' && gatewayMode === 'drop-next';
      if (drop) gatewayMode = 'pass';
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: corePort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (response) => {
          if (drop) {
            response.resume();
            response.once('end', () => res.destroy());
          } else {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          }
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(503);
        res.end('{}');
      });
      upstream.end(body);
    });
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  proxyPort = proxy.address().port;
}
async function setup() {
  const hash = await hashPassword(password);
  await coreDb.query('BEGIN');
  try {
    for (const dep of ['a', 'b'])
      await coreDb.query('INSERT INTO d_departments(id,name) VALUES($1,$1)', [
        `${prefix}-dep-${dep}`,
      ]);
    const specs = [
      ['app', 'SELF', ['m2.applications.create', 'm2.policies.read', 'm1.bookings.create']],
      ['dep', 'DEPARTMENT', ['m2.approvals.decide', 'm2.policies.read', 'm2.applications.create']],
      ['manager', 'MANAGED_ROOMS', ['m2.approvals.decide', 'm2.policies.read']],
      [
        'all',
        'ALL',
        ['m2.applications.create', 'm2.approvals.decide', 'm2.policies.read', 'm2.policies.write'],
      ],
    ];
    for (const [role, scope, permissions] of specs) {
      await coreDb.query('INSERT INTO d_roles(id,name,scope) VALUES($1,$1,$2)', [
        `${prefix}-role-${role}`,
        scope,
      ]);
      for (const permission of permissions) {
        await coreDb.query(
          'INSERT INTO d_permissions(id,description) VALUES($1,$1) ON CONFLICT DO NOTHING',
          [permission],
        );
        await coreDb.query(
          'INSERT INTO d_role_permissions("roleId","permissionId") VALUES($1,$2)',
          [`${prefix}-role-${role}`, permission],
        );
      }
    }
    await coreDb.query("INSERT INTO d_roles(id,name,scope) VALUES($1,$1,'ALL')", [
      `${prefix}-role-unrelated-approver`,
    ]);
    await coreDb.query('INSERT INTO d_role_permissions("roleId","permissionId") VALUES($1,$2)', [
      `${prefix}-role-unrelated-approver`,
      'm2.approvals.decide',
    ]);
    for (const [kind, role] of [
      ['a', 'app'],
      ['other', 'app'],
      ['foreign', 'app'],
      ['dep', 'dep'],
      ['manager', 'manager'],
      ['admin', 'all'],
    ]) {
      const userId = `${prefix}-${kind}`;
      await coreDb.query(
        'INSERT INTO d_users(id,username,"displayName","passwordHash","departmentId") VALUES($1,$1,$1,$2,$3)',
        [userId, hash, `${prefix}-dep-${kind === 'foreign' ? 'b' : 'a'}`],
      );
      await coreDb.query('INSERT INTO d_user_roles("userId","roleId") VALUES($1,$2)', [
        userId,
        `${prefix}-role-${role}`,
      ]);
    }
    await coreDb.query('INSERT INTO d_user_roles("userId","roleId") VALUES($1,$2)', [
      `${prefix}-foreign`,
      `${prefix}-role-unrelated-approver`,
    ]);
    // A dual-role approver proves the distinct-person rule independently of role checks.
    await coreDb.query('INSERT INTO d_user_roles("userId","roleId") VALUES($1,$2)', [
      `${prefix}-dep`,
      `${prefix}-role-manager`,
    ]);
    await coreDb.query(
      'INSERT INTO d_rooms(id,code,name,"departmentId","restrictedToDepartment") VALUES($1,$1,$1,$2,true)',
      [roomId, `${prefix}-dep-a`],
    );
    for (const user of ['dep', 'manager'])
      await coreDb.query('INSERT INTO d_managed_rooms("userId","roomId") VALUES($1,$2)', [
        `${prefix}-${user}`,
        roomId,
      ]);
    await coreDb.query(
      'INSERT INTO d_seats(id,"roomId",code,"powerType") VALUES($1,$2,\'S1\',\'FIXED\')',
      [`${roomId}-seat`, roomId],
    );
    for (let day = 0; day < 7; day++)
      await coreDb.query(
        'INSERT INTO d_opening_rules("roomId",weekday,"opensHour","closesHour") VALUES($1,$2,8,22)',
        [roomId, day],
      );
    await coreDb.query('COMMIT');
  } catch (error) {
    await coreDb.query('ROLLBACK');
    throw error;
  }
}
const input = (hour = 9) => ({
  roomId,
  startsAt: at(hour),
  endsAt: at(hour + 1),
  purpose: 'Owned integration application',
  policyId,
});
async function create(hour = 9, who = 'a', key = randomUUID()) {
  const result = await call(workflowPort, '/api/v1/applications', {
    method: 'POST',
    token: tokens[who],
    key,
    body: input(hour),
  });
  assert.equal(result.status, 201, `Application creation failed: ${JSON.stringify(result.body)}`);
  owned.add(result.body.id);
  return result.body;
}
async function get(id, who = 'a') {
  const r = await call(workflowPort, `/api/v1/applications/${id}`, { token: tokens[who] });
  assert.equal(r.status, 200);
  return r.body;
}
const decide = (app, position, who, decision = 'APPROVE', key = randomUUID()) =>
  call(
    workflowPort,
    `/api/v1/applications/${app.id}/steps/${app.steps[position - 1].id}/decision`,
    {
      method: 'POST',
      token: tokens[who],
      key,
      body: { decision, comment: 'Owned test decision', expectedRevision: app.revision },
    },
  );
const withdraw = (app) =>
  call(workflowPort, `/api/v1/applications/${app.id}/withdraw`, {
    method: 'POST',
    token: tokens.a,
    key: randomUUID(),
    body: { reason: 'Owned integration withdrawal', expectedRevision: app.revision },
  });
async function approve(app) {
  const decisionKey = randomUUID();
  const decisions = await Promise.all([
    decide(app, 1, 'dep', 'APPROVE', decisionKey),
    decide(app, 1, 'dep', 'APPROVE', decisionKey),
  ]);
  assert.deepEqual(
    decisions[0],
    decisions[1],
    'Concurrent decision replay must be a single durable result',
  );
  let r = decisions[0];
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await decide(r.body, 2, 'manager');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function waitState(id, status, who = 'a', milliseconds = 15000) {
  const end = Date.now() + milliseconds;
  let app;
  do {
    app = await get(id, who);
    if (app.status === status) return app;
    await delay(100);
  } while (Date.now() < end);
  assert.fail(`Expected ${status}, received ${app.status} (${app.syncError})`);
}
const availability = (hour) =>
  call(
    corePort,
    `/api/v1/availability/seats?${new URLSearchParams({ roomId, startsAt: at(hour), endsAt: at(hour + 1) })}`,
    { token: tokens.a },
  );
async function cleanup() {
  await workflowDb.query('DELETE FROM m2_audit_event WHERE "actorId" LIKE $1', [`${prefix}-%`]);
  await workflowDb.query('DELETE FROM m2_write_receipt WHERE id LIKE $1', [`${prefix}-%`]);
  await workflowDb.query('DELETE FROM m2_application WHERE "applicantId" LIKE $1', [`${prefix}-%`]);
  await workflowDb.query('DELETE FROM m2_policy WHERE id LIKE $1', [`${prefix}-%`]);
  for (const [table, column] of [
    ['m1_commands', 'sourceId'],
    ['m1_resource_effects', 'sourceId'],
  ])
    if (owned.size)
      await coreDb.query(`DELETE FROM ${table} WHERE "${column}"=ANY($1::text[])`, [[...owned]]);
  for (const [table, column] of [
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
    await coreDb.query(`DELETE FROM ${table} WHERE "${column}" LIKE $1`, [`${prefix}-%`]);
  const buckets = [
    hashToken(`login:ip:${address}`),
    ...Object.keys(tokens).map((kind) => hashToken(`login:account:${prefix}-${kind}`)),
  ];
  await coreDb.query('DELETE FROM d_login_buckets WHERE key=ANY($1::text[])', [buckets]);
}
await coreDb.connect();
await workflowDb.connect();
try {
  await setup();
  corePort = await freePort();
  await startService('resource-core', corePort);
  await startGateway();
  workflowPort = await freePort();
  workflowChild = await startService('workflow', workflowPort);
  for (const kind of ['a', 'other', 'foreign', 'dep', 'manager', 'admin']) {
    const r = await call(corePort, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: `${prefix}-${kind}`, password },
    });
    assert.equal(r.status, 200);
    tokens[kind] = r.body.accessToken;
  }
  const policy = {
    id: policyId,
    name: 'Owned test policy',
    timeoutMinutes: 2880,
    expectedRevision: 0,
    steps: [
      { roleId: `${prefix}-role-dep`, scope: 'DEPARTMENT' },
      { roleId: `${prefix}-role-manager`, scope: 'MANAGED_ROOMS' },
    ],
  };
  const putPolicy = (body) =>
    call(workflowPort, `/api/v1/approval-policies/${policyId}`, {
      method: 'PUT',
      token: tokens.admin,
      key: randomUUID(),
      body,
    });
  const policyKey = randomUUID();
  const policyRequest = (body, key) =>
    call(workflowPort, `/api/v1/approval-policies/${policyId}`, {
      method: 'PUT',
      token: tokens.admin,
      key,
      body,
    });
  assert.equal((await policyRequest(policy)).status, 400);
  const initialPolicy = await policyRequest(policy, policyKey);
  assert.equal(initialPolicy.status, 200);
  assert.deepEqual((await policyRequest(policy, policyKey)).body, initialPolicy.body);
  assert.equal((await policyRequest({ ...policy, name: 'Changed replay' }, policyKey)).status, 409);

  assert.equal((await call(workflowPort, '/api/v1/applications')).status, 401);
  assert.equal(
    (
      await call(workflowPort, '/api/v1/applications', {
        method: 'POST',
        token: tokens.a,
        key: randomUUID(),
        body: { ...input(), actorId: `${prefix}-admin` },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(workflowPort, '/api/v1/applications', {
        method: 'POST',
        token: tokens.foreign,
        key: randomUUID(),
        body: input(),
      })
    ).status,
    403,
  );
  const key = randomUUID();
  const twins = await Promise.all([create(9, 'a', key), create(9, 'a', key)]);
  assert.equal(twins[0].id, twins[1].id);
  assert.equal(
    (
      await call(workflowPort, '/api/v1/applications', {
        method: 'POST',
        token: tokens.a,
        key,
        body: { ...input(), purpose: 'changed' },
      })
    ).status,
    409,
  );
  let app = twins[0];
  assert.equal(
    (await availability(9)).body.items.length,
    1,
    'Pending approval must not pre-hold room',
  );
  assert.equal(
    (await call(workflowPort, `/api/v1/applications/${app.id}`, { token: tokens.other })).status,
    404,
  );
  assert.equal((await decide(app, 2, 'manager')).status >= 400, true);
  const decisionKey = randomUUID();
  const decisions = await Promise.all([
    decide(app, 1, 'dep', 'APPROVE', decisionKey),
    decide(app, 1, 'dep', 'APPROVE', decisionKey),
  ]);
  assert.deepEqual(
    decisions[0],
    decisions[1],
    'Concurrent decision replay must be a single durable result',
  );
  let r = decisions[0];
  assert.equal(r.status, 200);
  app = r.body;
  assert.equal(
    (await decide(app, 2, 'dep')).status,
    403,
    'A dual-role human cannot approve both steps',
  );
  r = await decide(app, 2, 'manager');
  assert.equal(r.status, 200);
  app = await waitState(app.id, 'APPROVED');
  assert.equal((await availability(9)).body.items.length, 0);
  r = await withdraw(app);
  assert.equal(r.status, 200);
  await waitState(app.id, 'WITHDRAWN');
  assert.equal((await availability(9)).body.items.length, 1);
  pass(
    'real identity, strict input, owner/department scope, idempotency and two distinct ordered approvers with HTTP occupy/release',
  );

  const own = await create(10, 'dep');
  assert.equal(
    (await decide(own, 1, 'dep')).status,
    403,
    'Qualified approver cannot approve own application',
  );
  const rejected = await create(10);
  r = await decide(rejected, 1, 'dep', 'REJECT');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'REJECTED');
  assert.equal(
    (await call(workflowPort, `/api/v1/applications/${rejected.id}`, { token: tokens.manager }))
      .status,
    404,
    'An unacted later approver must not see a rejected application',
  );
  assert.equal((await availability(10)).body.items.length, 1);
  const snapshot = await create(10);
  assert.equal(
    (await putPolicy({ ...policy, expectedRevision: 1, timeoutMinutes: 60 })).status,
    200,
  );
  assert.equal((await get(snapshot.id)).policyRevision, 1);
  assert.equal((await putPolicy({ ...policy, expectedRevision: 1 })).status, 409);
  pass(
    'self-approval blocked, rejection does not occupy, policy immutable snapshots and optimistic updates',
  );

  const booking = await call(corePort, '/api/v1/bookings', {
    method: 'POST',
    token: tokens.a,
    key: randomUUID(),
    body: { seatId: `${roomId}-seat`, startsAt: at(11), endsAt: at(12) },
  });
  assert.equal(booking.status, 201);
  const conflict = await approve(await create(11));
  const failed = await waitState(conflict.id, 'SYNC_FAILED');
  assert.equal(failed.syncError, 'RESOURCE_CONFLICT');
  assert.equal(
    (
      await call(corePort, `/api/v1/bookings/${booking.body.id}/cancel`, {
        method: 'POST',
        token: tokens.a,
        key: randomUUID(),
        body: { reason: 'Owned test cleanup' },
      })
    ).status,
    200,
  );
  await delay(300);
  assert.equal(
    (await get(conflict.id)).status,
    'SYNC_FAILED',
    'Known conflict must not silently retry as new intent',
  );
  pass('personal booking conflict cannot become approved or silently retry after capacity returns');

  gatewayMode = 'drop-next';
  const lost = await approve(await create(12));
  await waitState(lost.id, 'APPROVED', 'a', 20000);
  const lostCommands = seenCommands.filter((c) => c.sourceId === lost.id);
  const operations = (
    await workflowDb.query(
      'SELECT "operationId",attempts FROM m2_outbox WHERE "applicationId"=$1 AND kind=\'OCCUPY\'',
      [lost.id],
    )
  ).rows;
  assert.equal(operations.length, 1);
  assert.ok(operations[0].attempts >= 1);
  assert.ok(lostCommands.length > 0);
  assert.ok(
    lostCommands.every((c) => c.operationId === operations[0].operationId),
    'Retries preserve the durable operation ID',
  );
  app = await get(lost.id);
  assert.equal((await withdraw(app)).status, 200);
  await waitState(app.id, 'WITHDRAWN');
  pass('committed resource with lost HTTP response reconciles through durable command identity');

  gatewayMode = 'block';
  const pending = await approve(await create(13));
  await delay(500);
  assert.equal((await get(pending.id)).status, 'SYNCING');
  const before = (
    await workflowDb.query('SELECT "operationId" FROM m2_outbox WHERE "applicationId"=$1', [
      pending.id,
    ])
  ).rows[0].operationId;
  await stop(workflowChild);
  workflowChild = await startService('workflow', workflowPort);
  gatewayMode = 'pass';
  await waitState(pending.id, 'APPROVED', 'a', 20000);
  const after = (
    await workflowDb.query('SELECT "operationId" FROM m2_outbox WHERE "applicationId"=$1', [
      pending.id,
    ])
  ).rows[0].operationId;
  assert.equal(after, before);
  app = await get(pending.id);
  assert.equal((await withdraw(app)).status, 200);
  await waitState(app.id, 'WITHDRAWN');
  pass('persisted outbox resumes after a real service restart without changing operation identity');

  gatewayMode = 'block';
  const race = await approve(await create(14));
  app = await get(race.id);
  assert.equal((await withdraw(app)).status, 200);
  gatewayMode = 'pass';
  await waitState(app.id, 'WITHDRAWN', 'a', 20000);
  await delay(300);
  assert.equal((await get(app.id)).status, 'WITHDRAWN');
  assert.equal((await availability(14)).body.items.length, 1);
  pass('withdrawal supersedes outstanding occupancy and cannot be revived by an old intent');

  const longCommentApp = await create(18);
  r = await decide(longCommentApp, 1, 'dep');
  assert.equal(r.status, 200);
  const finalStep = r.body;
  r = await call(
    workflowPort,
    `/api/v1/applications/${finalStep.id}/steps/${finalStep.steps[1].id}/decision`,
    {
      method: 'POST',
      token: tokens.manager,
      key: randomUUID(),
      body: {
        decision: 'APPROVE',
        comment: '验'.repeat(1000),
        expectedRevision: finalStep.revision,
      },
    },
  );
  assert.equal(
    r.status,
    200,
    'A valid maximum-length approval comment must not overflow an outbox column',
  );
  app = await waitState(finalStep.id, 'APPROVED');
  gatewayMode = 'block';
  assert.equal((await withdraw(app)).status, 200);
  await delay(300);
  await workflowDb.query(
    'UPDATE m2_outbox SET attempts=25,"availableAt"=CURRENT_TIMESTAMP WHERE "applicationId"=$1 AND kind=\'RELEASE\' AND state=\'READY\'',
    [app.id],
  );
  await delay(300);
  assert.equal(
    (await get(app.id)).status,
    'RELEASE_PENDING',
    'Unknown release must remain recoverable after the normal retry budget',
  );
  gatewayMode = 'pass';
  await workflowDb.query(
    'UPDATE m2_outbox SET "availableAt"=CURRENT_TIMESTAMP WHERE "applicationId"=$1 AND kind=\'RELEASE\' AND state=\'READY\'',
    [app.id],
  );
  await waitState(app.id, 'WITHDRAWN');
  assert.equal((await availability(18)).body.items.length, 1);
  pass('maximum-length approval text and release recovery beyond the normal retry budget');

  const expires = await create(15);
  await workflowDb.query(
    'UPDATE m2_application SET "deadlineAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE id=$1',
    [expires.id],
  );
  await waitState(expires.id, 'EXPIRED');
  assert.equal((await availability(15)).body.items.length, 1);
  const expireSync = await create(16);
  gatewayMode = 'block';
  await approve(expireSync);
  await workflowDb.query(
    'UPDATE m2_application SET "deadlineAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE id=$1',
    [expireSync.id],
  );
  await waitState(expireSync.id, 'RELEASE_PENDING');
  gatewayMode = 'pass';
  await waitState(expireSync.id, 'EXPIRED', 'a', 20000);
  assert.equal((await availability(16)).body.items.length, 1);
  pass(
    'persisted deadline scan expires pending and syncing requests and confirms release before terminal expiry',
  );
} finally {
  for (const child of [...children]) await stop(child);
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((done) => proxy.close(done));
  }
  try {
    await cleanup();
  } finally {
    await coreDb.end();
    await workflowDb.end();
  }
}
console.log(
  `${groups} real workflow groups passed; only owned fixtures and processes were removed.`,
);
