import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResourceApiError } from '@campus/contracts';
import { randomUUID } from 'node:crypto';
import type { M3Outbox } from '../../generated/prisma/client.js';
import { PrismaService } from '../../platform/prisma.service.js';
import { MaintenanceGateway } from './resource.gateway.js';
import {
  audit,
  bump,
  json,
  lock,
  recipientIds,
  withWorkOrder,
  type WorkOrderRow,
} from './m3.service.js';

@Injectable()
export class M3Worker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(M3Worker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private reportedFailure = false;
  constructor(
    private readonly db: PrismaService,
    private readonly resources: MaintenanceGateway,
    private readonly config: ConfigService,
  ) {}
  onModuleInit(): void {
    if (this.config.get<string>('M3_WORKER_ENABLED') === 'false') return;
    this.timer = setInterval(
      () => {
        if (this.running) return;
        this.running = this.runOnce()
          .catch(() => {
            if (!this.reportedFailure)
              this.logger.warn(
                'M3 durable worker is unavailable; pending commands remain persisted',
              );
            this.reportedFailure = true;
          })
          .finally(() => {
            this.running = undefined;
          });
      },
      Number(this.config.get<string>('M3_WORKER_INTERVAL_MS') ?? 500),
    );
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async runOnce(): Promise<void> {
    await this.scanEscalations();
    if (!this.resources.configured) return;
    for (let count = 0; count < 4; count++) {
      const row = await this.claim();
      if (!row) break;
      await this.dispatch(row);
    }
    this.reportedFailure = false;
  }
  private async scanEscalations(): Promise<void> {
    const now = new Date();
    // Exclude already-recorded stage/rounds before LIMIT so old overdue orders cannot starve newer ones.
    const due = await this.db.$queryRaw<{ id: string }[]>`
   SELECT w."id" FROM "m3_work_order" w
   WHERE (
    (w."status" IN ('NEW','ASSIGNED','BLOCK_PENDING','SYNC_FAILED') AND w."responseDeadlineAt"<=${now})
    OR (w."status"='IN_REPAIR' AND w."repairDeadlineAt"<=${now})
    OR (w."status"='AWAITING_ACCEPTANCE' AND w."acceptanceDeadlineAt"<=${now})
   ) AND NOT EXISTS (
    SELECT 1 FROM "m3_escalation" e WHERE e."workOrderId"=w."id"
     AND e."stage"=CASE WHEN w."status" IN ('NEW','ASSIGNED','BLOCK_PENDING','SYNC_FAILED') THEN 'RESPONSE'
       WHEN w."status"='IN_REPAIR' THEN 'REPAIR' ELSE 'ACCEPTANCE' END
     AND e."round"=CASE WHEN w."status" IN ('NEW','ASSIGNED','BLOCK_PENDING','SYNC_FAILED') THEN 1 ELSE w."repairRound" END
   ) ORDER BY w."id" LIMIT 100`;
    for (const item of due)
      await this.db.$transaction(async (tx) => {
        await lock(tx, 'work-order:' + item.id);
        const a = await tx.m3WorkOrder.findUnique({ where: { id: item.id } });
        if (!a) return;
        const stage = ['NEW', 'ASSIGNED', 'BLOCK_PENDING', 'SYNC_FAILED'].includes(a.status)
          ? 'RESPONSE'
          : a.status === 'IN_REPAIR'
            ? 'REPAIR'
            : a.status === 'AWAITING_ACCEPTANCE'
              ? 'ACCEPTANCE'
              : undefined;
        const deadlineAt =
          stage === 'RESPONSE'
            ? a.responseDeadlineAt
            : stage === 'REPAIR'
              ? a.repairDeadlineAt
              : a.acceptanceDeadlineAt;
        if (!stage || !deadlineAt || deadlineAt > now) return;
        const round = stage === 'RESPONSE' ? 1 : a.repairRound;
        const existing = await tx.m3Escalation.findUnique({
          where: { workOrderId_stage_round: { workOrderId: a.id, stage, round } },
        });
        if (existing) return;
        const recipients = [
          ...new Set([
            ...recipientIds(a.escalationRecipientIds),
            ...(stage === 'REPAIR' && a.assigneeId ? [a.assigneeId] : []),
          ]),
        ];
        await tx.m3Escalation.create({
          data: {
            id: randomUUID(),
            workOrderId: a.id,
            stage,
            round,
            level: 1,
            deadlineAt,
            recipientIds: json(recipients),
          },
        });
        await audit(tx, a.id, 'system-m3-worker', 'sla.escalated', {
          stage,
          round,
          level: 1,
          deadlineAt: deadlineAt.toISOString(),
          recipientIds: recipients,
        });
      });
  }
  private async claim(): Promise<M3Outbox | undefined> {
    const token = randomUUID(),
      now = new Date(),
      until = new Date(+now + 30000);
    const rows = await this.db.$queryRaw<M3Outbox[]>`
   UPDATE "m3_outbox" SET "state"='PROCESSING',"leaseToken"=${token}::uuid,"leasedUntil"=${until},"attempts"="attempts"+1
   WHERE "operationId"=(SELECT "operationId" FROM "m3_outbox"
    WHERE ("state"='READY' AND "availableAt"<=${now}) OR ("state"='PROCESSING' AND "leasedUntil"<=${now})
    ORDER BY "availableAt","createdAt","operationId" FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING *`;
    return rows[0];
  }
  private matches(a: WorkOrderRow | undefined | null, row: M3Outbox): a is WorkOrderRow {
    return (
      !!a &&
      a.revision === row.workOrderRevision &&
      a.status === (row.kind === 'BLOCK' ? 'BLOCK_PENDING' : 'RELEASE_PENDING')
    );
  }
  private async dispatch(row: M3Outbox): Promise<void> {
    const a = await this.db.m3WorkOrder.findUnique({
      where: { id: row.workOrderId },
      include: withWorkOrder,
    });
    if (!this.matches(a, row)) {
      await this.supersede(row);
      return;
    }
    try {
      const client = this.resources.requireClient(),
        command = {
          operationId: row.operationId,
          revision: row.workOrderRevision,
          actorId: row.actorId,
          reason: row.reason,
        };
      if (row.kind === 'BLOCK') {
        if (!row.startsAt)
          throw new ResourceApiError(
            'BLOCK_TIME_MISSING',
            'Persisted maintenance time is missing',
            false,
            400,
          );
        await client.block(a.id, {
          ...command,
          roomId: a.roomId,
          startsAt: row.startsAt.toISOString(),
        });
        const current = await client.getBlock(a.id);
        if (
          current.state !== 'ACTIVE' ||
          current.operationId !== row.operationId ||
          current.revision !== row.workOrderRevision
        )
          throw new ResourceApiError(
            'SOURCE_STATE_MISMATCH',
            'Source state no longer matches maintenance intent',
            false,
            409,
          );
      } else {
        let released = false;
        try {
          released = (await client.getBlock(a.id)).state === 'RELEASED';
        } catch {
          /* Persisted release is safe if the query is unavailable. */
        }
        if (!released) {
          await client.releaseBlock(a.id, command);
          if ((await client.getBlock(a.id)).state !== 'RELEASED')
            throw new ResourceApiError(
              'SOURCE_STATE_MISMATCH',
              'Release could not be confirmed',
              true,
              503,
            );
        }
      }
      await this.finish(row, true, null, false, false);
    } catch (error) {
      const code =
        error instanceof ResourceApiError && /^[A-Z0-9_]{1,100}$/.test(error.code)
          ? error.code
          : 'RESOURCE_SYNC_UNAVAILABLE';
      const retry =
        error instanceof ResourceApiError ? error.retryable && error.status !== 501 : true;
      const persistent =
        error instanceof ResourceApiError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        ![401, 429].includes(error.status);
      await this.finish(row, false, code, retry, persistent);
    }
  }
  private async supersede(row: M3Outbox): Promise<void> {
    await this.db.m3Outbox.updateMany({
      where: { operationId: row.operationId, state: 'PROCESSING', leaseToken: row.leaseToken },
      data: { state: 'SUPERSEDED', finishedAt: new Date(), leaseToken: null, leasedUntil: null },
    });
  }
  private async finish(
    row: M3Outbox,
    success: boolean,
    code: string | null,
    retry: boolean,
    persistedBusinessFailure: boolean,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await lock(tx, 'work-order:' + row.workOrderId);
      // A stale lease must not overwrite a later worker result after expiry and reclaim.
      await tx.$queryRaw`SELECT "operationId" FROM "m3_outbox" WHERE "operationId"=${row.operationId}::uuid FOR UPDATE`;
      const active = await tx.m3Outbox.findUnique({ where: { operationId: row.operationId } });
      if (!active || active.state !== 'PROCESSING' || active.leaseToken !== row.leaseToken) return;
      const a = await tx.m3WorkOrder.findUnique({
        where: { id: row.workOrderId },
        include: withWorkOrder,
      });
      if (!this.matches(a, row)) {
        await tx.m3Outbox.update({
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
      const slowDelay = Number(this.config.get<string>('M3_RELEASE_RETRY_DELAY_MS') ?? 300000);
      if (
        !success &&
        row.kind === 'RELEASE' &&
        persistedBusinessFailure &&
        a.revision < 2147483646
      ) {
        const revision = bump(a.revision),
          operationId = randomUUID();
        await tx.m3Outbox.update({
          where: { operationId: row.operationId },
          data: {
            state: 'FAILED',
            lastError: code,
            finishedAt: new Date(),
            leaseToken: null,
            leasedUntil: null,
          },
        });
        await tx.m3WorkOrder.update({ where: { id: a.id }, data: { revision, syncError: code } });
        await tx.m3Outbox.create({
          data: {
            operationId,
            workOrderId: a.id,
            workOrderRevision: revision,
            kind: 'RELEASE',
            actorId: row.actorId,
            reason: row.reason,
            availableAt: new Date(Date.now() + slowDelay),
          },
        });
        await audit(tx, a.id, row.actorId, 'resource.recovery_scheduled', {
          previousOperationId: row.operationId,
          operationId,
          revision,
          code,
        });
        return;
      }
      if (!success && (retry || row.kind === 'RELEASE')) {
        // Unknown block results keep their exact command even after the fast retry budget.
        const delay =
          row.attempts >= 24 || !retry
            ? slowDelay
            : Math.min(60000, 5000 * 2 ** Math.min(row.attempts - 1, 4));
        await tx.m3Outbox.update({
          where: { operationId: row.operationId },
          data: {
            state: 'READY',
            availableAt: new Date(Date.now() + delay),
            lastError: code,
            leaseToken: null,
            leasedUntil: null,
          },
        });
        await tx.m3WorkOrder.update({ where: { id: a.id }, data: { syncError: code } });
        return;
      }
      await tx.m3Outbox.update({
        where: { operationId: row.operationId },
        data: {
          state: success ? 'SUCCEEDED' : 'FAILED',
          lastError: code,
          finishedAt: new Date(),
          leaseToken: null,
          leasedUntil: null,
        },
      });
      const status = success ? (row.kind === 'BLOCK' ? 'IN_REPAIR' : 'CLOSED') : 'SYNC_FAILED';
      await tx.m3WorkOrder.update({
        where: { id: a.id },
        data: {
          status,
          revision: bump(a.revision),
          syncError: code,
          ...(success && row.kind === 'BLOCK'
            ? { repairDeadlineAt: new Date(Date.now() + a.policy.repairMinutes * 60000) }
            : {}),
        },
      });
      await audit(
        tx,
        a.id,
        row.actorId,
        success ? 'resource.command_confirmed' : 'resource.command_failed',
        {
          operationId: row.operationId,
          kind: row.kind,
          sourceRevision: row.workOrderRevision,
          status,
          code,
          attempts: row.attempts,
        },
      );
    });
  }
}
