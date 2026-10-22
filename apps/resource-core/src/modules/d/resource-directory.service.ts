import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { asIdentity, identityInclude, type Identity } from './identity.service.js';

export type CoreTransaction = Prisma.TransactionClient;
@Injectable()
export class ResourceDirectoryService {
  async seat(tx: CoreTransaction, id: string) {
    const seat = await tx.dSeat.findUnique({ where: { id }, include: { room: true } });
    if (!seat) throw new NotFoundException('Seat not found');
    return seat;
  }
  async room(tx: CoreTransaction, id: string) {
    const room = await tx.dRoom.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }
  async actor(tx: CoreTransaction, id: string): Promise<Identity> {
    const user = await tx.dUser.findUnique({ where: { id }, include: identityInclude });
    if (!user?.enabled) throw new ForbiddenException('Delegated actor is not active');
    return asIdentity(user);
  }
  requireRoom(
    identity: Identity,
    room: { id: string; departmentId: string | null; restrictedToDepartment: boolean },
    permission: string,
    allowSelf = false,
  ): void {
    const scopes = identity.grants.filter((g) => g.permission === permission).map((g) => g.scope);
    const sameDepartment = Boolean(
      room.departmentId && room.departmentId === identity.user.departmentId,
    );
    const userAccess = !permission.startsWith('m3.') || permission === 'm3.work-orders.create';
    const eligible = userAccess ? !room.restrictedToDepartment || sameDepartment : sameDepartment;
    if (
      scopes.includes('ALL') ||
      (scopes.includes('MANAGED_ROOMS') && identity.managedRoomIds.includes(room.id)) ||
      (scopes.includes('DEPARTMENT') && eligible) ||
      (allowSelf && scopes.includes('SELF') && eligible)
    )
      return;
    throw new ForbiddenException('Room is outside the authorized scope');
  }
  async maxHours(tx: CoreTransaction): Promise<number> {
    const policy = await tx.dBookingPolicy.findUnique({ where: { id: 'default' } });
    if (!policy) throw new ServiceUnavailableException('Booking policy has not been initialized');
    return policy.maxHours;
  }
  async isOpen(tx: CoreTransaction, roomId: string, start: Date, end: Date): Promise<boolean> {
    const a = new Date(start.getTime() + 8 * 3600000);
    const b = new Date(end.getTime() + 8 * 3600000);
    const day = a.toISOString().slice(0, 10);
    const endDay = b.toISOString().slice(0, 10);
    const endHour =
      endDay === day
        ? b.getUTCHours()
        : b.getUTCHours() === 0 && end.getTime() - start.getTime() <= 24 * 3600000
          ? 24
          : -1;
    if (endHour < 0) return false;
    return Boolean(
      await tx.dOpeningRule.findFirst({
        where: {
          roomId,
          weekday: a.getUTCDay(),
          opensHour: { lte: a.getUTCHours() },
          closesHour: { gte: endHour },
        },
      }),
    );
  }
  async candidates(
    tx: CoreTransaction,
    identity: Identity,
    roomId?: string,
    powerType?: 'NONE' | 'FIXED' | 'RAIL',
    after?: string,
    limit = 101,
  ) {
    const global = identity.grants.some(
      (g) => g.permission === 'm1.bookings.create' && g.scope === 'ALL',
    );
    const managed = identity.grants.some(
      (g) => g.permission === 'm1.bookings.create' && g.scope === 'MANAGED_ROOMS',
    );
    return tx.dSeat.findMany({
      where: {
        enabled: true,
        ...(roomId ? { roomId } : {}),
        ...(powerType ? { powerType } : {}),
        ...(after ? { id: { gt: after } } : {}),
        room: {
          enabled: true,
          ...(global
            ? {}
            : {
                OR: [
                  { restrictedToDepartment: false },
                  ...(identity.user.departmentId
                    ? [{ departmentId: identity.user.departmentId }]
                    : []),
                  ...(managed && identity.managedRoomIds.length
                    ? [{ id: { in: identity.managedRoomIds } }]
                    : []),
                ],
              }),
        },
      },
      include: { room: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
  }
  async maintenanceRecipients(
    tx: CoreTransaction,
    room: { id: string; departmentId: string | null; restrictedToDepartment: boolean },
  ): Promise<string[]> {
    const users = await tx.dUser.findMany({
      where: {
        enabled: true,
        roles: {
          some: {
            role: { permissions: { some: { permissionId: { in: ['m3.dispatch', 'm3.accept'] } } } },
          },
        },
      },
      include: identityInclude,
      take: 501,
      orderBy: { id: 'asc' },
    });
    if (users.length > 500)
      throw new ServiceUnavailableException('Maintenance recipient directory requires pagination');
    return users
      .filter((user) => {
        const identity = asIdentity(user);
        return ['m3.dispatch', 'm3.accept'].some((permission) => {
          try {
            this.requireRoom(identity, room, permission);
            return true;
          } catch (error) {
            if (!(error instanceof ForbiddenException)) throw error;
            return false;
          }
        });
      })
      .map((user) => user.id);
  }

  async audit(
    tx: CoreTransaction,
    actorId: string,
    action: string,
    targetId: string,
    traceId: string,
  ): Promise<void> {
    await tx.dAuditEvent.create({ data: { id: randomUUID(), actorId, action, targetId, traceId } });
  }
}
