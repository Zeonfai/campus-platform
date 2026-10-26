import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../platform/prisma.service.js';
import { databaseNow, transactionLock } from '../../platform/transaction.js';
import { ResourceDirectoryService, type CoreTransaction } from '../d/resource-directory.service.js';
import { BookingSupportService } from '../d/booking-support.service.js';
import type { Identity } from '../d/identity.service.js';
import type { IntervalDto } from './scheduling.dto.js';
import { booking, SchedulingService } from './scheduling.service.js';

const day = (now: Date) => new Date(+now + 8 * 3600000).toISOString().slice(0, 10);
@Injectable()
export class BookingLifecycleService {
  constructor(
    private readonly db: PrismaService,
    private readonly directory: ResourceDirectoryService,
    private readonly support: BookingSupportService,
    private readonly scheduling: SchedulingService,
  ) {}
  async code(identity: Identity, roomId: string) {
    return this.db.$transaction(async (tx) => {
      await transactionLock(tx, 'room:' + roomId);
      const room = await this.directory.room(tx, roomId);
      this.directory.requireManagedRoom(identity, room, 'm1.checkin-code.display');
      if (!room.enabled) throw new UnprocessableEntityException('Room is disabled');
      const date = day(await databaseNow(tx));
      const row = await tx.m1DailyCode.upsert({
        where: { roomId_date: { roomId, date } },
        create: { roomId, date, code: randomBytes(4).toString('hex').toUpperCase() },
        update: {},
      });
      return { roomId, date, code: row.code };
    });
  }
  async checkIn(identity: Identity, id: string, code: string, key: string, traceId: string) {
    const normalized = code.trim().toUpperCase();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(['check-in', id, normalized]))
      .digest('hex');
    const result = await this.db.$transaction(async (tx) => {
      const receiptId = identity.user.id + ':' + key;
      await transactionLock(tx, 'write:' + receiptId);
      const prior = await tx.m1WriteReceipt.findUnique({ where: { id: receiptId } });
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new ConflictException('Idempotency key payload mismatch');
        return { status: 200, body: prior.result };
      }
      const initial = await tx.m1Booking.findFirst({ where: { id, userId: identity.user.id } });
      if (!initial) throw new NotFoundException('Booking not found');
      await transactionLock(tx, 'room:' + initial.roomId);
      const row = await tx.m1Booking.findUniqueOrThrow({
        where: { id },
        include: { room: true, seat: true },
      });
      const now = await databaseNow(tx);
      if (
        row.status !== 'BOOKED' ||
        +now < +row.startsAt - row.checkInBeforeMinutes * 60000 ||
        +now >= +row.startsAt + row.noShowAfterMinutes * 60000
      )
        throw new UnprocessableEntityException(
          'Booking is outside its check-in window or already processed',
        );
      if (
        !row.room.enabled ||
        !row.seat.enabled ||
        (await tx.m1ResourceEffect.findFirst({
          where: {
            roomId: row.roomId,
            sourceModule: 'M3',
            state: 'ACTIVE',
            startsAt: { lte: now },
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          },
        }))
      )
        throw new ConflictException(
          'Resource is under maintenance or disabled; contact the administrator',
        );
      const inWindow = row.codeAttemptWindow !== null && +now - +row.codeAttemptWindow < 60000;
      if (inWindow && row.failedCodeAttempts >= 5)
        return {
          status: 429,
          body: { message: 'Too many check-in attempts; retry after one minute' },
        };
      const daily = await tx.m1DailyCode.findUnique({
        where: { roomId_date: { roomId: row.roomId, date: day(now) } },
      });
      if (!daily || daily.code !== normalized) {
        await tx.m1Booking.update({
          where: { id },
          data: {
            failedCodeAttempts: inWindow ? row.failedCodeAttempts + 1 : 1,
            codeAttemptWindow: inWindow ? row.codeAttemptWindow : now,
          },
        });
        return { status: 400, body: { message: 'Invalid current room check-in code' } };
      }
      const updated = await tx.m1Booking.update({
        where: { id },
        data: {
          status: 'CHECKED_IN',
          checkedInAt: now,
          nextActionAt: row.endsAt,
          failedCodeAttempts: 0,
          codeAttemptWindow: null,
        },
      });
      const body = booking(updated);
      await tx.m1WriteReceipt.create({
        data: { id: receiptId, fingerprint, result: JSON.parse(JSON.stringify(body)) },
      });
      await this.directory.audit(tx, identity.user.id, 'm1.booking.checked-in', id, traceId);
      return { status: 200, body };
    });
    if (result.status !== 200)
      throw new HttpException({ message: 'Check-in rejected' }, result.status);
    return result.body;
  }
  async repeat(identity: Identity, id: string, input: IntervalDto, key: string, traceId: string) {
    const previous = await this.db.m1Booking.findFirst({ where: { id, userId: identity.user.id } });
    if (!previous) throw new NotFoundException('Booking not found');
    return this.scheduling.reserve(
      identity,
      { seatId: previous.seatId, ...input },
      key,
      traceId,
      id,
    );
  }
  async processBooking(id: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const first = await tx.m1Booking.findUnique({ where: { id } });
      if (!first) return;
      await transactionLock(tx, 'room:' + first.roomId);
      const row = await tx.m1Booking.findUniqueOrThrow({
        where: { id },
        include: { room: true, seat: true },
      });
      const now = await databaseNow(tx);
      if (
        !row.nextActionAt ||
        row.nextActionAt > now ||
        !['BOOKED', 'CHECKED_IN'].includes(row.status)
      )
        return;
      const trace = 'lifecycle:' + id;
      if (row.status === 'CHECKED_IN') {
        if (row.endsAt > now) return;
        await tx.m1Booking.update({
          where: { id },
          data: { status: 'COMPLETED', completedAt: now, nextActionAt: null },
        });
        await this.directory.audit(tx, row.userId, 'm1.booking.completed', id, trace);
        return;
      }
      const deadline = new Date(+row.startsAt + row.noShowAfterMinutes * 60000);
      if (now >= deadline) {
        const affected =
          !row.enforceNoShow ||
          !row.room.enabled ||
          !row.seat.enabled ||
          Boolean(
            await tx.m1ResourceEffect.findFirst({
              where: {
                roomId: row.roomId,
                sourceModule: 'M3',
                startsAt: { lt: deadline },
                OR: [
                  { state: 'ACTIVE' },
                  {
                    state: 'RELEASED',
                    releasedAt: { gt: new Date(+row.startsAt - row.checkInBeforeMinutes * 60000) },
                  },
                ],
              },
            }),
          );
        const reason = !row.enforceNoShow
          ? '启用签到功能前的历史预约，自动取消且免记违约'
          : affected
            ? '资源停用或维修影响签到，自动取消并免记违约'
            : '超过签到截止时间仍未签到，自动取消';
        await tx.m1Booking.update({
          where: { id },
          data: {
            status: affected ? 'CANCELLED' : 'NO_SHOW',
            cancelledAt: now,
            cancelReason: reason,
            violationAt: affected ? null : now,
            nextActionAt: null,
          },
        });
        await this.support.notify(
          tx,
          row.userId,
          'm1:' + id + ':expired',
          affected ? '预约取消（免违约）' : '预约未签到已取消',
          row.room.name + ' / ' + row.seat.code + '：' + reason + '。预约编号：' + id,
        );
        await this.directory.audit(
          tx,
          row.userId,
          affected ? 'm1.booking.excused' : 'm1.booking.no-show',
          id,
          trace,
        );
        return;
      }
      const late = row.reminderAfterAt ?? new Date(+row.startsAt + 10 * 60000);
      if (now >= late) {
        await this.support.notify(
          tx,
          row.userId,
          'm1:' + id + ':late',
          '预约尚未签到',
          row.room.name +
            ' / ' +
            row.seat.code +
            ' 尚未签到，请在开始后' +
            row.noShowAfterMinutes +
            '分钟内完成签到。预约编号：' +
            id,
        );
        await tx.m1Booking.update({ where: { id }, data: { nextActionAt: deadline } });
      } else {
        if (now < row.startsAt)
          await this.support.notify(
            tx,
            row.userId,
            'm1:' + id + ':before',
            '预约即将开始',
            row.room.name +
              ' / ' +
              row.seat.code +
              ' 即将开始，请到达后使用当天教室码签到。预约编号：' +
              id,
          );
        await tx.m1Booking.update({ where: { id }, data: { nextActionAt: late } });
      }
    });
  }
  async dueIds(after?: string): Promise<string[]> {
    return this.db.$transaction(async (tx: CoreTransaction) => {
      const now = await databaseNow(tx);
      const rows = await tx.m1Booking.findMany({
        where: {
          status: { in: ['BOOKED', 'CHECKED_IN'] },
          nextActionAt: { lte: now },
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 100,
        select: { id: true },
      });
      return rows.map((r) => r.id);
    });
  }
}
