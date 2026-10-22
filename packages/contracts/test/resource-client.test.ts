import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { ResourceApiError, ResourceCoreClient } from '../src/resource-client.ts';

const command = {
  operationId: 'a8051110-ea30-4665-8b9c-121ee02cd773',
  revision: 1,
  actorId: 'synthetic-user',
  reason: 'approved',
  roomId: 'room-1',
  startsAt: '2026-10-20T01:00:00Z',
  endsAt: '2026-10-20T02:00:00Z',
};
const effect = {
  sourceModule: 'M2',
  sourceId: 'application-1',
  operationId: command.operationId,
  revision: 1,
  state: 'ACTIVE',
  updatedAt: '2026-10-15T01:00:00Z',
};

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (origin: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('real HTTP carries source, actor and durable command identity', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, '/internal/v1/room-occupancies/application-1');
      assert.equal(req.method, 'PUT');
      assert.equal(req.headers.authorization, 'Bearer test-only-token');
      assert.equal(req.headers['x-request-id'], command.operationId);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), command);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(effect));
      });
    },
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      assert.deepEqual(await client.occupy('application-1', command), effect);
    },
  );
});

test('resource conflict remains an explicit non-retryable conflict', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'RESOURCE_CONFLICT', message: 'busy', traceId: 'trace-1' },
        }),
      );
    },
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      await assert.rejects(
        client.occupy('application-1', command),
        (error: unknown) =>
          error instanceof ResourceApiError &&
          error.status === 409 &&
          error.code === 'RESOURCE_CONFLICT' &&
          !error.retryable,
      );
    },
  );
});

test('lost response is unknown outcome and does not trigger hidden retries', async () => {
  let attempts = 0;
  await withServer(
    (req, _res) => {
      attempts++;
      req.resume();
    },
    async (baseUrl) => {
      const client = new ResourceCoreClient({
        baseUrl,
        serviceToken: () => 'test-only-token',
        timeoutMs: 150,
      });
      await assert.rejects(
        client.occupy('application-1', command),
        (error: unknown) =>
          error instanceof ResourceApiError &&
          error.code === 'RESOURCE_SYNC_TIMEOUT' &&
          error.retryable,
      );
      assert.equal(attempts, 1);
    },
  );
});

test('a success response for another source must not confirm this command', async () => {
  await withServer(
    (_req, res) => res.end(JSON.stringify({ ...effect, sourceId: 'another-application' })),
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      await assert.rejects(
        client.occupy('application-1', command),
        (error: unknown) =>
          error instanceof ResourceApiError && error.code === 'INVALID_UPSTREAM_RESPONSE',
      );
    },
  );
});

test('redirects cannot forward service credentials to another origin', async () => {
  let targetCalls = 0;
  await withServer(
    (_req, res) => {
      targetCalls++;
      res.end(JSON.stringify(effect));
    },
    async (target) => {
      await withServer(
        (_req, res) => {
          res.writeHead(307, { location: target });
          res.end();
        },
        async (baseUrl) => {
          const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
          await assert.rejects(client.occupy('application-1', command), ResourceApiError);
          assert.equal(targetCalls, 0);
        },
      );
    },
  );
});

test('source identifiers cannot escape the resource path', async () => {
  const client = new ResourceCoreClient({
    baseUrl: 'http://127.0.0.1:9',
    serviceToken: () => 'test-only-token',
  });
  await assert.rejects(client.occupy('..', command), /Invalid resource command/);
});

test('source query returns the current receipt independently of the original command', async () => {
  const current = { ...effect, revision: 2, state: 'RELEASED' };
  await withServer(
    (req, res) => {
      assert.equal(req.method, 'GET');
      assert.equal(req.url, '/internal/v1/room-occupancies/application-1');
      res.end(JSON.stringify(current));
    },
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      assert.deepEqual(await client.getOccupancy('application-1'), current);
    },
  );
});
test('identity context redirects cannot forward either credential', async () => {
  let targetCalls = 0;
  await withServer(
    (_req, res) => {
      targetCalls++;
      res.end('{}');
    },
    async (target) => {
      await withServer(
        (_req, res) => {
          res.writeHead(307, { location: target });
          res.end();
        },
        async (baseUrl) => {
          const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
          await assert.rejects(client.getUserContext(`Bearer ${'x'.repeat(43)}`), ResourceApiError);
          assert.equal(targetCalls, 0);
        },
      );
    },
  );
});

