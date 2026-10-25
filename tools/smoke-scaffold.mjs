import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const withDatabase = process.argv.includes('--with-local-db');
const backendRequire = createRequire(
  new URL('../apps/resource-core/package.json', import.meta.url),
);
const { parse } = backendRequire('dotenv');

async function unusedPort() {
  const reservation = createServer();
  await new Promise((done, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', done);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((done, reject) =>
    reservation.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

async function checkService(service, operationPath) {
  const port = await unusedPort();
  const databaseUrl = withDatabase
    ? parse(readFileSync(resolve(root, `apps/${service}/.env`), 'utf8')).DATABASE_URL
    : 'postgresql://verification:verification@127.0.0.1:9/unavailable';
  assert.ok(databaseUrl, 'Local database configuration is required');
  if (withDatabase)
    assert.equal(
      new URL(databaseUrl).hostname,
      '127.0.0.1',
      'This test only uses the local database',
    );
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve(root, `apps/${service}`),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      FRONTEND_ORIGINS: 'http://localhost:5173',
      API_DOCS_ENABLED: 'true',
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = (output + String(chunk)).slice(-12000);
  });
  child.stderr.on('data', (chunk) => {
    output = (output + String(chunk)).slice(-12000);
  });
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let live;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`${service} exited before ready: ${output}`);
      try {
        const response = await fetch(`${origin}/health/live`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          live = await response.json();
          break;
        }
      } catch {
        // The owned temporary process may still be starting.
      }
      await delay(100);
    }
    assert.equal(live?.service, service, `Liveness failed: ${output}`);
    assert.equal(live.status, 'live');

    const unavailable = await fetch(`${origin}/health/ready`, {
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(unavailable.status, withDatabase ? 200 : 503);
    const readyBody = await unavailable.json();
    if (withDatabase) {
      assert.equal(readyBody.status, 'ready');
      assert.equal(readyBody.service, service);
    } else {
      assert.equal(readyBody.error.code, 'DEPENDENCY_UNAVAILABLE');
      assert.equal(readyBody.error.traceId, unavailable.headers.get('x-request-id'));
    }

    const stub = await fetch(`${origin}${operationPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const expectedOperationStatus = 401;
    assert.equal(stub.status, expectedOperationStatus);
    assert.equal((await stub.json()).error.code, 'UNAUTHENTICATED');

    const absent = await fetch(`${origin}/this-route-does-not-exist`);
    assert.equal(absent.status, 404);
    assert.equal((await absent.json()).error.code, 'NOT_FOUND');

    const document = await fetch(`${origin}/docs-json`);
    assert.equal(document.status, 200);
    const spec = await document.json();
    assert.ok(Object.keys(spec.paths).length > 0);
    for (const methods of Object.values(spec.paths)) {
      for (const operation of Object.values(methods)) {
        assert.equal(operation['x-service'], service);
      }
    }
    console.log(
      `${service}: liveness, ${withDatabase ? 'real database readiness' : 'unavailable readiness'}, protected operation 401, 404 and scoped API docs passed`,
    );
  } finally {
    if (child.exitCode === null && !spawnError) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await new Promise((done) => child.once('close', done));
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

await checkService('resource-core', '/api/v1/bookings/scaffold-only/check-in');
await checkService('workflow', '/api/v1/work-orders');
console.log(
  'Temporary service processes closed; existing database and local configuration preserved.',
);
