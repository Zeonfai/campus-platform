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
import { ResourceGateway, type WorkflowIdentity } from './resource.gateway.js';
import type {
  ApplicationQueryDto,
  CreateApplicationDto,
  DecisionDto,
  PolicyStepDto,
  PolicyQueryDto,
  SetPolicyDto,
  WithdrawDto,
} from './m2.dto.js';

type Tx = Prisma.TransactionClient;
export type ApplicationRow = Prisma.M2ApplicationGetPayload<{ include: { steps: true } }>;
export type PolicyRow = Prisma.M2PolicyGetPayload<Record<string, never>>;
export type ApplicationView = ReturnType<typeof applicationView>;
export const withSteps = { steps: { orderBy: { position: 'asc' as const } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function lock(tx: Tx, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key},0))`;
}
export function applicationView(a: ApplicationRow) {
  return {
    id: a.id,
    roomId: a.roomId,
    applicantId: a.applicantId,
    departmentId: a.departmentId,
    purpose: a.purpose,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    status: a.status,
    revision: a.revision,
    deadlineAt: a.deadlineAt.toISOString(),
    policyId: a.policyId,
    policyRevision: a.policyRevision,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    syncError: a.syncError,
    steps: a.steps.map((s) => ({
      id: s.id,
      position: s.position,
      roleId: s.roleId,
      scope: s.scope,
      status: s.status,
      decidedBy: s.decidedBy,
      comment: s.comment,
      decidedAt: s.decidedAt?.toISOString() ?? null,
    })),
  };
}
function stepsFrom(value: Prisma.JsonValue): PolicyStepDto[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 10)
    throw new UnprocessableEntityException({
      code: 'POLICY_INVALID',
      message: 'Approval policy is not usable',
    });
  return value.map((v) => {
    if (
      typeof v !== 'object' ||
      v === null ||
      Array.isArray(v) ||
      typeof v.roleId !== 'string' ||
      !['DEPARTMENT', 'MANAGED_ROOMS', 'ALL'].includes(String(v.scope))
    )
      throw new UnprocessableEntityException({
        code: 'POLICY_INVALID',
        message: 'Approval policy is not usable',
      });
    return { roleId: v.roleId, scope: v.scope as PolicyStepDto['scope'] };
  });
}
function policyView(policy: PolicyRow) {
  return {
    id: policy.id,
    name: policy.name,
    revision: policy.revision,
    timeoutMinutes: policy.timeoutMinutes,
    steps: stepsFrom(policy.steps),
  };
}
function permission(actor: WorkflowIdentity, id: string, scope?: string): boolean {
  return actor.grants.some((g) => g.permission === id && (!scope || g.scope === scope));
}
function scopeMatches(actor: WorkflowIdentity, scope: string, a: ApplicationRow): boolean {
  if (scope === 'ALL') return true;
  if (scope === 'DEPARTMENT')
    return !!actor.user.departmentId && actor.user.departmentId === a.departmentId;
  if (scope === 'MANAGED_ROOMS') return actor.managedRoomIds.includes(a.roomId);
  return false;
}
function stepAllowed(
  actor: WorkflowIdentity,
  a: ApplicationRow,
  step: ApplicationRow['steps'][number],
): boolean {
  return (
    actor.user.id !== a.applicantId &&
    actor.roleIds.includes(step.roleId) &&
    scopeMatches(actor, step.scope, a) &&
    actor.grants.some(
      (g) => g.permission === 'm2.approvals.decide' && scopeMatches(actor, g.scope, a),
    )
  );
}
function canView(actor: WorkflowIdentity, a: ApplicationRow): boolean {
  if (actor.user.id === a.applicantId) return true;
  const current = a.status === 'PENDING' ? a.steps.find((s) => s.status === 'PENDING') : undefined;
  return a.steps.some(
    (s) => stepAllowed(actor, a, s) && (s.id === current?.id || s.decidedBy === actor.user.id),
  );
}
function safeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) || value.includes('..'))
    throw new BadRequestException();
}
function interval(input: CreateApplicationDto): { start: Date; end: Date } {
  const start = new Date(input.startsAt),
    end = new Date(input.endsAt);
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    +start % 3600000 ||
    +end % 3600000 ||
    +end <= +start ||
    +end - +start > 86400000
  )
    throw new BadRequestException({
      code: 'INVALID_INTERVAL',
      message: 'Use whole-hour intervals of at most 24 hours',
    });
  const day = (v: number) => Math.floor((v + 28800000) / 86400000);
  if (day(+start) !== day(+end - 1))
    throw new BadRequestException({
      code: 'INVALID_INTERVAL',
      message: 'Use one Shanghai calendar day',
    });
  return { start, end };
}
function bump(revision: number): number {
  if (revision >= 2147483647)
    throw new ConflictException({ code: 'REVISION_EXHAUSTED', message: 'Revision exhausted' });
  return revision + 1;
}
export async function audit(
  tx: Tx,
  applicationId: string | null,
  actorId: string,
  action: string,
  data: unknown,
): Promise<void> {
  await tx.m2AuditEvent.create({
    data: { id: randomUUID(), applicationId, actorId, action, data: json(data) },
  });
}
export async function releaseApplication(
  tx: Tx,
  a: ApplicationRow,
  target: 'WITHDRAWN' | 'EXPIRED',
  actorId: string,
  reason: string,
): Promise<ApplicationRow> {
  const next = bump(a.revision),
    remote = a.status !== 'PENDING';
  await tx.m2Application.update({
    where: { id: a.id },
    data: {
      status: remote ? 'RELEASE_PENDING' : target,
      targetStatus: remote ? target : null,
      revision: next,
      syncError: null,
    },
  });
  if (remote)
    await tx.m2Outbox.create({
      data: {
        operationId: randomUUID(),
        applicationId: a.id,
        applicationRevision: next,
        kind: 'RELEASE',
        actorId,
        reason,
      },
    });
  await audit(
    tx,
    a.id,
    actorId,
    target === 'EXPIRED' ? 'application.expiry_requested' : 'application.withdraw_requested',
    { revision: next, remote },
  );
  return tx.m2Application.findUniqueOrThrow({ where: { id: a.id }, include: withSteps });
}
export async function expireApplication(
  tx: Tx,
  a: ApplicationRow,
  now: Date,
): Promise<ApplicationRow> {
  if (
    a.deadlineAt > now ||
    !['PENDING', 'SYNCING', 'SYNC_FAILED'].includes(a.status) ||
    a.targetStatus
  )
    return a;
  const intent = await tx.m2Outbox.findFirst({
    where: { applicationId: a.id, kind: 'OCCUPY' },
    orderBy: { applicationRevision: 'desc' },
  });
  return releaseApplication(
    tx,
    a,
    'EXPIRED',
    intent?.actorId ?? a.applicantId,
    'Approval deadline expired',
  );
}
@Injectable()
export class M2Service {
  constructor(
    private readonly db: PrismaService,
    private readonly resources: ResourceGateway,
  ) {}
  private fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private receiptId(actor: WorkflowIdentity, key: string | undefined): string {
    if (!key || !UUID.test(key))
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'A UUID Idempotency-Key is required',
      });
    return actor.user.id + ':' + key.toLowerCase();
  }
  private async replay(id: string, fingerprint: string): Promise<ApplicationView | undefined> {
    const old = await this.db.m2WriteReceipt.findUnique({ where: { id } });
    if (!old) return undefined;
    if (old.fingerprint !== fingerprint)
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was used with different content',
      });
    return old.result as unknown as ApplicationView;
  }
  private async write(
    id: string,
    fingerprint: string,
    operation: (tx: Tx) => Promise<ApplicationRow>,
  ): Promise<ApplicationView> {
    return this.db.$transaction(
      async (tx) => {
        await lock(tx, 'write:' + id);
        const old = await tx.m2WriteReceipt.findUnique({ where: { id } });
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'Idempotency key was used with different content',
            });
          return old.result as unknown as ApplicationView;
        }
        const result = applicationView(await operation(tx));
        await tx.m2WriteReceipt.create({ data: { id, fingerprint, result: json(result) } });
        return result;
      },
      { timeout: 10000 },
    );
  }
  async create(
    actor: WorkflowIdentity,
    authorization: string,
    key: string | undefined,
    input: CreateApplicationDto,
  ): Promise<ApplicationView> {
    if (!permission(actor, 'm2.applications.create')) throw new ForbiddenException();
    safeId(input.roomId);
    safeId(input.policyId ?? 'default');
    const { start, end } = interval(input),
      policyId = input.policyId ?? 'default';
    const id = this.receiptId(actor, key),
      fingerprint = this.fingerprint([
        'create',
        input.roomId,
        start.toISOString(),
        end.toISOString(),
        input.purpose,
        policyId,
      ]);
    const old = await this.replay(id, fingerprint);
    if (old) return old;
    await this.resources.room(input.roomId, authorization);
    return this.write(id, fingerprint, async (tx) => {
      const now = new Date();
      if (start <= now)
        throw new BadRequestException({
          code: 'INVALID_INTERVAL',
          message: 'Only future intervals can be requested',
        });
      const policy = await tx.m2Policy.findFirst({
        where: { id: policyId },
        orderBy: { revision: 'desc' },
      });
      if (!policy)
        throw new UnprocessableEntityException({
          code: 'POLICY_MISSING',
          message: 'Approval policy is not configured',
        });
      const steps = stepsFrom(policy.steps);
      if (!actor.user.departmentId && steps.some((s) => s.scope === 'DEPARTMENT'))
        throw new ForbiddenException({
          code: 'DEPARTMENT_REQUIRED',
          message: 'An applicant department is required',
        });
      const deadlineAt = new Date(Math.min(+now + policy.timeoutMinutes * 60000, +start));
      const app = await tx.m2Application.create({
        data: {
          id: randomUUID(),
          roomId: input.roomId,
          applicantId: actor.user.id,
          departmentId: actor.user.departmentId ?? null,
          purpose: input.purpose,
          startsAt: start,
          endsAt: end,
          deadlineAt,
          policyId,
          policyRevision: policy.revision,
          steps: { create: steps.map((s, i) => ({ id: randomUUID(), position: i + 1, ...s })) },
        },
        include: withSteps,
      });
      await audit(tx, app.id, actor.user.id, 'application.created', {
        policyId,
        policyRevision: policy.revision,
        revision: app.revision,
      });
      return app;
    });
  }
  async get(actor: WorkflowIdentity, id: string): Promise<ApplicationView> {
    return this.db.$transaction(async (tx) => {
      await lock(tx, 'application:' + id);
      let app = await tx.m2Application.findUnique({ where: { id }, include: withSteps });
      if (!app || !canView(actor, app)) throw new NotFoundException();
      app = await expireApplication(tx, app, new Date());
      return applicationView(app);
    });
  }
  async list(
    actor: WorkflowIdentity,
    query: ApplicationQueryDto,
  ): Promise<{ items: ApplicationView[]; nextCursor: string | null }> {
    if (query.view === 'approvals' && !permission(actor, 'm2.approvals.decide'))
      throw new ForbiddenException();
    const limit = query.limit ?? 50,
      items: ApplicationView[] = [];
    let cursor = query.cursor;
    for (let batch = 0; batch < 5; batch++) {
      const rows = await this.db.m2Application.findMany({
        where: {
          ...(query.view === 'approvals' ? {} : { applicantId: actor.user.id }),
          ...(query.status ? { status: query.status } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        include: withSteps,
        orderBy: { id: 'asc' },
        take: 100,
      });
      for (const row of rows) {
        cursor = row.id;
        if (query.view !== 'approvals' || canView(actor, row)) items.push(applicationView(row));
        if (items.length === limit) return { items, nextCursor: cursor };
      }
      if (rows.length < 100) return { items, nextCursor: null };
    }
    return { items, nextCursor: cursor ?? null };
  }
  async decide(
    actor: WorkflowIdentity,
    applicationId: string,
    stepId: string,
    key: string | undefined,
    input: DecisionDto,
  ): Promise<ApplicationView> {
    if (!permission(actor, 'm2.approvals.decide')) throw new ForbiddenException();
    const receipt = this.receiptId(actor, key),
      fingerprint = this.fingerprint([
        'decide',
        applicationId,
        stepId,
        input.decision,
        input.comment,
        input.expectedRevision,
      ]);
    return this.write(receipt, fingerprint, async (tx) => {
      await lock(tx, 'application:' + applicationId);
      const app = await tx.m2Application.findUnique({
        where: { id: applicationId },
        include: withSteps,
      });
      if (!app || !canView(actor, app)) throw new NotFoundException();
      if (app.deadlineAt <= new Date())
        throw new ConflictException({
          code: 'APPROVAL_DEADLINE_PASSED',
          message: 'Approval deadline has passed',
        });
      if (app.status !== 'PENDING' || app.revision !== input.expectedRevision)
        throw new ConflictException({
          code: 'STALE_APPLICATION',
          message: 'Application changed; refresh before deciding',
        });
      const step = app.steps.find((s) => s.status === 'PENDING');
      if (!step || step.id !== stepId)
        throw new ConflictException({
          code: 'NOT_CURRENT_STEP',
          message: 'Only the current step can be decided',
        });
      if (!stepAllowed(actor, app, step) || app.steps.some((s) => s.decidedBy === actor.user.id))
        throw new ForbiddenException({
          code: 'APPROVER_NOT_ELIGIBLE',
          message: 'A different eligible approver is required',
        });
      await tx.m2Step.update({
        where: { id: stepId },
        data: {
          status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decidedBy: actor.user.id,
          comment: input.comment,
          decidedAt: new Date(),
        },
      });
      const final = input.decision === 'APPROVE' && step.position === app.steps.length;
      const status = input.decision === 'REJECT' ? 'REJECTED' : final ? 'SYNCING' : 'PENDING',
        revision = bump(app.revision);
      await tx.m2Application.update({ where: { id: applicationId }, data: { status, revision } });
      if (final)
        await tx.m2Outbox.create({
          data: {
            operationId: randomUUID(),
            applicationId,
            applicationRevision: revision,
            kind: 'OCCUPY',
            actorId: actor.user.id,
            reason: 'Final approval confirmed',
          },
        });
      await audit(tx, applicationId, actor.user.id, 'application.step_decided', {
        stepId,
        decision: input.decision,
        revision,
      });
      return tx.m2Application.findUniqueOrThrow({
        where: { id: applicationId },
        include: withSteps,
      });
    });
  }
  async withdraw(
    actor: WorkflowIdentity,
    applicationId: string,
    key: string | undefined,
    input: WithdrawDto,
  ): Promise<ApplicationView> {
    const receipt = this.receiptId(actor, key),
      fingerprint = this.fingerprint([
        'withdraw',
        applicationId,
        input.reason,
        input.expectedRevision,
      ]);
    return this.write(receipt, fingerprint, async (tx) => {
      await lock(tx, 'application:' + applicationId);
      const app = await tx.m2Application.findUnique({
        where: { id: applicationId },
        include: withSteps,
      });
      if (!app || app.applicantId !== actor.user.id) throw new NotFoundException();
      if (
        app.revision !== input.expectedRevision ||
        app.startsAt <= new Date() ||
        !['PENDING', 'SYNCING', 'APPROVED', 'SYNC_FAILED'].includes(app.status) ||
        app.targetStatus
      )
        throw new ConflictException({
          code: 'WITHDRAWAL_NOT_ALLOWED',
          message: 'Application cannot be withdrawn in its current state',
        });
      return releaseApplication(tx, app, 'WITHDRAWN', actor.user.id, input.reason);
    });
  }
  async policies(
    actor: WorkflowIdentity,
    query: PolicyQueryDto,
  ): Promise<{ items: ReturnType<typeof policyView>[]; nextCursor: string | null }> {
    if (!permission(actor, 'm2.policies.read') && !permission(actor, 'm2.policies.write', 'ALL'))
      throw new ForbiddenException();
    if (query.cursor) safeId(query.cursor);
    const limit = query.limit ?? 50;
    const rows = await this.db.$queryRaw<PolicyRow[]>(Prisma.sql`
      SELECT DISTINCT ON ("id") * FROM "m2_policy"
      ${query.cursor ? Prisma.sql`WHERE "id">${query.cursor}` : Prisma.empty}
      ORDER BY "id" ASC,"revision" DESC LIMIT ${limit + 1}
    `);
    const page = rows.slice(0, limit);
    return {
      items: page.map(policyView),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
  async setPolicy(
    actor: WorkflowIdentity,
    id: string,
    key: string | undefined,
    input: SetPolicyDto,
  ): Promise<ReturnType<typeof policyView>> {
    if (!permission(actor, 'm2.policies.write', 'ALL')) throw new ForbiddenException();
    safeId(id);
    if (id !== input.id)
      throw new BadRequestException({
        code: 'POLICY_ID_MISMATCH',
        message: 'Policy path and body must agree',
      });
    for (const step of input.steps) safeId(step.roleId);
    if (new Set(input.steps.map((s) => s.roleId)).size !== input.steps.length)
      throw new BadRequestException({
        code: 'DUPLICATE_POLICY_ROLE',
        message: 'Each step must require a distinct role',
      });
    const receipt = this.receiptId(actor, key);
    const fingerprint = this.fingerprint([
      'setPolicy',
      id,
      input.name,
      input.timeoutMinutes,
      input.steps.map((step) => [step.roleId, step.scope]),
      input.expectedRevision,
    ]);
    return this.db.$transaction(async (tx) => {
      await lock(tx, 'write:' + receipt);
      const old = await tx.m2WriteReceipt.findUnique({ where: { id: receipt } });
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency key was used with different content',
          });
        return old.result as unknown as ReturnType<typeof policyView>;
      }
      await lock(tx, 'policy:' + id);
      const current = await tx.m2Policy.findFirst({ where: { id }, orderBy: { revision: 'desc' } });
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictException({
          code: 'STALE_POLICY',
          message: 'Policy changed; refresh before editing',
        });
      const result = await tx.m2Policy.create({
        data: {
          id,
          revision: bump(input.expectedRevision),
          name: input.name,
          timeoutMinutes: input.timeoutMinutes,
          steps: json(input.steps),
          createdBy: actor.user.id,
        },
      });
      await audit(tx, null, actor.user.id, 'policy.version_created', {
        policyId: id,
        revision: result.revision,
      });
      const view = policyView(result);
      await tx.m2WriteReceipt.create({ data: { id: receipt, fingerprint, result: json(view) } });
      return view;
    });
  }
}
