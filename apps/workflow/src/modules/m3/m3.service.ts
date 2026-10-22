import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../platform/prisma.service.js';
import { MaintenanceGateway, type MaintenanceIdentity } from './resource.gateway.js';
import type {
  AcceptWorkOrderDto,
  AssignWorkOrderDto,
  CreateWorkOrderDto,
  MaintenancePolicyQueryDto,
  RateWorkOrderDto,
  SetMaintenancePolicyDto,
  WorkOrderActionDto,
  WorkOrderQueryDto,
} from './m3.dto.js';

export type Tx = Prisma.TransactionClient;
export type WorkOrderRow = Prisma.M3WorkOrderGetPayload<{
  include: { policy: true; events: true };
}>;
export type MaintenancePolicyRow = Prisma.M3PolicyGetPayload<Record<string, never>>;
export const withWorkOrder = {
  policy: true,
  events: { orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }], take: 100 },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function lock(tx: Tx, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key},0))`;
}
export function bump(revision: number): number {
  if (revision >= 2147483647)
    throw new ConflictException({ code: 'REVISION_EXHAUSTED', message: 'Revision exhausted' });
  return revision + 1;
}
export function recipientIds(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
export function workOrderView(a: WorkOrderRow, events = true) {
  return {
    id: a.id,
    roomId: a.roomId,
    departmentId: a.departmentId,
    reporterId: a.reporterId,
    assigneeId: a.assigneeId,
    assigneeName: a.assigneeName,
    category: a.category,
    description: a.description,
    status: a.status,
    revision: a.revision,
    policyId: a.policyId,
    policyRevision: a.policyRevision,
    responseDeadlineAt: a.responseDeadlineAt.toISOString(),
    repairDeadlineAt: a.repairDeadlineAt?.toISOString() ?? null,
    acceptanceDeadlineAt: a.acceptanceDeadlineAt?.toISOString() ?? null,
    rating: a.rating,
    ratingComment: a.ratingComment,
    syncError: a.syncError,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    events: events
      ? [...a.events].reverse().map((e) => ({
          id: e.id,
          actorId: e.actorId,
          action: e.action,
          data: e.data,
          createdAt: e.createdAt.toISOString(),
        }))
      : [],
  };
}
export type WorkOrderView = ReturnType<typeof workOrderView>;
function policyView(a: MaintenancePolicyRow) {
  return {
    id: a.id,
    name: a.name,
    revision: a.revision,
    responseMinutes: a.responseMinutes,
    repairMinutes: a.repairMinutes,
    acceptanceMinutes: a.acceptanceMinutes,
  };
}
export function permission(actor: MaintenanceIdentity, id: string, scope?: string): boolean {
  return actor.grants.some((g) => g.permission === id && (!scope || scope === g.scope));
}
export function scopeMatches(
  actor: MaintenanceIdentity,
  scope: string,
  a: Pick<WorkOrderRow, 'roomId' | 'departmentId'>,
): boolean {
  if (scope === 'ALL') return true;
  if (scope === 'DEPARTMENT')
    return !!actor.user.departmentId && actor.user.departmentId === a.departmentId;
  if (scope === 'MANAGED_ROOMS') return actor.managedRoomIds.includes(a.roomId);
  return false;
}
function allowed(actor: MaintenanceIdentity, id: string, a: WorkOrderRow): boolean {
  return actor.grants.some((g) => g.permission === id && scopeMatches(actor, g.scope, a));
}
function ownerActionAllowed(actor: MaintenanceIdentity, id: string, a: WorkOrderRow): boolean {
  return actor.grants.some(
    (g) =>
      g.permission === id &&
      ((g.scope === 'SELF' && actor.user.id === a.reporterId) || scopeMatches(actor, g.scope, a)),
  );
}
function managed(actor: MaintenanceIdentity, a: WorkOrderRow): boolean {
  return ['m3.dispatch', 'm3.accept', 'm3.cancel'].some((p) => allowed(actor, p, a));
}
function visible(actor: MaintenanceIdentity, a: WorkOrderRow): boolean {
  return (
    actor.user.id === a.reporterId ||
    managed(actor, a) ||
    (actor.user.id === a.assigneeId && allowed(actor, 'm3.repair', a))
  );
}
function safeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || id.includes('..'))
    throw new BadRequestException();
}
export async function audit(
  tx: Tx,
  workOrderId: string | null,
  actorId: string,
  action: string,
  data: unknown,
): Promise<void> {
  await tx.m3AuditEvent.create({
    data: { id: randomUUID(), workOrderId, actorId, action, data: json(data) },
  });
}
@Injectable()
export class M3Service {
  constructor(
    private readonly db: PrismaService,
    private readonly resources: MaintenanceGateway,
  ) {}
  private fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private receiptId(actor: MaintenanceIdentity, key: string | undefined): string {
    if (!key || !UUID.test(key))
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'A UUID Idempotency-Key is required',
      });
    return actor.user.id + ':' + key.toLowerCase();
  }
  private async replay<T>(id: string, fingerprint: string): Promise<T | undefined> {
    const old = await this.db.m3WriteReceipt.findUnique({ where: { id } });
    if (!old) return undefined;
    if (old.fingerprint !== fingerprint)
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was used with different content',
      });
    return old.result as unknown as T;
  }
  private async write<T>(
    id: string,
    fingerprint: string,
    operation: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        await lock(tx, 'm3-write:' + id);
        const old = await tx.m3WriteReceipt.findUnique({ where: { id } });
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'Idempotency key was used with different content',
            });
          return old.result as unknown as T;
        }
        const result = await operation(tx);
        await tx.m3WriteReceipt.create({ data: { id, fingerprint, result: json(result) } });
        return result;
      },
      { timeout: 10000 },
    );
  }
  private async current(
    tx: Tx,
    actor: MaintenanceIdentity,
    id: string,
    revision: number,
  ): Promise<WorkOrderRow> {
    await lock(tx, 'work-order:' + id);
    const row = await tx.m3WorkOrder.findUnique({ where: { id }, include: withWorkOrder });
    if (!row || !visible(actor, row)) throw new NotFoundException();
    if (row.revision !== revision)
      throw new ConflictException({
        code: 'STALE_WORK_ORDER',
        message: 'Work order changed; refresh before acting',
      });
    return row;
  }
  private requireState(row: WorkOrderRow, states: string[]): void {
    if (!states.includes(row.status))
      throw new ConflictException({
        code: 'WORK_ORDER_STATE_CONFLICT',
        message: 'This action is not allowed in the current state',
      });
  }
  private async load(tx: Tx, id: string): Promise<WorkOrderView> {
    return workOrderView(
      await tx.m3WorkOrder.findUniqueOrThrow({ where: { id }, include: withWorkOrder }),
    );
  }
  async create(
    actor: MaintenanceIdentity,
    authorization: string,
    key: string | undefined,
    input: CreateWorkOrderDto,
  ): Promise<WorkOrderView> {
    if (!permission(actor, 'm3.work-orders.create')) throw new ForbiddenException();
    safeId(input.roomId);
    safeId(input.policyId ?? 'default');
    const receipt = this.receiptId(actor, key),
      fingerprint = this.fingerprint([
        'create',
        input.roomId,
        input.category,
        input.description,
        input.policyId ?? 'default',
      ]);
    const old = await this.replay<WorkOrderView>(receipt, fingerprint);
    if (old) return old;
    const context = await this.resources.room(input.roomId, authorization);
    return this.write(receipt, fingerprint, async (tx) => {
      const policy = await tx.m3Policy.findFirst({
        where: { id: input.policyId ?? 'default' },
        orderBy: { revision: 'desc' },
      });
      if (!policy)
        throw new UnprocessableEntityException({
          code: 'MAINTENANCE_POLICY_MISSING',
          message: 'Maintenance policy is not configured',
        });
      const now = new Date(),
        id = randomUUID();
      await tx.m3WorkOrder.create({
        data: {
          id,
          roomId: input.roomId,
          departmentId: context.room.departmentId ?? null,
          reporterId: actor.user.id,
          category: input.category,
          description: input.description,
          policyId: policy.id,
          policyRevision: policy.revision,
          responseDeadlineAt: new Date(+now + policy.responseMinutes * 60000),
          escalationRecipientIds: json(context.escalationRecipientIds),
        },
      });
      await audit(tx, id, actor.user.id, 'work_order.created', {
        policyId: policy.id,
        policyRevision: policy.revision,
        revision: 1,
      });
      return this.load(tx, id);
    });
  }
  async get(actor: MaintenanceIdentity, id: string): Promise<WorkOrderView> {
    const a = await this.db.m3WorkOrder.findUnique({ where: { id }, include: withWorkOrder });
    if (!a || !visible(actor, a)) throw new NotFoundException();
    return workOrderView(a);
  }
  async list(
    actor: MaintenanceIdentity,
    query: WorkOrderQueryDto,
  ): Promise<{ items: WorkOrderView[]; nextCursor: string | null }> {
    if (
      query.view === 'managed' &&
      !['m3.dispatch', 'm3.accept', 'm3.cancel'].some((p) => permission(actor, p))
    )
      throw new ForbiddenException();
    if (query.view === 'assigned' && !permission(actor, 'm3.repair'))
      throw new ForbiddenException();
    const limit = query.limit ?? 50,
      items: WorkOrderView[] = [];
    let cursor = query.cursor;
    for (let batch = 0; batch < 5; batch++) {
      const rows = await this.db.m3WorkOrder.findMany({
        where: {
          ...(query.view === 'managed'
            ? {}
            : query.view === 'assigned'
              ? { assigneeId: actor.user.id }
              : { reporterId: actor.user.id }),
          ...(query.status ? { status: query.status } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        include: { policy: true, events: false },
        orderBy: { id: 'asc' },
        take: 100,
      });
      for (const row of rows) {
        cursor = row.id;
        const a = { ...row, events: [] };
        if (query.view === 'managed' ? managed(actor, a) : visible(actor, a))
          items.push(workOrderView(a, false));
        if (items.length === limit) return { items, nextCursor: cursor };
      }
      if (rows.length < 100) return { items, nextCursor: null };
    }
    return { items, nextCursor: cursor ?? null };
  }
  async assign(
    actor: MaintenanceIdentity,
    authorization: string,
    id: string,
    key: string | undefined,
    input: AssignWorkOrderDto,
  ): Promise<WorkOrderView> {
    if (!permission(actor, 'm3.dispatch')) throw new ForbiddenException();
    safeId(input.assigneeId);
    const receipt = this.receiptId(actor, key),
      fingerprint = this.fingerprint([
        'assign',
        id,
        input.assigneeId,
        input.reason,
        input.expectedRevision,
      ]);
    const old = await this.replay<WorkOrderView>(receipt, fingerprint);
    if (old) return old;
    const before = await this.db.m3WorkOrder.findUnique({ where: { id }, include: withWorkOrder });
    if (!before || !allowed(actor, 'm3.dispatch', before)) throw new NotFoundException();
    this.requireState(before, ['NEW', 'ASSIGNED']);
    const repairer = await this.resources.repairer(before.roomId, input.assigneeId, authorization);
    return this.write(receipt, fingerprint, async (tx) => {
      const a = await this.current(tx, actor, id, input.expectedRevision);
      if (a.roomId !== before.roomId || !allowed(actor, 'm3.dispatch', a))
        throw new ForbiddenException();
      this.requireState(a, ['NEW', 'ASSIGNED']);
      const revision = bump(a.revision);
      await tx.m3WorkOrder.update({
        where: { id },
        data: {
          status: 'ASSIGNED',
          assigneeId: repairer.userId,
          assigneeName: repairer.displayName,
          revision,
          escalationRecipientIds: json([
            ...new Set([...recipientIds(a.escalationRecipientIds), actor.user.id]),
          ]),
        },
      });
      await tx.m3Assignment.create({
        data: {
          id: randomUUID(),
          workOrderId: id,
          revision,
          assigneeId: repairer.userId,
          assigneeName: repairer.displayName,
          assignedBy: actor.user.id,
          reason: input.reason,
        },
      });
      await audit(tx, id, actor.user.id, 'work_order.assigned', {
        assigneeId: repairer.userId,
        previousAssigneeId: a.assigneeId,
        reason: input.reason,
        revision,
      });
      return this.load(tx, id);
    });
  }
  async start(
    actor: MaintenanceIdentity,
    id: string,
    key: string | undefined,
    input: WorkOrderActionDto,
  ): Promise<WorkOrderView> {
    if (!permission(actor, 'm3.repair')) throw new ForbiddenException();
    return this.write(
      this.receiptId(actor, key),
      this.fingerprint(['start', id, input.reason, input.expectedRevision]),
      async (tx) => {
        const a = await this.current(tx, actor, id, input.expectedRevision);
        if (actor.user.id !== a.assigneeId || !allowed(actor, 'm3.repair', a))
          throw new ForbiddenException();
        this.requireState(a, ['ASSIGNED', 'SYNC_FAILED']);
        // Reserve the worker confirmation revision before writing an asynchronous intent.
        bump(bump(a.revision));
        const revision = bump(a.revision),
          startsAt = new Date(),
          operationId = randomUUID();
        await tx.m3WorkOrder.update({
          where: { id },
          data: {
            status: 'BLOCK_PENDING',
            revision,
            repairerId: actor.user.id,
            blockStartsAt: startsAt,
            syncError: null,
          },
        });
        await tx.m3Outbox.create({
          data: {
            operationId,
            workOrderId: id,
            workOrderRevision: revision,
            kind: 'BLOCK',
            actorId: actor.user.id,
            reason: input.reason,
            startsAt,
          },
        });
        await audit(tx, id, actor.user.id, 'work_order.start_requested', {
          operationId,
          reason: input.reason,
          revision,
          startsAt: startsAt.toISOString(),
        });
        return this.load(tx, id);
      },
    );
  }
  async complete(
    actor: MaintenanceIdentity,
    id: string,
    key: string | undefined,
    input: WorkOrderActionDto,
  ): Promise<WorkOrderView> {
    if (!permission(actor, 'm3.repair')) throw new ForbiddenException();
    return this.write(
      this.receiptId(actor, key),
      this.fingerprint(['complete', id, input.reason, input.expectedRevision]),
      async (tx) => {
        const a = await this.current(tx, actor, id, input.expectedRevision);
        if (
          actor.user.id !== a.assigneeId ||
          actor.user.id !== a.repairerId ||
          !allowed(actor, 'm3.repair', a)
        )
          throw new ForbiddenException();
        this.requireState(a, ['IN_REPAIR']);
        const revision = bump(a.revision);
        await tx.m3WorkOrder.update({
          where: { id },
          data: {
            status: 'AWAITING_ACCEPTANCE',
            revision,
            acceptanceDeadlineAt: new Date(Date.now() + a.policy.acceptanceMinutes * 60000),
          },
        });
        await audit(tx, id, actor.user.id, 'work_order.completed', {
          reason: input.reason,
          round: a.repairRound,
          revision,
        });
        return this.load(tx, id);
      },
    );
  }
  async accept(
    actor: MaintenanceIdentity,
    id: string,
    key: string | undefined,
    input: AcceptWorkOrderDto,
  ): Promise<WorkOrderView> {
    if (!permission(actor, 'm3.accept')) throw new ForbiddenException();
    return this.write(
      this.receiptId(actor, key),
      this.fingerprint(['accept', id, input.accepted, input.comment, input.expectedRevision]),
      async (tx) => {
        const a = await this.current(tx, actor, id, input.expectedRevision);
        if (!allowed(actor, 'm3.accept', a) || actor.user.id === a.repairerId)
          throw new ForbiddenException({
            code: 'INDEPENDENT_ACCEPTOR_REQUIRED',
            message: 'An eligible person who did not perform this repair must accept it',
          });
        this.requireState(a, ['AWAITING_ACCEPTANCE']);
        if (input.accepted) bump(bump(a.revision));
        const revision = bump(a.revision);
        if (input.accepted) {
          const operationId = randomUUID();
          await tx.m3WorkOrder.update({
            where: { id },
            data: { status: 'RELEASE_PENDING', revision, syncError: null },
          });
          await tx.m3Outbox.create({
            data: {
              operationId,
              workOrderId: id,
              workOrderRevision: revision,
              kind: 'RELEASE',
              actorId: actor.user.id,
              reason: input.comment,
            },
          });
          await audit(tx, id, actor.user.id, 'work_order.accepted', {
            comment: input.comment,
            operationId,
            revision,
          });
        } else {
          await tx.m3WorkOrder.update({
            where: { id },
            data: {
              status: 'IN_REPAIR',
              revision,
              repairRound: bump(a.repairRound),
              repairDeadlineAt: new Date(Date.now() + a.policy.repairMinutes * 60000),
              acceptanceDeadlineAt: null,
            },
          });
          await audit(tx, id, actor.user.id, 'work_order.acceptance_rejected', {
            comment: input.comment,
            round: a.repairRound,
            revision,
          });
        }
        return this.load(tx, id);
      },
    );
  }
  async cancel(
    actor: MaintenanceIdentity,
    id: string,
    key: string | undefined,
    input: WorkOrderActionDto,
  ): Promise<WorkOrderView> {
    return this.write(
      this.receiptId(actor, key),
      this.fingerprint(['cancel', id, input.reason, input.expectedRevision]),
      async (tx) => {
        const a = await this.current(tx, actor, id, input.expectedRevision);
        if (!ownerActionAllowed(actor, 'm3.cancel', a)) throw new ForbiddenException();
        this.requireState(a, ['NEW', 'ASSIGNED']);
        const revision = bump(a.revision);
        await tx.m3WorkOrder.update({ where: { id }, data: { status: 'CANCELLED', revision } });
        await audit(tx, id, actor.user.id, 'work_order.cancelled', {
          reason: input.reason,
          revision,
        });
        return this.load(tx, id);
      },
    );
  }
  async rate(
    actor: MaintenanceIdentity,
    id: string,
    key: string | undefined,
    input: RateWorkOrderDto,
  ): Promise<WorkOrderView> {
    if (!permission(actor, 'm3.rate')) throw new ForbiddenException();
    return this.write(
      this.receiptId(actor, key),
      this.fingerprint(['rate', id, input.score, input.comment, input.expectedRevision]),
      async (tx) => {
        const a = await this.current(tx, actor, id, input.expectedRevision);
        if (a.reporterId !== actor.user.id) throw new NotFoundException();
        if (!ownerActionAllowed(actor, 'm3.rate', a)) throw new ForbiddenException();
        this.requireState(a, ['CLOSED']);
        if (a.rating !== null)
          throw new ConflictException({
            code: 'WORK_ORDER_ALREADY_RATED',
            message: 'A work order may be rated once',
          });
        const revision = bump(a.revision);
        await tx.m3WorkOrder.update({
          where: { id },
          data: { rating: input.score, ratingComment: input.comment, revision },
        });
        await audit(tx, id, actor.user.id, 'work_order.rated', {
          score: input.score,
          comment: input.comment,
          revision,
        });
        return this.load(tx, id);
      },
    );
  }
  async policies(actor: MaintenanceIdentity, query: MaintenancePolicyQueryDto) {
    if (!permission(actor, 'm3.policies.read') && !permission(actor, 'm3.policies.write', 'ALL'))
      throw new ForbiddenException();
    if (query.cursor) safeId(query.cursor);
    const limit = query.limit ?? 50;
    const rows = await this.db.$queryRaw<MaintenancePolicyRow[]>(Prisma.sql`
   SELECT DISTINCT ON ("id") * FROM "m3_policy"
   ${query.cursor ? Prisma.sql`WHERE "id">${query.cursor}` : Prisma.empty}
   ORDER BY "id" ASC,"revision" DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    return {
      items: page.map(policyView),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
  async setPolicy(
    actor: MaintenanceIdentity,
    id: string,
    key: string | undefined,
    input: SetMaintenancePolicyDto,
  ) {
    if (!permission(actor, 'm3.policies.write', 'ALL')) throw new ForbiddenException();
    safeId(id);
    if (id !== input.id)
      throw new BadRequestException({
        code: 'POLICY_ID_MISMATCH',
        message: 'Policy path and body must agree',
      });
    const receipt = this.receiptId(actor, key),
      fingerprint = this.fingerprint([
        'policy',
        id,
        input.name,
        input.responseMinutes,
        input.repairMinutes,
        input.acceptanceMinutes,
        input.expectedRevision,
      ]);
    return this.write(receipt, fingerprint, async (tx) => {
      await lock(tx, 'maintenance-policy:' + id);
      const current = await tx.m3Policy.findFirst({ where: { id }, orderBy: { revision: 'desc' } });
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictException({
          code: 'STALE_POLICY',
          message: 'Policy changed; refresh before editing',
        });
      const a = await tx.m3Policy.create({
        data: {
          id,
          revision: bump(input.expectedRevision),
          name: input.name,
          responseMinutes: input.responseMinutes,
          repairMinutes: input.repairMinutes,
          acceptanceMinutes: input.acceptanceMinutes,
          createdBy: actor.user.id,
        },
      });
      await audit(tx, null, actor.user.id, 'policy.version_created', {
        policyId: id,
        revision: a.revision,
      });
      return policyView(a);
    });
  }
}
