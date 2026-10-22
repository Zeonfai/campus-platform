import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResourceApiError } from '@campus/contracts';
import { randomUUID } from 'node:crypto';
import type { M2Outbox } from '../../generated/prisma/client.js';
import { PrismaService } from '../../platform/prisma.service.js';
import { ResourceGateway } from './resource.gateway.js';
import { audit, expireApplication, lock, withSteps } from './m2.service.js';

@Injectable()
export class M2Worker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(M2Worker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private reportedFailure = false;
  constructor(
    private readonly db: PrismaService,
    private readonly resources: ResourceGateway,
    private readonly config: ConfigService,
  ) {}
  onModuleInit(): void {
    if (this.config.get<string>('M2_WORKER_ENABLED') === 'false') return;
    const interval = Number(this.config.get<string>('M2_WORKER_INTERVAL_MS') ?? 500);
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.runOnce()
        .catch(() => {
          if (!this.reportedFailure)
            this.logger.warn('M2 durable worker is unavailable; pending commands remain persisted');
          this.reportedFailure = true;
        })
        .finally(() => {
          this.running = undefined;
        });
    }, interval);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async runOnce(): Promise<void> {
    if (!this.resources.configured) return;
    const expired = await this.db.m2Application.findMany({
      where: {
        status: { in: ['PENDING', 'SYNCING', 'SYNC_FAILED'] },
        targetStatus: null,
        deadlineAt: { lte: new Date() },
      },
      select: { id: true },
      take: 20,
      orderBy: { deadlineAt: 'asc' },
    });
    for (const item of expired) {
      await this.db.$transaction(async (tx) => {
        await lock(tx, 'application:' + item.id);
        const app = await tx.m2Application.findUnique({
          where: { id: item.id },
          include: withSteps,
        });
        if (app) await expireApplication(tx, app, new Date());
      });
    }
    for (let count = 0; count < 4; count++) {
      const row = await this.claim();
      if (!row) break;
      await this.dispatch(row);
    }
    this.reportedFailure = false;
  }
  private async claim(): Promise<M2Outbox | undefined> {
    const token = randomUUID(),
      now = new Date(),
      until = new Date(+now + 30000);
    const rows = await this.db.$queryRaw<M2Outbox[]>`
   UPDATE "m2_outbox" SET "state"='PROCESSING',"leaseToken"=${token}::uuid,"leasedUntil"=${until},"attempts"="attempts"+1
   WHERE "operationId"=(SELECT "operationId" FROM "m2_outbox"
    WHERE ("state"='READY' AND "availableAt"<=${now}) OR ("state"='PROCESSING' AND "leasedUntil"<=${now})
    ORDER BY "availableAt","createdAt","operationId" FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING *`;
    return rows[0];
  }
  private async dispatch(row: M2Outbox): Promise<void> {
    const app = await this.db.m2Application.findUnique({
      where: { id: row.applicationId },
      include: withSteps,
    });
    if (
      !app ||
      app.revision !== row.applicationRevision ||
      app.status !== (row.kind === 'OCCUPY' ? 'SYNCING' : 'RELEASE_PENDING')
    ) {
      await this.supersede(row);
      return;
    }
    if (row.kind === 'OCCUPY' && app.deadlineAt <= new Date()) {
      await this.db.$transaction(async (tx) => {
        await lock(tx, 'application:' + row.applicationId);
        const current = await tx.m2Application.findUnique({
          where: { id: row.applicationId },
          include: withSteps,
        });
        if (current) await expireApplication(tx, current, new Date());
      });
      await this.supersede(row);
      return;
    }
    if (row.kind === 'OCCUPY' && row.attempts > 24) {
      await this.finish(row, false, 'RETRY_LIMIT_EXCEEDED', false);
      return;
    }
    try {
      const client = this.resources.requireClient();
      const command = {
        operationId: row.operationId,
        revision: row.applicationRevision,
        actorId: row.actorId,
        reason: row.reason,
      };
      if (row.kind === 'OCCUPY') {
        await client.occupy(app.id, {
          ...command,
          roomId: app.roomId,
          startsAt: app.startsAt.toISOString(),
          endsAt: app.endsAt.toISOString(),
        });
        // A receipt is historical. Confirm current source state before marking this application approved.
        const current = await client.getOccupancy(app.id);
        if (
          current.state !== 'ACTIVE' ||
          current.revision !== row.applicationRevision ||
          current.operationId !== row.operationId
        )
          throw new ResourceApiError(
            'SOURCE_STATE_MISMATCH',
            'Source state no longer matches approval',
            false,
            409,
          );
      } else {
        // RELEASED is terminal in M1. A current-source query reconciles lost release responses.
        let released = false;
        try {
          released = (await client.getOccupancy(app.id)).state === 'RELEASED';
        } catch {
          /* Sending the persisted release remains safe when the query is unavailable. */
        }
        if (!released) await client.releaseOccupancy(app.id, command);
      }
      await this.finish(row, true, null, false);
    } catch (error) {
      const code =
        error instanceof ResourceApiError && /^[A-Z0-9_]{1,100}$/.test(error.code)
          ? error.code
          : 'RESOURCE_SYNC_UNAVAILABLE';
      const retry =
        error instanceof ResourceApiError ? error.retryable && error.status !== 501 : true;
      const persistedBusinessFailure =
        error instanceof ResourceApiError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        ![401, 429].includes(error.status);
      await this.finish(row, false, code, retry && row.attempts < 24, persistedBusinessFailure);
    }
  }
  private async supersede(row: M2Outbox): Promise<void> {
    await this.db.m2Outbox.updateMany({
      where: { operationId: row.operationId, state: 'PROCESSING', leaseToken: row.leaseToken },
      data: { state: 'SUPERSEDED', finishedAt: new Date(), leaseToken: null, leasedUntil: null },
    });
  }
  private async finish(
    row: M2Outbox,
    success: boolean,
    code: string | null,
    retry: boolean,
    persistedBusinessFailure = false,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await lock(tx, 'application:' + row.applicationId);
      // Claim does not hold the application lock. Lock this row before checking the lease token.
      await tx.$queryRaw`SELECT "operationId" FROM "m2_outbox" WHERE "operationId"=${row.operationId}::uuid FOR UPDATE`;
      const active = await tx.m2Outbox.findUnique({ where: { operationId: row.operationId } });
      if (!active || active.state !== 'PROCESSING' || active.leaseToken !== row.leaseToken) return;
      const app = await tx.m2Application.findUnique({
        where: { id: row.applicationId },
        include: withSteps,
      });
      if (
        !app ||
        app.revision !== row.applicationRevision ||
        app.status !== (row.kind === 'OCCUPY' ? 'SYNCING' : 'RELEASE_PENDING')
      ) {
        await tx.m2Outbox.update({
          where: { operationId: row.operationId },
          data: {
            state: 'SUPERSEDED',
            finishedAt: new Date(),
            leaseToken: null,
            leasedUntil: null,
          },
        });
        return;
      }
      if (row.kind === 'OCCUPY' && app.deadlineAt <= new Date()) {
        await expireApplication(tx, app, new Date());
        await tx.m2Outbox.update({
          where: { operationId: row.operationId },
          data: {
            state: 'SUPERSEDED',
            finishedAt: new Date(),
            leaseToken: null,
            leasedUntil: null,
          },
        });
        return;
      }
      if (row.kind === 'RELEASE' && !success) {
        const slowDelay = Number(this.config.get<string>('M2_RELEASE_RETRY_DELAY_MS') ?? 300000);
        if (persistedBusinessFailure && app.revision < 2147483647) {
          // M1 persists business failures per operationId. A new, higher intent can converge after permissions recover.
          const revision = app.revision + 1;
          const operationId = randomUUID();
          await tx.m2Outbox.update({
            where: { operationId: row.operationId },
            data: {
              state: 'FAILED',
              lastError: code,
              finishedAt: new Date(),
              leaseToken: null,
              leasedUntil: null,
            },
          });
          await tx.m2Application.update({
            where: { id: app.id },
            data: { revision, syncError: code },
          });
          await tx.m2Outbox.create({
            data: {
              operationId,
              applicationId: app.id,
              applicationRevision: revision,
              kind: 'RELEASE',
              actorId: row.actorId,
              reason: row.reason,
              availableAt: new Date(Date.now() + slowDelay),
            },
          });
          await audit(tx, app.id, row.actorId, 'resource.release_recovery_scheduled', {
            previousOperationId: row.operationId,
            operationId,
            revision,
            code,
          });
        } else {
          const delay =
            row.attempts >= 24 || !retry
              ? slowDelay
              : Math.min(60000, 5000 * 2 ** Math.min(row.attempts - 1, 4));
          await tx.m2Outbox.update({
            where: { operationId: row.operationId },
            data: {
              state: 'READY',
              availableAt: new Date(Date.now() + delay),
              lastError: code,
              leaseToken: null,
              leasedUntil: null,
            },
          });
          await tx.m2Application.update({ where: { id: app.id }, data: { syncError: code } });
        }
        return;
      }
      if (retry) {
        const delay = Math.min(60000, 5000 * 2 ** Math.min(row.attempts - 1, 4));
        await tx.m2Outbox.update({
          where: { operationId: row.operationId },
          data: {
            state: 'READY',
            availableAt: new Date(Date.now() + delay),
            lastError: code,
            leaseToken: null,
            leasedUntil: null,
          },
        });
        await tx.m2Application.update({ where: { id: app.id }, data: { syncError: code } });
        return;
      }
      await tx.m2Outbox.update({
        where: { operationId: row.operationId },
        data: {
          state: success ? 'SUCCEEDED' : 'FAILED',
          lastError: code,
          finishedAt: new Date(),
          leaseToken: null,
          leasedUntil: null,
        },
      });
      if (app.revision >= 2147483647) throw new Error('Application revision exhausted');
      const status = success
        ? row.kind === 'OCCUPY'
          ? 'APPROVED'
          : app.targetStatus
        : 'SYNC_FAILED';
      if (!status) throw new Error('Release has no terminal target');
      await tx.m2Application.update({
        where: { id: app.id },
        data: {
          status,
          revision: app.revision + 1,
          syncError: code,
          ...(success ? { targetStatus: null } : {}),
        },
      });
      await audit(
        tx,
        app.id,
        row.actorId,
        success ? 'resource.command_confirmed' : 'resource.command_failed',
        {
          operationId: row.operationId,
          kind: row.kind,
          sourceRevision: row.applicationRevision,
          status,
          code,
          attempts: row.attempts,
        },
      );
    });
  }
}
