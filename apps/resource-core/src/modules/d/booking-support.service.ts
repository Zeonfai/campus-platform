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
import type { Identity } from './identity.service.js';
import type { PageDto } from './identity.dto.js';
import type { BookingPolicyDto } from './booking-support.dto.js';
type Tx = Prisma.TransactionClient;
@Injectable()
export class BookingSupportService {
  constructor(private readonly db: PrismaService) {}
  async notify(tx: Tx, userId: string, eventKey: string, title: string, body: string) {
    await tx.dNotification.upsert({
      where: { userId_eventKey: { userId, eventKey } },
      create: { id: randomUUID(), userId, eventKey, title, body },
      update: {},
    });
  }
  async notifications(identity: Identity, query: PageDto) {
    if (query.cursor && !isUUID(query.cursor))
      throw new BadRequestException('Invalid notification cursor');
    const rows = await this.db.dNotification.findMany({
      where: { userId: identity.user.id, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map(({ id, title, body, read, createdAt }) => ({
        id,
        title,
        body,
        read,
        createdAt: createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1]?.id : null,
    };
  }
  private async receipt(tx: Tx, userId: string, key: string, input: unknown) {
    const id = userId + ':' + key;
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await transactionLock(tx, 'd-write:' + id);
    const previous = await tx.dWriteReceipt.findUnique({ where: { id } });
    if (previous && previous.fingerprint !== fingerprint)
      throw new ConflictException('Idempotency key payload mismatch');
    return { id, fingerprint, previous };
  }
  async read(identity: Identity, id: string, key: string) {
    await this.db.$transaction(async (tx) => {
      const receipt = await this.receipt(tx, identity.user.id, key, ['read', id]);
      if (receipt.previous) return;
      const result = await tx.dNotification.updateMany({
        where: { id, userId: identity.user.id },
        data: { read: true },
      });
      if (!result.count) throw new NotFoundException('Notification not found');
      await tx.dWriteReceipt.create({
        data: { id: receipt.id, fingerprint: receipt.fingerprint, result: {} },
      });
    });
  }
  async policy() {
    const row = await this.db.dBookingPolicy.findUnique({ where: { id: 'default' } });
    if (!row) throw new NotFoundException('Booking policy not initialized');
    const { id: _id, ...policy } = row;
    void _id;
    return policy;
  }
  async setPolicy(identity: Identity, input: BookingPolicyDto, key: string, traceId: string) {
    if (!identity.grants.some((g) => g.permission === 'd.settings.write' && g.scope === 'ALL'))
      throw new ForbiddenException('Global settings permission required');
    if (input.reminderAfterMinutes >= input.noShowAfterMinutes)
      throw new BadRequestException('Second reminder must precede cancellation');
    return this.db.$transaction(async (tx) => {
      const receipt = await this.receipt(tx, identity.user.id, key, [
        'booking-policy',
        input.maxHours,
        input.revision,
        input.checkInBeforeMinutes,
        input.reminderBeforeMinutes,
        input.reminderAfterMinutes,
        input.noShowAfterMinutes,
      ]);
      if (receipt.previous) return receipt.previous.result;
      await transactionLock(tx, 'booking-policy:default');
      const previous = await tx.dBookingPolicy.findUniqueOrThrow({ where: { id: 'default' } });
      if (previous.revision !== input.revision)
        throw new ConflictException('Booking policy changed; reload before editing');
      const row = await tx.dBookingPolicy.update({
        where: { id: 'default' },
        data: { ...input, revision: input.revision + 1 },
      });
      const { id: _id, ...result } = row;
      void _id;
      await tx.dWriteReceipt.create({
        data: { id: receipt.id, fingerprint: receipt.fingerprint, result },
      });
      await tx.dAuditEvent.create({
        data: {
          id: randomUUID(),
          actorId: identity.user.id,
          action: 'd.booking-policy.updated',
          targetId: 'default',
          traceId,
        },
      });
      return result;
    });
  }
}
