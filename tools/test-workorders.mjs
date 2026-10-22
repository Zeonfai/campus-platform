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
const prefix = `it-m3-${randomUUID().slice(0, 12)}`;
const roomId = `${prefix}-room`,
  policyId = `${prefix}-policy`;
const password = randomBytes(24).toString('base64url'),
  serviceToken = randomBytes(32).toString('base64url'),
  m2Token = randomBytes(32).toString('base64url');
const address = `127.80.${randomBytes(1)[0]}.1`;
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
function call(port, path, { method = 'GET', body, token, key, extraHeaders = {} } = {}) {
  return new Promise((done, reject) => {
    const headers = { ...extraHeaders };
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
      M2_SERVICE_TOKEN: m2Token,
      M3_SERVICE_TOKEN: serviceToken,
      RESOURCE_CORE_URL: `http://127.0.0.1:${proxyPort ?? corePort}`,
      M2_WORKER_ENABLED: 'false',
      M3_WORKER_ENABLED: String(worker),
      M3_RELEASE_RETRY_DELAY_MS: '100',
      M3_WORKER_INTERVAL_MS: '100',
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
    const isCommand =
      req.url.startsWith('/internal/v1/maintenance-blocks/') && req.method !== 'GET';
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (isCommand)
        seenCommands.push({
          ...JSON.parse(body.toString()),
          method: req.method,
          sourceId: req.url.split('/')[4],
        });
      if (isCommand && gatewayMode === 'block') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Owned test transport interruption' },
          }),
        );
        return;
      }
      const drop =
        isCommand &&
        ((req.method === 'PUT' && gatewayMode === 'drop-next') ||
          (req.method === 'POST' && gatewayMode === 'drop-release'));
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
      [
        'report',
        'SELF',
        ['m3.work-orders.create', 'm3.rate', 'm3.cancel', 'm3.policies.read', 'm1.bookings.create'],
      ],
      ['repair', 'MANAGED_ROOMS', ['m3.repair']],
      [
        'manager',
        'MANAGED_ROOMS',
        [
          'm3.dispatch',
          'm3.accept',
          'm3.cancel',
            'm3.policies.read',
          'm2.approvals.decide',
        ],
      ],
      [
        'all',
        'ALL',
        [
          'm3.work-orders.create',
          'm3.dispatch',
          'm3.repair',
          'm3.accept',
          'm3.cancel',
          'm3.rate',
            'm3.policies.read',
          'm3.policies.write',
        ],
      ],
      ['department', 'DEPARTMENT', ['m3.repair', 'm3.dispatch', 'm3.accept']],
      ['none', 'ALL', ['d.departments.read']],
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
    for (const [kind, role] of [
      ['a', 'report'],
      ['other', 'report'],
      ['foreign', 'report'],
      ['repair', 'repair'],
      ['repair2', 'repair'],
      ['disabled', 'repair'],
      ['manager', 'manager'],
      ['admin', 'all'],
      ['outsider', 'none'],
      ['department', 'department'],
    ]) {
      await coreDb.query(
        'INSERT INTO d_users(id,username,"displayName","passwordHash","departmentId") VALUES($1,$1,$1,$2,$3)',
        [`${prefix}-${kind}`, hash, `${prefix}-dep-${kind === 'foreign' ? 'b' : 'a'}`],
      );
      await coreDb.query('INSERT INTO d_user_roles("userId","roleId") VALUES($1,$2)', [
        `${prefix}-${kind}`,
        `${prefix}-role-${role}`,
      ]);
    }
    // Unrelated ALL permission cannot widen the foreign reporter's SELF scope.
    await coreDb.query('INSERT INTO d_user_roles("userId","roleId") VALUES($1,$2)', [
      `${prefix}-foreign`,
      `${prefix}-role-none`,
    ]);
    // A dual-role repairer tests self-acceptance independently of missing roles.
    await coreDb.query('INSERT INTO d_user_roles("userId","roleId") VALUES($1,$2)', [
      `${prefix}-manager`,
      `${prefix}-role-repair`,
    ]);
    for (const [id, enabled] of [
      [roomId, true],
      [`${prefix}-disabled-room`, false],
    ])
      await coreDb.query(
        'INSERT INTO d_rooms(id,code,name,"departmentId","restrictedToDepartment",enabled) VALUES($1,$1,$1,$2,true,$3)',
        [id, `${prefix}-dep-a`, enabled],
      );
    await coreDb.query(
      'INSERT INTO d_rooms(id,code,name,"departmentId","restrictedToDepartment") VALUES($1,$1,$1,$2,false)',
      [`${prefix}-public-room`, `${prefix}-dep-b`],
    );
    await coreDb.query('INSERT INTO d_managed_rooms("userId","roomId") VALUES($1,$2)', [
      `${prefix}-manager`,
      `${prefix}-public-room`,
    ]);
    for (const who of ['repair', 'repair2', 'manager', 'disabled'])
      await coreDb.query('INSERT INTO d_managed_rooms("userId","roomId") VALUES($1,$2)', [
        `${prefix}-${who}`,
        roomId,
      ]);
    await coreDb.query(
      'INSERT INTO d_seats(id,"roomId",code,"powerType") VALUES($1,$2,\'S1\',\'FIXED\')',
      [`${roomId}-seat`, roomId],
    );
    for (let weekday = 0; weekday < 7; weekday++)
      await coreDb.query(
        'INSERT INTO d_opening_rules("roomId",weekday,"opensHour","closesHour") VALUES($1,$2,8,22)',
        [roomId, weekday],
      );
    await coreDb.query('COMMIT');
  } catch (error) {
    await coreDb.query('ROLLBACK');
    throw error;
  }
}
const input = () => ({
  roomId,
  category: '电气设备',
  description: 'Owned integration report',
  policyId,
});
async function create(who = 'a', key = randomUUID(), body = input()) {
  const r = await call(workflowPort, '/api/v1/work-orders', {
    method: 'POST',
    token: tokens[who],
    key,
    body,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  owned.add(r.body.id);
  return r.body;
}
async function get(id, who = 'a') {
  const r = await call(workflowPort, `/api/v1/work-orders/${id}`, { token: tokens[who] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const action = (order, name, who, extra = {}, key = randomUUID()) =>
  call(workflowPort, `/api/v1/work-orders/${order.id}/${name}`, {
    method: 'POST',
    token: tokens[who],
    key,
    body: {
      expectedRevision: order.revision,
      ...(name === 'accept'
        ? { accepted: true, comment: 'Owned acceptance' }
        : name === 'rating'
          ? { score: 5, comment: 'Owned rating' }
          : { reason: 'Owned work-order action' }),
      ...extra,
    },
  });
async function mustAction(order, name, who, extra = {}, key = randomUUID()) {
  const r = await action(order, name, who, extra, key);
  assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function waitState(id, status, milliseconds = 20000) {
  const end = Date.now() + milliseconds;
  let order;
  do {
    order = await get(id);
    if (order.status === status) return order;
    await delay(100);
  } while (Date.now() < end);
  assert.fail(`Expected ${status}, received ${order.status} (${order.syncError})`);
}
const currentBlock = (id) =>
  call(corePort, `/internal/v1/maintenance-blocks/${id}`, { token: serviceToken });
async function waitBlock(id, state) {
  const end = Date.now() + 15000;
  do {
    const r = await currentBlock(id);
    if (r.status === 200 && r.body.state === state) return r.body;
    await delay(50);
  } while (Date.now() < end);
  assert.fail(`Expected maintenance source ${state}`);
}
async function makeRepair(who = 'repair') {
  let order = await create();
  order = await mustAction(order, 'assign', 'manager', { assigneeId: `${prefix}-${who}` });
  await mustAction(order, 'start', who);
  return waitState(order.id, 'IN_REPAIR');
}
async function closeOrder(order, acceptor = 'manager', repairer = 'repair') {
  if (order.status === 'IN_REPAIR') order = await mustAction(order, 'complete', repairer);
  await mustAction(order, 'accept', acceptor);
  return waitState(order.id, 'CLOSED');
}
const availability = (hour = 11) =>
  call(
    corePort,
    `/api/v1/availability/seats?${new URLSearchParams({ roomId, startsAt: at(hour), endsAt: at(hour + 1) })}`,
    { token: tokens.a },
  );
const dueOutbox = (id) =>
  workflowDb.query(
    'UPDATE m3_outbox SET "availableAt"=CURRENT_TIMESTAMP WHERE "workOrderId"=$1 AND state=\'READY\'',
    [id],
  );
async function restart() {
  await stop(workflowChild);
  workflowChild = await startService('workflow', workflowPort);
}
async function cleanup() {
  await workflowDb.query('DELETE FROM m3_write_receipt WHERE id LIKE $1', [`${prefix}-%`]);
  await workflowDb.query('DELETE FROM m3_work_order WHERE "reporterId" LIKE $1', [`${prefix}-%`]);
  await workflowDb.query('DELETE FROM m3_audit_event WHERE "actorId" LIKE $1', [`${prefix}-%`]);
  await workflowDb.query('DELETE FROM m3_policy WHERE id LIKE $1', [`${prefix}-%`]);
  if (owned.size)
    for (const table of ['m1_commands', 'm1_resource_effects'])
      await coreDb.query(`DELETE FROM ${table} WHERE "sourceId"=ANY($1::text[])`, [[...owned]]);
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
  for (const kind of [
    'a',
    'other',
    'foreign',
    'repair',
    'repair2',
    'disabled',
    'manager',
    'admin',
    'outsider',
    'department',
  ]) {
    const r = await call(corePort, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: `${prefix}-${kind}`, password },
    });
    assert.equal(r.status, 200, 'Owned fixture login');
    tokens[kind] = r.body.accessToken;
  }

  const policy = {
    id: policyId,
    name: 'Owned maintenance policy',
    responseMinutes: 1440,
    repairMinutes: 2880,
    acceptanceMinutes: 1440,
    expectedRevision: 0,
  };
  const putPolicy = (body = policy, key = randomUUID(), who = 'admin') =>
    call(workflowPort, `/api/v1/maintenance-policies/${policyId}`, {
      method: 'PUT',
      token: tokens[who],
      key,
      body,
    });
  const policyKey = randomUUID();
  assert.equal((await putPolicy(policy, policyKey, 'a')).status, 403);
  let r = await putPolicy(policy, policyKey);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await putPolicy(policy, policyKey)).body, r.body);
  assert.equal((await putPolicy({ ...policy, name: 'Changed replay' }, policyKey)).status, 409);
  assert.equal((await call(workflowPort, '/api/v1/work-orders')).status, 401);
  assert.equal(
    (
      await call(workflowPort, '/api/v1/work-orders', {
        method: 'POST',
        token: tokens.a,
        body: input(),
      })
    ).status,
    400,
  );
  for (const [who, body, expected] of [
    ['outsider', input(), 403],
    ['foreign', input(), 403],
    ['a', { ...input(), actorId: `${prefix}-admin` }, 400],
    ['a', { ...input(), description: '  ' }, 400],
    ['a', { ...input(), roomId: `${prefix}-disabled-room` }, 404],
  ])
    assert.equal(
      (
        await call(workflowPort, '/api/v1/work-orders', {
          method: 'POST',
          token: tokens[who],
          key: randomUUID(),
          body,
        })
      ).status,
      expected,
    );
  assert.equal(
    (await call(workflowPort, '/api/v1/work-orders?limit=101', { token: tokens.a })).status,
    400,
  );
  assert.equal(
    (await call(workflowPort, '/api/v1/work-orders?cursor=invalid', { token: tokens.a })).status,
    400,
  );
  assert.equal(
    (await call(corePort, `/internal/v1/maintenance-blocks/${randomUUID()}`, { token: m2Token }))
      .status,
    401,
  );
  pass(
    'strict HTTP input, separate service identities, current user/department qualification and disabled resources',
  );

  const protocolId = `${prefix}-protocol`;
  owned.add(protocolId);
  const nonhour = new Date(Date.now() - 120000);
  nonhour.setUTCSeconds(17, 123);
  const original = {
    operationId: randomUUID(),
    revision: 1,
    actorId: `${prefix}-repair`,
    reason: 'Owned nonhour maintenance',
    roomId,
    startsAt: nonhour.toISOString(),
  };
  const resourceWrite = (command) =>
    call(corePort, `/internal/v1/maintenance-blocks/${protocolId}`, {
      method: 'PUT',
      token: serviceToken,
      body: command,
    });
  const established = await resourceWrite(original);
  assert.equal(established.status, 200);
  assert.deepEqual(await resourceWrite(original), established);
  assert.equal(
    (await resourceWrite({ ...original, reason: 'Changed command payload' })).status,
    409,
  );
  const persisted = (
    await coreDb.query(
      `SELECT "startsAt" FROM m1_resource_effects WHERE "sourceModule"='M3' AND "sourceId"=$1`,
      [protocolId],
    )
  ).rows[0];
  assert.equal(
    persisted.startsAt.toISOString(),
    nonhour.toISOString(),
    'Maintenance accepts exact nonhour timestamp',
  );
  assert.equal(
    (
      await call(corePort, `/internal/v1/maintenance-blocks/${protocolId}/release`, {
        method: 'POST',
        token: serviceToken,
        body: {
          operationId: randomUUID(),
          revision: 2,
          actorId: `${prefix}-manager`,
          reason: 'Owned protocol release',
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (await resourceWrite(original)).body.state,
    'ACTIVE',
    'Idempotent replay is historical',
  );
  assert.equal(
    (await currentBlock(protocolId)).body.state,
    'RELEASED',
    'Historical receipt does not reactivate current state',
  );
  assert.equal(
    (await resourceWrite({ ...original, operationId: randomUUID(), revision: 3 })).status,
    409,
    'Released source cannot be reused',
  );
  pass(
    'nonhour maintenance timestamp, durable command replay, payload binding and released-source tombstones',
  );

  const createKey = randomUUID();
  const twins = await Promise.all([create('a', createKey), create('a', createKey)]);
  assert.equal(twins[0].id, twins[1].id);
  let order = twins[0];
  assert.equal(
    (
      await call(workflowPort, '/api/v1/work-orders', {
        method: 'POST',
        token: tokens.a,
        key: createKey,
        body: { ...input(), description: 'Changed replay' },
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(workflowPort, `/api/v1/work-orders/${order.id}`, { token: tokens.other })).status,
    404,
  );
  assert.equal(
    (await call(workflowPort, `/api/v1/work-orders/${order.id}`, { token: tokens.repair })).status,
    404,
  );
  const mine = await call(workflowPort, '/api/v1/work-orders?view=mine&limit=1', {
    token: tokens.other,
  });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.items.length, 0);
  assert.equal(
    (await putPolicy({ ...policy, expectedRevision: 1, responseMinutes: 60 })).status,
    200,
  );
  assert.equal(
    (await get(order.id)).policyRevision,
    1,
    'Existing work order freezes its policy version',
  );
  assert.equal((await putPolicy({ ...policy, expectedRevision: 1 })).status, 409);
  pass(
    'concurrent durable create replay, private history, immutable SLA policy snapshots and optimistic policy updates',
  );

  assert.equal(
    (await action(order, 'assign', 'a', { assigneeId: `${prefix}-repair` })).status,
    403,
  );
  assert.equal(
    (await action(order, 'assign', 'manager', { assigneeId: `${prefix}-outsider` })).status,
    403,
  );
  await coreDb.query('UPDATE d_users SET enabled=false WHERE id=$1', [`${prefix}-disabled`]);
  assert.equal(
    (await action(order, 'assign', 'manager', { assigneeId: `${prefix}-disabled` })).status,
    403,
  );
  await coreDb.query('DELETE FROM d_managed_rooms WHERE "userId"=$1 AND "roomId"=$2', [
    `${prefix}-repair2`,
    roomId,
  ]);
  assert.equal(
    (await action(order, 'assign', 'manager', { assigneeId: `${prefix}-repair2` })).status,
    403,
  );
  await coreDb.query('INSERT INTO d_managed_rooms("userId","roomId") VALUES($1,$2)', [
    `${prefix}-repair2`,
    roomId,
  ]);
  order = await mustAction(order, 'assign', 'manager', { assigneeId: `${prefix}-repair2` });
  order = await mustAction(order, 'assign', 'manager', { assigneeId: `${prefix}-repair` });
  const assignments = (
    await workflowDb.query(
      'SELECT "assigneeId" FROM m3_assignment WHERE "workOrderId"=$1 ORDER BY revision',
      [order.id],
    )
  ).rows;
  assert.deepEqual(
    assignments.map((row) => row.assigneeId),
    [`${prefix}-repair2`, `${prefix}-repair`],
  );
  assert.equal((await action(order, 'start', 'repair2')).status, 404);
  pass(
    'dispatch validates active in-scope repairers, reassignment keeps history and only current assignee starts',
  );

  gatewayMode = 'block';
  const startKey = randomUUID();
  const starts = await Promise.all([
    action(order, 'start', 'repair', {}, startKey),
    action(order, 'start', 'repair', {}, startKey),
  ]);
  assert.deepEqual(starts[0], starts[1]);
  assert.equal(starts[0].status, 200);
  order = await waitState(order.id, 'BLOCK_PENDING');
  assert.equal(
    (await action(order, 'cancel', 'a')).status,
    409,
    'Cancellation cannot bypass an issued maintenance intent',
  );
  assert.equal((await action(order, 'complete', 'repair')).status, 409);
  assert.equal(
    (await currentBlock(order.id)).status,
    404,
    'Unknown synchronization cannot appear as active',
  );
  gatewayMode = 'pass';
  await dueOutbox(order.id);
  order = await waitState(order.id, 'IN_REPAIR');
  assert.equal((await availability()).body.items.length, 0);
  const block = await waitBlock(order.id, 'ACTIVE');
  const persistedStart = (
    await workflowDb.query(
      'SELECT "startsAt" FROM m3_outbox WHERE "workOrderId"=$1 AND kind=\'BLOCK\'',
      [order.id],
    )
  ).rows[0].startsAt;
  assert.ok(Number.isFinite(+persistedStart));
  assert.equal(block.sourceModule, 'M3');
  assert.equal((await action(order, 'complete', 'repair2')).status, 404);
  assert.equal(
    (await action({ ...order, revision: order.revision - 1 }, 'complete', 'repair')).status,
    409,
  );
  order = await mustAction(order, 'complete', 'repair');
  assert.equal(order.status, 'AWAITING_ACCEPTANCE');
  assert.equal((await currentBlock(order.id)).body.state, 'ACTIVE');
  order = await mustAction(order, 'accept', 'manager', { accepted: false });
  assert.equal(order.status, 'IN_REPAIR');
  assert.equal(
    (await currentBlock(order.id)).body.operationId,
    block.operationId,
    'Rejected acceptance retains original source',
  );
  order = await closeOrder(order);
  assert.equal((await availability()).body.items.length, 1);
  assert.ok((await action(order, 'rating', 'other')).status >= 400);
  const ratingKey = randomUUID(),
    rating = await mustAction(order, 'rating', 'a', {}, ratingKey);
  assert.deepEqual((await action(order, 'rating', 'a', {}, ratingKey)).body, rating);
  assert.equal((await action(rating, 'rating', 'a', { score: 4 })).status, 409);
  pass(
    'block confirmation precedes repair, rejection keeps source active, closing releases and only reporter rates once',
  );

  let self = await makeRepair('manager');
  self = await mustAction(self, 'complete', 'manager');
  assert.equal(
    (await action(self, 'accept', 'manager')).status,
    403,
    'Repairer with acceptance permission still cannot self-accept',
  );
  await closeOrder(self, 'admin', 'manager');
  const cancelled = await create();
  await coreDb.query('DELETE FROM d_role_permissions WHERE "roleId"=$1 AND "permissionId"=$2', [
    `${prefix}-role-report`,
    'm3.cancel',
  ]);
  assert.equal(
    (await action(cancelled, 'cancel', 'a')).status,
    403,
    'Reporter ownership does not replace the current cancel grant',
  );
  await coreDb.query('INSERT INTO d_role_permissions("roleId","permissionId") VALUES($1,$2)', [
    `${prefix}-role-report`,
    'm3.cancel',
  ]);
  const cancelledResult = await mustAction(cancelled, 'cancel', 'a');
  assert.equal(cancelledResult.status, 'CANCELLED');
  assert.equal(
    (await action(cancelledResult, 'assign', 'manager', { assigneeId: `${prefix}-repair` })).status,
    409,
  );
  assert.equal((await currentBlock(cancelled.id)).status, 404);
  pass('dual-role repairer cannot self-accept; pre-block cancellation is safe and terminal');

  const booking = await call(corePort, '/api/v1/bookings', {
    method: 'POST',
    token: tokens.a,
    key: randomUUID(),
    body: { seatId: `${roomId}-seat`, startsAt: at(9), endsAt: at(10) },
  });
  assert.equal(booking.status, 201);
  const m2Source = `${prefix}-m2-source`;
  owned.add(m2Source);
  assert.equal(
    (
      await call(corePort, `/internal/v1/room-occupancies/${m2Source}`, {
        method: 'PUT',
        token: m2Token,
        body: {
          operationId: randomUUID(),
          revision: 1,
          actorId: `${prefix}-manager`,
          reason: 'Owned existing M2 source',
          roomId,
          startsAt: at(10),
          endsAt: at(11),
        },
      })
    ).status,
    200,
  );
  let first = await makeRepair(),
    second = await makeRepair('repair2');
  assert.equal((await availability()).body.items.length, 0);
  const affectedBooking = await call(corePort, `/api/v1/bookings/${booking.body.id}`, {
    token: tokens.a,
  });
  assert.equal(affectedBooking.body.status, 'BOOKED');
  assert.equal(
    affectedBooking.body.maintenanceAffected,
    true,
    'Existing reservation reports active overlapping maintenance without cancelling it',
  );
  assert.equal(
    (
      await call(corePort, '/api/v1/bookings', {
        method: 'POST',
        token: tokens.a,
        key: randomUUID(),
        body: { seatId: `${roomId}-seat`, startsAt: at(11), endsAt: at(12) },
      })
    ).status,
    409,
  );
  first = await closeOrder(first);
  assert.equal(first.status, 'CLOSED');
  assert.equal((await currentBlock(first.id)).body.state, 'RELEASED');
  assert.equal((await currentBlock(second.id)).body.state, 'ACTIVE');
  assert.equal(
    (await availability()).body.items.length,
    0,
    'Second maintenance source still blocks room',
  );
  second = await closeOrder(second, 'manager', 'repair2');
  assert.equal(second.status, 'CLOSED');
  assert.equal((await availability()).body.items.length, 1);
  const recoveredBooking = await call(corePort, `/api/v1/bookings/${booking.body.id}`, {
    token: tokens.a,
  });
  assert.equal(
    recoveredBooking.body.status,
    'BOOKED',
    'Maintenance does not cancel existing reservations',
  );
  assert.equal(recoveredBooking.body.maintenanceAffected, false);
  assert.equal(
    (await call(corePort, `/internal/v1/room-occupancies/${m2Source}`, { token: m2Token })).body
      .state,
    'ACTIVE',
  );
  assert.equal((await availability(9)).body.items.length, 0);
  assert.equal((await availability(10)).body.items.length, 0);
  assert.equal(
    (
      await call(corePort, `/internal/v1/room-occupancies/${m2Source}/release`, {
        method: 'POST',
        token: m2Token,
        body: {
          operationId: randomUUID(),
          revision: 2,
          actorId: `${prefix}-manager`,
          reason: 'Owned M2 source release',
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(corePort, `/api/v1/bookings/${booking.body.id}/cancel`, {
        method: 'POST',
        token: tokens.a,
        key: randomUUID(),
        body: { reason: 'Owned booking release' },
      })
    ).status,
    200,
  );
  pass(
    'two real maintenance sources overlay individual booking and M2 allocation; each closing releases only its own source',
  );

  let lost = await create();
  lost = await mustAction(lost, 'assign', 'manager', { assigneeId: `${prefix}-repair` });
  gatewayMode = 'drop-next';
  await mustAction(lost, 'start', 'repair');
  const committedBlock = await waitBlock(lost.id, 'ACTIVE');
  await restart();
  lost = await waitState(lost.id, 'IN_REPAIR');
  const commands = (
    await workflowDb.query(
      'SELECT "operationId",attempts FROM m3_outbox WHERE "workOrderId"=$1 AND kind=\'BLOCK\'',
      [lost.id],
    )
  ).rows;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].operationId, committedBlock.operationId);
  const observed = seenCommands.filter((c) => c.sourceId === lost.id && c.method === 'PUT');
  assert.ok(observed.length > 0);
  assert.ok(observed.every((c) => c.operationId === committedBlock.operationId));
  lost = await mustAction(lost, 'complete', 'repair');
  gatewayMode = 'drop-release';
  await mustAction(lost, 'accept', 'manager');
  await waitBlock(lost.id, 'RELEASED');
  await restart();
  await waitState(lost.id, 'CLOSED');
  pass(
    'committed block and release with dropped HTTP responses recover after real service restarts with original operation identity',
  );

  gatewayMode = 'block';
  let pending = await create();
  pending = await mustAction(pending, 'assign', 'manager', { assigneeId: `${prefix}-repair` });
  await mustAction(pending, 'start', 'repair');
  await waitState(pending.id, 'BLOCK_PENDING');
  await delay(250);
  const before = (
    await workflowDb.query(
      'SELECT "operationId" FROM m3_outbox WHERE "workOrderId"=$1 AND kind=\'BLOCK\'',
      [pending.id],
    )
  ).rows[0].operationId;
  await restart();
  assert.equal((await get(pending.id)).status, 'BLOCK_PENDING');
  gatewayMode = 'pass';
  await dueOutbox(pending.id);
  pending = await waitState(pending.id, 'IN_REPAIR');
  assert.equal((await currentBlock(pending.id)).body.operationId, before);
  pending = await mustAction(pending, 'complete', 'repair');
  gatewayMode = 'block';
  await mustAction(pending, 'accept', 'manager');
  await delay(250);
  await workflowDb.query(
    'UPDATE m3_outbox SET attempts=25,"availableAt"=CURRENT_TIMESTAMP WHERE "workOrderId"=$1 AND kind=\'RELEASE\' AND state=\'READY\'',
    [pending.id],
  );
  await delay(400);
  assert.equal(
    (await get(pending.id)).status,
    'RELEASE_PENDING',
    'Unknown release remains recoverable beyond ordinary retry budget',
  );
  assert.equal((await currentBlock(pending.id)).body.state, 'ACTIVE');
  gatewayMode = 'pass';
  await dueOutbox(pending.id);
  await waitState(pending.id, 'CLOSED');
  pass(
    'persisted pending commands survive downtime and unknown release stays recoverable beyond twenty-four attempts',
  );

  const publicRoomId = `${prefix}-public-room`;
  let publicOrder = await create('a', randomUUID(), { ...input(), roomId: publicRoomId });
  const repairerPath = `/internal/v1/identity/work-order-rooms/${publicRoomId}/repairers/${prefix}-department`;
  assert.equal(
    (
      await call(corePort, repairerPath, {
        token: serviceToken,
        extraHeaders: { 'x-user-authorization': `Bearer ${tokens.manager}` },
      })
    ).status,
    403,
    'Public reporting cannot expand a department repair permission',
  );
  assert.equal(
    (await action(publicOrder, 'assign', 'manager', { assigneeId: `${prefix}-department` })).status,
    403,
  );
  assert.equal(
    (await action(publicOrder, 'assign', 'department', { assigneeId: `${prefix}-manager` })).status,
    404,
    'Another department cannot dispatch the public room',
  );
  const deniedSource = `${prefix}-public-denied`;
  owned.add(deniedSource);
  assert.equal(
    (
      await call(corePort, `/internal/v1/maintenance-blocks/${deniedSource}`, {
        method: 'PUT',
        token: serviceToken,
        body: {
          operationId: randomUUID(),
          revision: 1,
          actorId: `${prefix}-department`,
          reason: 'Owned public scope refusal',
          roomId: publicRoomId,
          startsAt: new Date(Date.now() - 1000).toISOString(),
        },
      })
    ).status,
    403,
  );
  publicOrder = await mustAction(publicOrder, 'assign', 'manager', {
    assigneeId: `${prefix}-manager`,
  });
  await mustAction(publicOrder, 'start', 'manager');
  publicOrder = await waitState(publicOrder.id, 'IN_REPAIR');
  publicOrder = await mustAction(publicOrder, 'complete', 'manager');
  assert.equal(
    (await action(publicOrder, 'accept', 'department')).status,
    404,
    'Public reporting cannot expand department acceptance permission',
  );
  await closeOrder(publicOrder, 'admin', 'manager');
  pass(
    'public room reporting crosses departments while department repair/dispatch/accept scopes stay strict; managed-room and ALL remain usable',
  );

  const sla = await create();
  await workflowDb.query(
    'UPDATE m3_work_order SET "responseDeadlineAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE id=$1',
    [sla.id],
  );
  async function waitEscalation(id, stage) {
    const end = Date.now() + 10000;
    do {
      const rows = (
        await workflowDb.query('SELECT * FROM m3_escalation WHERE "workOrderId"=$1 AND stage=$2', [
          id,
          stage,
        ])
      ).rows;
      if (rows.length) return rows;
      await delay(100);
    } while (Date.now() < end);
    assert.fail(`No persistent ${stage} escalation`);
  }
  let escalation = await waitEscalation(sla.id, 'RESPONSE');
  assert.equal(escalation.length, 1);
  assert.ok(
    escalation[0].recipientIds.includes(`${prefix}-manager`),
    'Escalation records actual in-scope recipient',
  );
  assert.ok(escalation[0].deadlineAt instanceof Date);
  await restart();
  await delay(300);
  assert.equal((await waitEscalation(sla.id, 'RESPONSE')).length, 1);
  assert.equal((await get(sla.id)).status, 'NEW');
  let timed = await makeRepair();
  await workflowDb.query(
    'UPDATE m3_work_order SET "repairDeadlineAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE id=$1',
    [timed.id],
  );
  escalation = await waitEscalation(timed.id, 'REPAIR');
  assert.equal(escalation.length, 1);
  assert.equal((await currentBlock(timed.id)).body.state, 'ACTIVE');
  timed = await mustAction(await get(timed.id), 'complete', 'repair');
  await workflowDb.query(
    'UPDATE m3_work_order SET "acceptanceDeadlineAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE id=$1',
    [timed.id],
  );
  escalation = await waitEscalation(timed.id, 'ACCEPTANCE');
  assert.equal(escalation.length, 1);
  assert.equal((await get(timed.id)).status, 'AWAITING_ACCEPTANCE');
  assert.equal((await currentBlock(timed.id)).body.state, 'ACTIVE');
  await closeOrder(await get(timed.id));
  await delay(300);
  assert.equal(
    (
      await workflowDb.query(
        'SELECT count(*)::int AS n FROM m3_escalation WHERE "workOrderId"=$1',
        [timed.id],
      )
    ).rows[0].n,
    2,
  );
  pass(
    'persistent SLA response/repair/acceptance escalation stores recipients, deduplicates across restart, and never releases automatically',
  );

  let race = await create();
  race = await mustAction(race, 'assign', 'manager', { assigneeId: `${prefix}-repair` });
  const racing = await Promise.all([action(race, 'start', 'repair'), action(race, 'cancel', 'a')]);
  assert.deepEqual(racing.map((item) => item.status).sort(), [200, 409]);
  const actual = await get(race.id);
  if (actual.status === 'CANCELLED') assert.equal((await currentBlock(race.id)).status, 404);
  else {
    assert.ok(['BLOCK_PENDING', 'IN_REPAIR'].includes(actual.status));
    await closeOrder(await waitState(race.id, 'IN_REPAIR'));
  }
  pass(
    'start-versus-cancel version fencing permits one transition and cannot revive a cancelled work order',
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
  `${groups} real work-order groups passed; only owned fixtures and child processes were removed.`,
);
