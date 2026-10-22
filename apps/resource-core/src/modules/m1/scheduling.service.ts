import { isUUID } from 'class-validator';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ResourceEffect } from '@campus/contracts';
import type { components } from '@campus/contracts/api';
import type { M1Booking, M1ResourceEffect, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../platform/prisma.service.js';
import { ResourceDirectoryService, type CoreTransaction } from '../d/resource-directory.service.js';
import type { Identity } from '../d/identity.service.js';
import type { PageDto } from '../d/identity.dto.js';
import type {
  AvailabilityDto,
  BookingDto,
  OccupancyDto,
  MaintenanceDto,
  ResourceCommandDto,
} from './scheduling.dto.js';

export async function schedulingLock(tx: CoreTransaction, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
export function parseInterval(startsAt: string, endsAt: string): [Date, Date] {
  const a = new Date(startsAt),
    b = new Date(endsAt);
  if (
    ![startsAt, endsAt].every((value) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) ||
    ![a, b].every(
      (value) =>
        Number.isFinite(value.getTime()) &&
        value.getUTCMinutes() === 0 &&
        value.getUTCSeconds() === 0 &&
        value.getUTCMilliseconds() === 0,
    ) ||
    b.getTime() <= a.getTime()
  )
    throw new BadRequestException('Use timezone-qualified whole hours and a positive interval');
  return [a, b];
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function booking(row: M1Booking): components['schemas']['Booking'] {
  return {
    id: row.id,
    roomId: row.roomId,
    seatId: row.seatId,
    userId: row.userId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
  };
}
function effect(row: M1ResourceEffect): ResourceEffect {
  if (row.sourceModule !== 'M2' && row.sourceModule !== 'M3')
    throw new Error('Invalid source in database');
  if (row.state !== 'ACTIVE' && row.state !== 'RELEASED')
    throw new Error('Invalid source state in database');
  return {
    sourceModule: row.sourceModule,
    sourceId: row.sourceId,
    revision: row.revision,
    operationId: row.operationId,
    state: row.state,
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class SchedulingService {
  constructor(
    private readonly db: PrismaService,
    private readonly directory: ResourceDirectoryService,
  ) {}
  private async receipt(tx: CoreTransaction, userId: string, key: string, digest: string) {
    const id = `${userId}:${key}`;
    await schedulingLock(tx, `write:${id}`);
    const previous = await tx.m1WriteReceipt.findUnique({ where: { id } });
    if (previous && previous.fingerprint !== digest)
      throw new ConflictException('Idempotency key payload mismatch');
    return { id, previous };
  }
  private async free(
    tx: CoreTransaction,
    roomId: string,
    start: Date,
    end: Date,
    seatId?: string,
  ): Promise<boolean> {
    const overlapping = { startsAt: { lt: end }, endsAt: { gt: start } };
    if (
      await tx.m1Booking.findFirst({
        where: {
          roomId,
          ...(seatId ? { seatId } : {}),
          status: { in: ['BOOKED', 'CHECKED_IN'] },
          ...overlapping,
        },
        select: { id: true },
      })
    )
      return false;
    return !(await tx.m1ResourceEffect.findFirst({
      where: {
        roomId,
        state: 'ACTIVE',
        startsAt: { lt: end },
        OR: [{ endsAt: null }, { endsAt: { gt: start } }],
      },
      select: { sourceId: true },
    }));
  }
  async reserve(identity: Identity, input: BookingDto, key: string, traceId: string) {
    const [start, end] = parseInterval(input.startsAt, input.endsAt);
    const digest = fingerprint(['reserve', input.seatId, start.toISOString(), end.toISOString()]);
    return this.db.$transaction(async (tx) => {
      const receipt = await this.receipt(tx, identity.user.id, key, digest);
      if (receipt.previous) return receipt.previous.result;
      const initial = await this.directory.seat(tx, input.seatId);
      await schedulingLock(tx, `room:${initial.roomId}`);
      const seat = await this.directory.seat(tx, input.seatId);
      this.directory.requireRoom(identity, seat.room, 'm1.bookings.create', true);
      if (!seat.enabled || !seat.room.enabled) throw new ConflictException('Resource is disabled');
      if (start.getTime() <= Date.now())
        throw new BadRequestException('Booking must start in the future');
      if (end.getTime() - start.getTime() > (await this.directory.maxHours(tx)) * 3600000)
        throw new BadRequestException('Booking exceeds maximum duration');
      if (!(await this.directory.isOpen(tx, seat.roomId, start, end)))
        throw new ConflictException('Room is outside its configured opening hours');
      if (!(await this.free(tx, seat.roomId, start, end, seat.id)))
        throw new ConflictException('Resource is unavailable');
      const result = booking(
        await tx.m1Booking.create({
          data: {
            id: randomUUID(),
            roomId: seat.roomId,
            seatId: seat.id,
            userId: identity.user.id,
            startsAt: start,
            endsAt: end,
            status: 'BOOKED',
          },
        }),
      );
      await tx.m1WriteReceipt.create({
        data: { id: receipt.id, fingerprint: digest, result: json(result) },
      });
      await this.directory.audit(tx, identity.user.id, 'm1.booking.created', result.id, traceId);
      return result;
    });
  }
  async cancel(identity: Identity, id: string, reason: string, key: string, traceId: string) {
    return this.db.$transaction(async (tx) => {
      const receipt = await this.receipt(
        tx,
        identity.user.id,
        key,
        fingerprint(['cancel', id, reason]),
      );
      if (receipt.previous) return receipt.previous.result;
      const initial = await tx.m1Booking.findUnique({ where: { id } });
      if (!initial || initial.userId !== identity.user.id)
        throw new NotFoundException('Booking not found');
      await schedulingLock(tx, `room:${initial.roomId}`);
      const current = await tx.m1Booking.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'BOOKED' || current.startsAt.getTime() <= Date.now())
        throw new UnprocessableEntityException('Booking can only be cancelled before it starts');
      const result = booking(
        await tx.m1Booking.update({
          where: { id },
          data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date() },
        }),
      );
      await tx.m1WriteReceipt.create({
        data: {
          id: receipt.id,
          fingerprint: fingerprint(['cancel', id, reason]),
          result: json(result),
        },
      });
      await this.directory.audit(tx, identity.user.id, 'm1.booking.cancelled', id, traceId);
      return result;
    });
  }
  private async bookingViews(rows: M1Booking[]) {
    if (!rows.length) return [];
    const start = new Date(Math.min(...rows.map((row) => +row.startsAt)));
    const end = new Date(Math.max(...rows.map((row) => +row.endsAt)));
    const repairs = await this.db.m1ResourceEffect.findMany({
      where: {
        sourceModule: 'M3',
        state: 'ACTIVE',
        roomId: { in: [...new Set(rows.map((row) => row.roomId))] },
        startsAt: { lt: end },
        OR: [{ endsAt: null }, { endsAt: { gt: start } }],
      },
      select: { roomId: true, startsAt: true, endsAt: true },
    });
    return rows.map((row) => ({
      ...booking(row),
      maintenanceAffected:
        ['BOOKED', 'CHECKED_IN'].includes(row.status) &&
        repairs.some(
          (repair) =>
            repair.roomId === row.roomId &&
            repair.startsAt !== null &&
            repair.startsAt < row.endsAt &&
            (!repair.endsAt || repair.endsAt > row.startsAt),
        ),
    }));
  }
  async list(identity: Identity, query: PageDto) {
    if (query.cursor && !isUUID(query.cursor))
      throw new BadRequestException('Booking cursor must be a UUID');
    const rows = await this.db.m1Booking.findMany({
      where: { userId: identity.user.id, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return {
      items: await this.bookingViews(rows.slice(0, query.limit)),
      nextCursor: rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null,
    };
  }
  async get(identity: Identity, id: string) {
    const row = await this.db.m1Booking.findFirst({ where: { id, userId: identity.user.id } });
    if (!row) throw new NotFoundException('Booking not found');
    return (await this.bookingViews([row]))[0];
  }
  async available(identity: Identity, query: AvailabilityDto) {
    const [start, end] = parseInterval(query.startsAt, query.endsAt);
    if (start.getTime() <= Date.now())
      throw new BadRequestException('Search must start in the future');
    return this.db.$transaction(
      async (tx) => {
        if (end.getTime() - start.getTime() > (await this.directory.maxHours(tx)) * 3600000)
          throw new BadRequestException('Search exceeds maximum booking duration');
        const items: components['schemas']['Availability'][] = [];
        let cursor = query.cursor;
        // Bounded keyset scanning; a continuation cursor may accompany an empty page.
        for (let batch = 0; batch < 5; batch++) {
          const rows = await this.directory.candidates(
            tx,
            identity,
            query.roomId,
            query.powerType,
            cursor,
            100,
          );
          if (!rows.length) return { items, nextCursor: null };
          for (const seat of rows) {
            if (items.length === query.limit) return { items, nextCursor: cursor ?? null };
            cursor = seat.id;
            if (
              (await this.directory.isOpen(tx, seat.roomId, start, end)) &&
              (await this.free(tx, seat.roomId, start, end, seat.id))
            ) {
              const { room } = seat;
              items.push({
                seat: {
                  id: seat.id,
                  roomId: seat.roomId,
                  code: seat.code,
                  enabled: seat.enabled,
                  powerType: seat.powerType,
                },
                room: {
                  id: room.id,
                  code: room.code,
                  name: room.name,
                  enabled: room.enabled,
                  restrictedToDepartment: room.restrictedToDepartment,
                  ...(room.departmentId ? { departmentId: room.departmentId } : {}),
                },
              });
            }
          }
          if (rows.length < 100) return { items, nextCursor: null };
        }
        return { items, nextCursor: cursor ?? null };
      },
      { timeout: 15000 },
    );
  }
  async getOccupancy(id: string, sourceModule: 'M2' | 'M3' = 'M2') {
    const current = await this.db.m1ResourceEffect.findUnique({
      where: { sourceModule_sourceId: { sourceModule, sourceId: id } },
    });
    if (!current) throw new NotFoundException('Source not found');
    return effect(current);
  }
  async occupancy(
    id: string,
    input: ResourceCommandDto | OccupancyDto | MaintenanceDto,
    release: boolean,
    traceId: string,
    sourceModule: 'M2' | 'M3' = 'M2',
  ): Promise<ResourceEffect> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || id.includes('..'))
      throw new BadRequestException('Invalid source ID');
    const interval =
      !release && sourceModule === 'M2' && 'endsAt' in input
        ? parseInterval(input.startsAt, input.endsAt)
        : undefined;
    const maintenanceStart =
      !release && sourceModule === 'M3' && 'startsAt' in input
        ? new Date(input.startsAt)
        : undefined;
    if (
      maintenanceStart &&
      (!/(?:Z|[+-]\d{2}:\d{2})$/i.test('startsAt' in input ? input.startsAt : '') ||
        !Number.isFinite(+maintenanceStart) ||
        +maintenanceStart > Date.now() + 60000)
    )
      throw new BadRequestException(
        'Maintenance must have a valid current or past timezone-qualified start',
      );
    if (!release && (!('roomId' in input) || (!interval && !maintenanceStart)))
      throw new BadRequestException('Occupancy interval required');
    const digest = fingerprint([
      sourceModule,
      id,
      release,
      input.operationId,
      input.revision,
      input.actorId,
      input.reason,
      ...(interval && 'roomId' in input
        ? [input.roomId, interval[0].toISOString(), interval[1].toISOString()]
        : []),
      ...(maintenanceStart && 'roomId' in input
        ? [input.roomId, maintenanceStart.toISOString()]
        : []),
    ]);
    const result = await this.db.$transaction(async (tx) => {
      const actor = await this.directory.actor(tx, input.actorId);
      const required =
        sourceModule === 'M3'
          ? [release ? 'm3.accept' : 'm3.repair']
          : release
            ? ['m2.applications.create', 'm2.approvals.decide']
            : ['m2.approvals.decide'];
      if (!actor.grants.some((g) => required.includes(g.permission)))
        throw new ForbiddenException('Delegated actor lacks resource command permission');
      await schedulingLock(tx, `operation:${input.operationId}`);
      const previous = await tx.m1Command.findUnique({ where: { operationId: input.operationId } });
      if (previous) {
        if (previous.fingerprint !== digest)
          throw new ConflictException('Operation ID payload mismatch');
        return { status: previous.status, response: previous.response };
      }
      await schedulingLock(tx, `source:${sourceModule}:${id}`);
      const current = await tx.m1ResourceEffect.findUnique({
        where: { sourceModule_sourceId: { sourceModule, sourceId: id } },
      });
      const roomId = release ? current?.roomId : 'roomId' in input ? input.roomId : undefined;
      let status = 200;
      let response: Prisma.InputJsonValue;
      try {
        if (current && input.revision <= current.revision)
          throw new ConflictException('Stale resource revision');
        if (!release && current?.state === 'RELEASED')
          throw new ConflictException('Released source cannot be reactivated');
        if (roomId) {
          await schedulingLock(tx, `room:${roomId}`);
          const room = await this.directory.room(tx, roomId);
          let permitted = false;
          for (const permission of required) {
            try {
              this.directory.requireRoom(actor, room, permission, sourceModule === 'M2' && release);
              permitted = true;
              break;
            } catch (error) {
              if (!(error instanceof ForbiddenException)) throw error;
            }
          }
          if (!permitted)
            throw new ForbiddenException('Delegated permission required for this room');
          if (!release && current?.state === 'ACTIVE')
            throw new ConflictException('Source is already allocated');
          if (!release && interval) {
            if (
              !room.enabled ||
              interval[0].getTime() <= Date.now() ||
              !(await this.directory.isOpen(tx, roomId, interval[0], interval[1]))
            )
              throw new ConflictException('Room or interval is unavailable');
            if (!(await this.free(tx, roomId, interval[0], interval[1])))
              throw new ConflictException('Room has conflicting allocations');
          }
        }
        const row = await tx.m1ResourceEffect.upsert({
          where: { sourceModule_sourceId: { sourceModule, sourceId: id } },
          create: {
            sourceModule,
            sourceId: id,
            roomId: roomId ?? null,
            startsAt: interval?.[0] ?? maintenanceStart ?? null,
            endsAt: interval?.[1] ?? null,
            state: release ? 'RELEASED' : 'ACTIVE',
            revision: input.revision,
            operationId: input.operationId,
            actorId: input.actorId,
            reason: input.reason,
          },
          update: {
            state: release ? 'RELEASED' : 'ACTIVE',
            revision: input.revision,
            operationId: input.operationId,
            actorId: input.actorId,
            reason: input.reason,
          },
        });
        response = json(effect(row));
        await this.directory.audit(
          tx,
          input.actorId,
          sourceModule === 'M3'
            ? release
              ? 'm1.maintenance.released'
              : 'm1.maintenance.established'
            : release
              ? 'm1.occupancy.released'
              : 'm1.occupancy.established',
          id,
          traceId,
        );
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        status = error.getStatus();
        response = {
          code:
            status === 409
              ? 'RESOURCE_CONFLICT'
              : status === 403
                ? 'FORBIDDEN'
                : 'REQUEST_REJECTED',
          message: error.message,
        };
      }
      await tx.m1Command.create({
        data: {
          operationId: input.operationId,
          fingerprint: digest,
          sourceModule,
          sourceId: id,
          status,
          response,
        },
      });
      return { status, response };
    });
    if (result.status !== 200) throw new HttpException(result.response as object, result.status);
    const value: unknown = result.response;
    if (
      !isRecord(value) ||
      value.sourceModule !== sourceModule ||
      typeof value.sourceId !== 'string' ||
      typeof value.operationId !== 'string' ||
      typeof value.revision !== 'number' ||
      (value.state !== 'ACTIVE' && value.state !== 'RELEASED') ||
      typeof value.updatedAt !== 'string'
    )
      throw new Error('Invalid persisted resource receipt');
    return {
      sourceModule,
      sourceId: value.sourceId,
      operationId: value.operationId,
      revision: value.revision,
      state: value.state,
      updatedAt: value.updatedAt,
    };
  }
}
