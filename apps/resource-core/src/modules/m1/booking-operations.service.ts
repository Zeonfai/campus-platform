import { isUUID } from 'class-validator';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../platform/prisma.service.js';
import { ResourceDirectoryService } from '../d/resource-directory.service.js';
import type { Identity } from '../d/identity.service.js';
import type { OperationsQueryDto } from './scheduling.dto.js';
import { parseInterval } from './scheduling.service.js';

@Injectable()
export class BookingOperationsService {
  constructor(
    private readonly db: PrismaService,
    private readonly directory: ResourceDirectoryService,
  ) {}
  private interval(query: OperationsQueryDto) {
    const times = parseInterval(query.startsAt, query.endsAt);
    if (+times[1] - +times[0] > 31 * 86400000)
      throw new BadRequestException('Reporting range must not exceed 31 days');
    return times;
  }
  async reasons(identity: Identity, roomId: string, query: OperationsQueryDto) {
    const [start, end] = this.interval(query);
    if (query.cursor && !/^(D|M1|M2|M3):[A-Za-z0-9._-]{1,100}$/.test(query.cursor))
      throw new BadRequestException('Invalid source cursor');
    if (query.cursor?.startsWith('M1:') && !isUUID(query.cursor.slice(3)))
      throw new BadRequestException('Invalid booking source cursor');
    return this.db.$transaction(async (tx) => {
      const room = await this.directory.room(tx, roomId);
      this.directory.requireManagedRoom(identity, room, 'm1.resource-reasons.read');
      const items: {
        sourceModule: 'D' | 'M1' | 'M2' | 'M3';
        sourceId: string;
        reason: string;
        state: string;
        startsAt?: string;
        endsAt?: string | null;
        seatId?: string;
      }[] = [];
      const allowed = (module: string) =>
        !query.cursor || module >= (query.cursor.split(':')[0] ?? '');
      const after = (module: string) =>
        query.cursor?.startsWith(module + ':') ? query.cursor.slice(module.length + 1) : undefined;
      if (!room.enabled && !query.cursor)
        items.push({
          sourceModule: 'D',
          sourceId: room.id,
          reason: '教室当前停用',
          state: 'DISABLED',
        });
      if (allowed('M1')) {
        const rows = await tx.m1Booking.findMany({
          where: {
            roomId,
            startsAt: { lt: end },
            endsAt: { gt: start },
            ...(after('M1') ? { id: { gt: after('M1')! } } : {}),
          },
          orderBy: { id: 'asc' },
          take: query.limit + 1,
        });
        items.push(
          ...rows.map((r) => ({
            sourceModule: 'M1' as const,
            sourceId: r.id,
            reason: '个人座位预约',
            state: r.status,
            seatId: r.seatId,
            startsAt: r.startsAt.toISOString(),
            endsAt: r.endsAt.toISOString(),
          })),
        );
      }
      for (const module of ['M2', 'M3'] as const) {
        if (!allowed(module)) continue;
        const rows = await tx.m1ResourceEffect.findMany({
          where: {
            roomId,
            sourceModule: module,
            startsAt: { lt: end },
            OR: [
              { endsAt: { gt: start } },
              { endsAt: null, state: 'ACTIVE' },
              { endsAt: null, state: 'RELEASED', releasedAt: { gt: start } },
            ],
            ...(after(module) ? { sourceId: { gt: after(module)! } } : {}),
          },
          orderBy: { sourceId: 'asc' },
          take: query.limit + 1,
        });
        items.push(
          ...rows.map((r) => ({
            sourceModule: module,
            sourceId: r.sourceId,
            reason: r.reason,
            state: r.state,
            ...(r.startsAt ? { startsAt: r.startsAt.toISOString() } : {}),
            endsAt:
              r.endsAt?.toISOString() ??
              (r.state === 'RELEASED' ? (r.releasedAt?.toISOString() ?? null) : null),
          })),
        );
      }
      const key = (r: (typeof items)[number]) => r.sourceModule + ':' + r.sourceId;
      return {
        items: items.slice(0, query.limit),
        nextCursor: items.length > query.limit ? key(items[query.limit - 1]!) : null,
      };
    });
  }
  async statistics(identity: Identity, query: OperationsQueryDto) {
    const [start, end] = this.interval(query);
    const grants = identity.grants.filter((g) => g.permission === 'm1.statistics.read');
    const scopes = grants.map((g) => g.scope);
    const choices: Prisma.DRoomWhereInput[] = [];
    if (scopes.includes('DEPARTMENT') && identity.user.departmentId)
      choices.push({ departmentId: identity.user.departmentId });
    if (scopes.includes('MANAGED_ROOMS')) choices.push({ id: { in: identity.managedRoomIds } });
    const authorized: Prisma.DRoomWhereInput = scopes.includes('ALL') ? {} : { OR: choices };
    return this.db.$transaction(
      async (tx) => {
        const rooms = await tx.dRoom.findMany({
          where: {
            AND: [
              authorized,
              query.roomId ? { id: query.roomId } : {},
              query.cursor ? { id: { gt: query.cursor } } : {},
            ],
          },
          orderBy: { id: 'asc' },
          take: query.limit + 1,
        });
        const items = [];
        for (const room of rooms.slice(0, query.limit)) {
          const counts = await tx.$queryRawUnsafe<
            {
              bookedHours: number;
              checkedInHours: number;
              bookingCount: number;
              noShowCount: number;
              cancelledCount: number;
            }[]
          >(
            'SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST("endsAt",$3::timestamptz)-GREATEST("startsAt",$2::timestamptz)))/3600) FILTER (WHERE status IN (\'BOOKED\',\'CHECKED_IN\',\'COMPLETED\')),0)::float8 AS "bookedHours", COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST("endsAt",$3::timestamptz)-GREATEST("startsAt",$2::timestamptz)))/3600) FILTER (WHERE status IN (\'CHECKED_IN\',\'COMPLETED\')),0)::float8 AS "checkedInHours", COUNT(*)::int AS "bookingCount", COUNT(*) FILTER (WHERE status=\'NO_SHOW\')::int AS "noShowCount", COUNT(*) FILTER (WHERE status=\'CANCELLED\')::int AS "cancelledCount" FROM m1_bookings WHERE "roomId"=$1 AND "startsAt"<$3::timestamptz AND "endsAt">$2::timestamptz',
            room.id,
            start,
            end,
          );
          items.push({ roomId: room.id, roomName: room.name, ...counts[0] });
        }
        return {
          items,
          nextCursor: rooms.length > query.limit ? rooms[query.limit - 1]?.id : null,
        };
      },
      { timeout: 15000 },
    );
  }
}