test('room context uses both credentials and validates the requested room', async () => {
  const room = {
    id: 'room-1',
    code: 'A101',
    name: 'Synthetic room',
    enabled: true,
    restrictedToDepartment: true,
    departmentId: 'department-1',
  };
  await withServer(
    (req, res) => {
      assert.equal(req.url, '/internal/v1/identity/rooms/room-1');
      assert.equal(req.headers.authorization, 'Bearer test-only-token');
      assert.equal(req.headers['x-user-authorization'], `Bearer ${'x'.repeat(43)}`);
      res.end(JSON.stringify(room));
    },
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      assert.deepEqual(await client.getRoomContext('room-1', `Bearer ${'x'.repeat(43)}`), room);
    },
  );
  await withServer(
    (_req, res) => res.end(JSON.stringify({ ...room, id: 'other-room' })),
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      await assert.rejects(
        client.getRoomContext('room-1', `Bearer ${'x'.repeat(43)}`),
        (error: unknown) =>
          error instanceof ResourceApiError && error.code === 'INVALID_UPSTREAM_RESPONSE',
      );
    },
  );
});

test('room context redirects and invalid paths cannot disclose either credential', async () => {
  let targetCalls = 0;
  await withServer(
    (_req, res) => {
      targetCalls++;
      res.end('{}');
    },
    async (target) => {
      await withServer(
        (_req, res) => {
          res.writeHead(307, { location: target });
          res.end();
        },
        async (baseUrl) => {
          const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
          await assert.rejects(
            client.getRoomContext('room-1', `Bearer ${'x'.repeat(43)}`),
            ResourceApiError,
          );
          await assert.rejects(
            client.getRoomContext('a..b', `Bearer ${'x'.repeat(43)}`),
            /Invalid room/,
          );
          assert.equal(targetCalls, 0);
        },
      );
    },
  );
});

test('maintenance queries validate the M3 source independently of old commands', async () => {
  const current = {
    ...effect,
    sourceModule: 'M3',
    sourceId: 'work-1',
    revision: 4,
    state: 'RELEASED',
  };
  await withServer(
    (req, res) => {
      assert.equal(req.url, '/internal/v1/maintenance-blocks/work-1');
      res.end(JSON.stringify(current));
    },
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      assert.deepEqual(await client.getBlock('work-1'), current);
    },
  );
  await withServer(
    (_req, res) => res.end(JSON.stringify({ ...current, sourceModule: 'M2' })),
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      await assert.rejects(
        client.getBlock('work-1'),
        (error: unknown) =>
          error instanceof ResourceApiError && error.code === 'INVALID_UPSTREAM_RESPONSE',
      );
    },
  );
});

test('M3 room context carries both credentials and bounded recipient facts', async () => {
  const context = {
    room: {
      id: 'room-1',
      code: 'A101',
      name: 'Synthetic',
      enabled: true,
      restrictedToDepartment: true,
      departmentId: 'dep-1',
    },
    escalationRecipientIds: ['manager-1'],
  };
  await withServer(
    (req, res) => {
      assert.equal(req.url, '/internal/v1/identity/work-order-rooms/room-1');
      assert.equal(req.headers.authorization, 'Bearer test-only-token');
      assert.equal(req.headers['x-user-authorization'], `Bearer ${'x'.repeat(43)}`);
      res.end(JSON.stringify(context));
    },
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      assert.deepEqual(
        await client.getWorkOrderRoomContext('room-1', `Bearer ${'x'.repeat(43)}`),
        context,
      );
    },
  );
  await withServer(
    (_req, res) => res.end(JSON.stringify({ ...context, escalationRecipientIds: [false] })),
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      await assert.rejects(
        client.getWorkOrderRoomContext('room-1', `Bearer ${'x'.repeat(43)}`),
        ResourceApiError,
      );
    },
  );
});

test('M3 repairer identity must match the requested user and cannot follow redirects', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, '/internal/v1/identity/work-order-rooms/room-1/repairers/repairer-1');
      res.end(JSON.stringify({ userId: 'someone-else', displayName: 'Synthetic' }));
    },
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      await assert.rejects(
        client.getRepairerContext('room-1', 'repairer-1', `Bearer ${'x'.repeat(43)}`),
        ResourceApiError,
      );
    },
  );
  let targetCalls = 0;
  await withServer(
    (_req, res) => {
      targetCalls++;
      res.end('{}');
    },
    async (target) => {
      await withServer(
        (_req, res) => {
          res.writeHead(307, { location: target });
          res.end();
        },
        async (baseUrl) => {
          const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
          await assert.rejects(
            client.getRepairerContext('room-1', 'repairer-1', `Bearer ${'x'.repeat(43)}`),
            ResourceApiError,
          );
          assert.equal(targetCalls, 0);
        },
      );
    },
  );
});

test('oversized maintenance context is rejected before accepting upstream facts', async () => {
  await withServer(
    (_req, res) => res.end(JSON.stringify({ padding: 'x'.repeat(70000) })),
    async (baseUrl) => {
      const client = new ResourceCoreClient({ baseUrl, serviceToken: () => 'test-only-token' });
      await assert.rejects(
        client.getWorkOrderRoomContext('room-1', `Bearer ${'x'.repeat(43)}`),
        (error: unknown) =>
          error instanceof ResourceApiError && error.code === 'INVALID_UPSTREAM_RESPONSE',
      );
    },
  );
});
