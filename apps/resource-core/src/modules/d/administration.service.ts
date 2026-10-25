import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../platform/prisma.service.js';
import { transactionLock } from '../../platform/transaction.js';
import { ResourceDirectoryService, type CoreTransaction } from './resource-directory.service.js';
import { roomScope } from './directory.service.js';
import { asIdentity, identityInclude, type Identity } from './identity.service.js';
import type { PageDto } from './identity.dto.js';
import type {
  AuditQueryDto,
  DepartmentWriteDto,
  RoleWriteDto,
  RoomWriteDto,
  SeatWriteDto,
  UserAccessWriteDto,
  OpeningRulesWriteDto,
} from './administration.dto.js';

type Outcome = { targetId: string; value: unknown; reason?: string };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
@Injectable()
export class AdministrationService {
  constructor(
    private readonly db: PrismaService,
    private readonly resources: ResourceDirectoryService,
  ) {}
  private global(identity: Identity, permission: string) {
    if (!identity.grants.some((g) => g.permission === permission && g.scope === 'ALL'))
      throw new ForbiddenException('Global authority for this permission is required');
  }
  private createRevision(value?: number) {
    if (value !== undefined && value !== 0)
      throw new BadRequestException('Creation requires an omitted or zero expectedRevision');
  }
  private revision(actual: number, expected: number | undefined) {
    if (!Number.isInteger(expected) || expected === undefined || expected < 1)
      throw new BadRequestException('Update requires expectedRevision');
    if (actual !== expected)
      throw new ConflictException('Resource changed; reload before updating');
    if (actual >= 2147483647) throw new ConflictException('Revision limit reached');
  }
  private async write(
    identity: Identity,
    permission: string,
    global: boolean,
    action: string,
    target: string | null,
    input: unknown,
    key: string,
    traceId: string,
    change: (tx: CoreTransaction, actor: Identity) => Promise<Outcome>,
    authorize?: (tx: CoreTransaction, actor: Identity) => Promise<void>,
  ) {
    if (!isUUID(key)) throw new BadRequestException('Idempotency-Key must be a UUID');
    const id = identity.user.id + ':' + key;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(canonical([action, target, input])))
      .digest('hex');
    try {
      return await this.db.$transaction(
        async (tx) => {
          await transactionLock(tx, 'd-write:' + id);
          // All management mutations share the authorization lock with role/access writes.
          await transactionLock(tx, 'd-security-admin');
          const actor = await this.resources.actor(tx, identity.user.id);
          if (global) this.global(actor, permission);
          else if (!actor.grants.some((g) => g.permission === permission))
            throw new ForbiddenException('Permission required');
          if (!global && !authorize)
            throw new ForbiddenException('Management scope check is required');
          if (authorize) await authorize(tx, actor);
          const old = await tx.dWriteReceipt.findUnique({ where: { id } });
          if (old) {
            if (old.fingerprint !== fingerprint)
              throw new ConflictException('Idempotency key payload mismatch');
            return old.result;
          }
          const outcome = await change(tx, actor);
          const result = JSON.parse(JSON.stringify(outcome.value)) as Prisma.InputJsonValue;
          await tx.dWriteReceipt.create({ data: { id, fingerprint, result } });
          await tx.dAuditEvent.create({
            data: {
              id: randomUUID(),
              actorId: actor.user.id,
              action,
              targetId: outcome.targetId,
              traceId,
              reason: outcome.reason ?? null,
            },
          });
          return result;
        },
        { timeout: 15000 },
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === 'P2002')
          throw new ConflictException('Directory name or code already exists');
        if (error.code === 'P2003')
          throw new BadRequestException('Referenced directory entry is invalid');
        if (error.code === 'P2025') throw new NotFoundException('Directory entry not found');
      }
      throw error;
    }
  }
  private grantCeiling(actor: Identity, permissionIds: string[]) {
    if (
      permissionIds.some((p) => !actor.grants.some((g) => g.permission === p && g.scope === 'ALL'))
    )
      throw new ForbiddenException(
        'Cannot grant permissions beyond the actor full-domain authority',
      );
  }
  private async permissions(tx: CoreTransaction, ids: string[]) {
    if ((await tx.dPermission.count({ where: { id: { in: ids } } })) !== ids.length)
      throw new BadRequestException('Unknown permission');
  }
  private async adminRemains(tx: CoreTransaction) {
    const administrator = await tx.dUser.findFirst({
      where: {
        enabled: true,
        AND: ['d.users.write', 'd.roles.write'].map((permissionId) => ({
          roles: { some: { role: { scope: 'ALL', permissions: { some: { permissionId } } } } },
        })),
      },
      select: { id: true },
    });
    if (!administrator)
      throw new ConflictException(
        'At least one active global access and role administrator must remain',
      );
  }
  createDepartment(identity: Identity, input: DepartmentWriteDto, key: string, traceId: string) {
    this.createRevision(input.expectedRevision);
    return this.write(
      identity,
      'd.departments.write',
      true,
      'd.department.created',
      null,
      input,
      key,
      traceId,
      async (tx) => {
        const row = await tx.dDepartment.create({ data: { id: randomUUID(), name: input.name } });
        return { targetId: row.id, value: row };
      },
    );
  }
  updateDepartment(
    identity: Identity,
    id: string,
    input: DepartmentWriteDto,
    key: string,
    traceId: string,
  ) {
    return this.write(
      identity,
      'd.departments.write',
      true,
      'd.department.updated',
      id,
      input,
      key,
      traceId,
      async (tx) => {
        const current = await tx.dDepartment.findUnique({ where: { id } });
        if (!current) throw new NotFoundException('Department not found');
        this.revision(current.revision, input.expectedRevision);
        const row = await tx.dDepartment.update({
          where: { id },
          data: { name: input.name, revision: current.revision + 1 },
        });
        return { targetId: id, value: row };
      },
    );
  }
  createRole(identity: Identity, input: RoleWriteDto, key: string, traceId: string) {
    this.createRevision(input.expectedRevision);
    return this.write(
      identity,
      'd.roles.write',
      true,
      'd.role.created',
      null,
      input,
      key,
      traceId,
      async (tx, actor) => {
        await this.permissions(tx, input.permissionIds);
        this.grantCeiling(actor, input.permissionIds);
        const row = await tx.dRole.create({
          data: {
            id: randomUUID(),
            name: input.name,
            scope: input.scope,
            permissions: { create: input.permissionIds.map((permissionId) => ({ permissionId })) },
          },
        });
        return {
          targetId: row.id,
          value: { ...row, permissionIds: [...input.permissionIds].sort() },
        };
      },
    );
  }
  updateRole(identity: Identity, id: string, input: RoleWriteDto, key: string, traceId: string) {
    return this.write(
      identity,
      'd.roles.write',
      true,
      'd.role.updated',
      id,
      input,
      key,
      traceId,
      async (tx, actor) => {
        const current = await tx.dRole.findUnique({
          where: { id },
          include: { permissions: true, users: true },
        });
        if (!current) throw new NotFoundException('Role not found');
        this.revision(current.revision, input.expectedRevision);
        await this.permissions(tx, input.permissionIds);
        this.grantCeiling(actor, input.permissionIds);
        await tx.dRolePermission.deleteMany({ where: { roleId: id } });
        const row = await tx.dRole.update({
          where: { id },
          data: {
            name: input.name,
            scope: input.scope,
            revision: current.revision + 1,
            permissions: { create: input.permissionIds.map((permissionId) => ({ permissionId })) },
          },
        });
        await this.adminRemains(tx);
        // A role mutation revokes old sessions conservatively, even for a name-only edit.
        await tx.dSession.updateMany({
          where: { userId: { in: current.users.map((u) => u.userId) }, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return { targetId: id, value: { ...row, permissionIds: [...input.permissionIds].sort() } };
      },
    );
  }
  async users(identity: Identity, query: PageDto) {
    this.global(identity, 'd.users.read');
    const rows = await this.db.dUser.findMany({
      where: query.cursor ? { id: { gt: query.cursor } } : {},
      include: identityInclude,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((row) => ({
        ...asIdentity(row).user,
        username: row.username,
        revision: row.revision,
        roleIds: row.roles.map((r) => r.roleId).sort(),
        managedRoomIds: row.managedRooms.map((r) => r.roomId).sort(),
      })),
      nextCursor: rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null,
    };
  }
  updateUserAccess(
    identity: Identity,
    id: string,
    input: UserAccessWriteDto,
    key: string,
    traceId: string,
  ) {
    if (id === identity.user.id)
      throw new ForbiddenException('Self access changes are not allowed');
    return this.write(
      identity,
      'd.users.write',
      true,
      'd.user.access-updated',
      id,
      input,
      key,
      traceId,
      async (tx, actor) => {
        const current = await tx.dUser.findUnique({ where: { id }, include: identityInclude });
        if (!current) throw new NotFoundException('User not found');
        this.revision(current.revision, input.expectedRevision);
        const roles = await tx.dRole.findMany({
          where: { id: { in: input.roleIds } },
          include: { permissions: true },
        });
        if (roles.length !== input.roleIds.length) throw new BadRequestException('Unknown role');
        if (
          (await tx.dRoom.count({ where: { id: { in: input.managedRoomIds } } })) !==
          input.managedRoomIds.length
        )
          throw new BadRequestException('Unknown managed room');
        const previousRoles = new Set(current.roles.map((r) => r.roleId));
        const previousRooms = new Set(current.managedRooms.map((r) => r.roomId));
        const expandingRooms = input.managedRoomIds.some((room) => !previousRooms.has(room));
        const reenabled = !current.enabled && input.enabled;
        for (const role of roles) {
          if (
            reenabled ||
            !previousRoles.has(role.id) ||
            (expandingRooms && role.scope === 'MANAGED_ROOMS')
          )
            this.grantCeiling(
              actor,
              role.permissions.map((p) => p.permissionId),
            );
        }
        await tx.dUserRole.deleteMany({ where: { userId: id } });
        await tx.dManagedRoom.deleteMany({ where: { userId: id } });
        const row = await tx.dUser.update({
          where: { id },
          data: {
            enabled: input.enabled,
            revision: current.revision + 1,
            roles: { create: input.roleIds.map((roleId) => ({ roleId })) },
            managedRooms: { create: input.managedRoomIds.map((roomId) => ({ roomId })) },
          },
          include: identityInclude,
        });
        await this.adminRemains(tx);
        await tx.dSession.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return {
          targetId: id,
          reason: input.reason,
          value: {
            ...asIdentity(row).user,
            username: row.username,
            revision: row.revision,
            roleIds: row.roles.map((r) => r.roleId).sort(),
            managedRoomIds: row.managedRooms.map((r) => r.roomId).sort(),
          },
        };
      },
    );
  }

  private roomValue(row: {
    id: string;
    code: string;
    name: string;
    departmentId: string | null;
    restrictedToDepartment: boolean;
    enabled: boolean;
    revision: number;
  }) {
    const { departmentId, ...rest } = row;
    return { ...rest, ...(departmentId ? { departmentId } : {}) };
  }
  private async manageRoom(tx: CoreTransaction, actor: Identity, id: string) {
    const room = await this.resources.room(tx, id);
    this.resources.requireManagedRoom(actor, room, 'd.rooms.write');
    return room;
  }
  private roomCreationScope(actor: Identity, input: RoomWriteDto) {
    const grants = actor.grants.filter((g) => g.permission === 'd.rooms.write');
    if (grants.some((g) => g.scope === 'ALL')) return;
    if (
      grants.some((g) => g.scope === 'DEPARTMENT') &&
      actor.user.departmentId &&
      input.departmentId === actor.user.departmentId
    )
      return;
    throw new ForbiddenException('New rooms require global or same-department creation authority');
  }
  private async departmentReference(tx: CoreTransaction, id: string | null | undefined) {
    if (id && !(await tx.dDepartment.findUnique({ where: { id }, select: { id: true } })))
      throw new BadRequestException('Unknown department');
  }
  createRoom(identity: Identity, input: RoomWriteDto, key: string, traceId: string) {
    this.createRevision(input.expectedRevision);
    if (input.restrictedToDepartment && !input.departmentId)
      throw new BadRequestException('Restricted room requires a department');
    return this.write(
      identity,
      'd.rooms.write',
      false,
      'd.room.created',
      null,
      input,
      key,
      traceId,
      async (tx, actor) => {
        this.roomCreationScope(actor, input);
        await this.departmentReference(tx, input.departmentId);
        const row = await tx.dRoom.create({
          data: {
            id: randomUUID(),
            code: input.code,
            name: input.name,
            departmentId: input.departmentId ?? null,
            restrictedToDepartment: input.restrictedToDepartment,
            enabled: input.enabled,
          },
        });
        return { targetId: row.id, value: this.roomValue(row) };
      },
      async (_tx, actor) => {
        this.roomCreationScope(actor, input);
      },
    );
  }
  updateRoom(identity: Identity, id: string, input: RoomWriteDto, key: string, traceId: string) {
    return this.write(
      identity,
      'd.rooms.write',
      false,
      'd.room.updated',
      id,
      input,
      key,
      traceId,
      async (tx) => {
        await transactionLock(tx, 'room:' + id);
        const actor = await this.resources.actor(tx, identity.user.id);
        const current = await this.manageRoom(tx, actor, id);
        this.revision(current.revision, input.expectedRevision);
        const proposedDepartment =
          input.departmentId === undefined ? current.departmentId : input.departmentId;
        if (
          proposedDepartment !== current.departmentId ||
          input.restrictedToDepartment !== current.restrictedToDepartment
        )
          throw new ConflictException(
            'Room department and restriction are immutable in this initial version',
          );
        const row = await tx.dRoom.update({
          where: { id },
          data: {
            code: input.code,
            name: input.name,
            enabled: input.enabled,
            revision: current.revision + 1,
          },
        });
        return { targetId: id, value: this.roomValue(row) };
      },
      async (tx, actor) => {
        await this.manageRoom(tx, actor, id);
      },
    );
  }
  createSeat(
    identity: Identity,
    roomId: string,
    input: SeatWriteDto,
    key: string,
    traceId: string,
  ) {
    this.createRevision(input.expectedRevision);
    return this.write(
      identity,
      'd.rooms.write',
      false,
      'd.seat.created',
      roomId,
      input,
      key,
      traceId,
      async (tx) => {
        await transactionLock(tx, 'room:' + roomId);
        const actor = await this.resources.actor(tx, identity.user.id);
        await this.manageRoom(tx, actor, roomId);
        const row = await tx.dSeat.create({
          data: {
            id: randomUUID(),
            roomId,
            code: input.code,
            enabled: input.enabled,
            powerType: input.powerType,
          },
        });
        return { targetId: row.id, value: row };
      },
      async (tx, actor) => {
        await this.manageRoom(tx, actor, roomId);
      },
    );
  }
  updateSeat(identity: Identity, id: string, input: SeatWriteDto, key: string, traceId: string) {
    return this.write(
      identity,
      'd.rooms.write',
      false,
      'd.seat.updated',
      id,
      input,
      key,
      traceId,
      async (tx) => {
        const initial = await this.resources.seat(tx, id);
        await transactionLock(tx, 'room:' + initial.roomId);
        const actor = await this.resources.actor(tx, identity.user.id);
        const current = await this.resources.seat(tx, id);
        this.resources.requireManagedRoom(actor, current.room, 'd.rooms.write');
        this.revision(current.revision, input.expectedRevision);
        const row = await tx.dSeat.update({
          where: { id },
          data: {
            code: input.code,
            enabled: input.enabled,
            powerType: input.powerType,
            revision: current.revision + 1,
          },
        });
        return { targetId: id, value: row };
      },
      async (tx, actor) => {
        const current = await this.resources.seat(tx, id);
        this.resources.requireManagedRoom(actor, current.room, 'd.rooms.write');
      },
    );
  }
  private async schedule(tx: CoreTransaction, roomId: string, revision: number) {
    const rows = await tx.dOpeningRule.findMany({
      where: { roomId },
      orderBy: [{ weekday: 'asc' }, { opensHour: 'asc' }],
    });
    return {
      roomId,
      revision,
      timezone: 'Asia/Shanghai' as const,
      rules: rows
        .map((row) => ({
          weekday: row.weekday === 0 ? 7 : row.weekday,
          opensHour: row.opensHour,
          closesHour: row.closesHour,
        }))
        .sort((a, b) => a.weekday - b.weekday || a.opensHour - b.opensHour),
    };
  }
  async openingRules(identity: Identity, roomId: string) {
    return this.db.$transaction(
      async (tx) => {
        const room = await tx.dRoom.findFirst({
          where: { AND: [{ id: roomId }, roomScope(identity, 'd.rooms.read')] },
        });
        if (!room) throw new NotFoundException('Room not found');
        return this.schedule(tx, roomId, room.revision);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  setOpeningRules(
    identity: Identity,
    roomId: string,
    input: OpeningRulesWriteDto,
    key: string,
    traceId: string,
  ) {
    const opensHour = Number(input.opensAt.slice(0, 2)),
      closesHour = Number(input.closesAt.slice(0, 2));
    if (opensHour >= closesHour)
      throw new BadRequestException('Opening time must precede closing time');
    return this.write(
      identity,
      'd.rooms.write',
      false,
      'd.opening-rules.updated',
      roomId,
      input,
      key,
      traceId,
      async (tx) => {
        await transactionLock(tx, 'room:' + roomId);
        const actor = await this.resources.actor(tx, identity.user.id);
        const current = await this.manageRoom(tx, actor, roomId);
        this.revision(current.revision, input.expectedRevision);
        await tx.dOpeningRule.deleteMany({ where: { roomId } });
        if (input.weekdays.length)
          await tx.dOpeningRule.createMany({
            data: input.weekdays.map((weekday) => ({
              roomId,
              weekday: weekday === 7 ? 0 : weekday,
              opensHour,
              closesHour,
            })),
          });
        const room = await tx.dRoom.update({
          where: { id: roomId },
          data: { revision: current.revision + 1 },
        });
        return { targetId: roomId, value: await this.schedule(tx, roomId, room.revision) };
      },
      async (tx, actor) => {
        await this.manageRoom(tx, actor, roomId);
      },
    );
  }
  async auditEvents(identity: Identity, query: AuditQueryDto) {
    this.global(identity, 'd.audit.read');
    if (query.cursor && !isUUID(query.cursor))
      throw new BadRequestException('Audit cursor must be a UUID');
    const rows = await this.db.dAuditEvent.findMany({
      where: {
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((row) => ({
        id: row.id,
        actorId: row.actorId,
        action: row.action,
        targetId: row.targetId,
        traceId: row.traceId,
        createdAt: row.createdAt.toISOString(),
        ...(row.reason ? { reason: row.reason } : {}),
      })),
      nextCursor: rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null,
    };
  }
}
