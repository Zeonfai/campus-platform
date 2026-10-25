import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../platform/prisma.service.js';
import type { Identity } from './identity.service.js';
import type { PageDto } from './identity.dto.js';

function page<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}
export function roomScope(identity: Identity, permission: string): Prisma.DRoomWhereInput {
  const scopes = identity.grants
    .filter((grant) => grant.permission === permission)
    .map((grant) => grant.scope);
  if (scopes.includes('ALL')) return {};
  const alternatives: Prisma.DRoomWhereInput[] = [];
  if (scopes.includes('DEPARTMENT') && identity.user.departmentId)
    alternatives.push(
      { departmentId: identity.user.departmentId },
      { restrictedToDepartment: false },
    );
  if (scopes.includes('MANAGED_ROOMS') && identity.managedRoomIds.length)
    alternatives.push({ id: { in: identity.managedRoomIds } });
  return alternatives.length ? { OR: alternatives } : { id: { in: [] } };
}

@Injectable()
export class DirectoryService {
  constructor(private readonly db: PrismaService) {}
  async rooms(identity: Identity, query: PageDto) {
    return page(
      await this.db.dRoom
        .findMany({
          where: {
            AND: [
              roomScope(identity, 'd.rooms.read'),
              ...(query.cursor ? [{ id: { gt: query.cursor } }] : []),
            ],
          },
          select: {
            id: true,
            code: true,
            name: true,
            departmentId: true,
            enabled: true,
            restrictedToDepartment: true,
            revision: true,
          },
          orderBy: { id: 'asc' },
          take: query.limit + 1,
        })
        .then((rows) =>
          rows.map(({ departmentId, ...rest }) => ({
            ...rest,
            ...(departmentId ? { departmentId } : {}),
          })),
        ),
      query.limit,
    );
  }
  async seats(identity: Identity, roomId: string, query: PageDto) {
    if (roomId.length > 100) throw new NotFoundException('Room not found');
    const accessible = await this.db.dRoom.findFirst({
      where: { AND: [{ id: roomId }, roomScope(identity, 'd.rooms.read')] },
      select: { id: true },
    });
    if (!accessible) throw new NotFoundException('Room not found');
    return page(
      await this.db.dSeat.findMany({
        where: { roomId, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
        select: {
          id: true,
          roomId: true,
          code: true,
          enabled: true,
          powerType: true,
          revision: true,
        },
        orderBy: { id: 'asc' },
        take: query.limit + 1,
      }),
      query.limit,
    );
  }
  async departments(identity: Identity, query: PageDto) {
    const scopes = identity.grants
      .filter((grant) => grant.permission === 'd.departments.read')
      .map((grant) => grant.scope);
    const alternatives: Prisma.DDepartmentWhereInput[] = [];
    if (scopes.includes('DEPARTMENT') && identity.user.departmentId)
      alternatives.push({ id: identity.user.departmentId });
    if (scopes.includes('MANAGED_ROOMS') && identity.managedRoomIds.length)
      alternatives.push({ rooms: { some: { id: { in: identity.managedRoomIds } } } });
    const allowed: Prisma.DDepartmentWhereInput = scopes.includes('ALL')
      ? {}
      : alternatives.length
        ? { OR: alternatives }
        : { id: { in: [] } };
    return page(
      await this.db.dDepartment.findMany({
        where: { AND: [allowed, ...(query.cursor ? [{ id: { gt: query.cursor } }] : [])] },
        select: { id: true, name: true, revision: true },
        orderBy: { id: 'asc' },
        take: query.limit + 1,
      }),
      query.limit,
    );
  }
  async roles(identity: Identity, query: PageDto) {
    // Global security configuration is visible only with ALL for this exact permission.
    this.requireGlobal(identity, 'd.roles.read');
    return page(
      await this.db.dRole
        .findMany({
          where: query.cursor ? { id: { gt: query.cursor } } : {},
          include: { permissions: true },
          orderBy: { id: 'asc' },
          take: query.limit + 1,
        })
        .then((rows) =>
          rows.map(({ permissions, ...role }) => ({
            ...role,
            permissionIds: permissions.map((item) => item.permissionId).sort(),
          })),
        ),
      query.limit,
    );
  }
  async permissions(identity: Identity, query: PageDto) {
    this.requireGlobal(identity, 'd.roles.write');
    return page(
      await this.db.dPermission.findMany({
        where: query.cursor ? { id: { gt: query.cursor } } : {},
        orderBy: { id: 'asc' },
        take: query.limit + 1,
      }),
      query.limit,
    );
  }
  private requireGlobal(identity: Identity, permission: string): void {
    if (!identity.grants.some((grant) => grant.permission === permission && grant.scope === 'ALL'))
      throw new ForbiddenException('Global configuration permission required');
  }
}
