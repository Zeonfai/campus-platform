import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { BookingLifecycleService } from './booking-lifecycle.service.js';
@Injectable()
export class BookingLifecycleWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingLifecycleWorker.name);
  private cursor: string | undefined;
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | undefined;
  constructor(private readonly lifecycle: BookingLifecycleService) {}
  onModuleInit() {
    const tick = () => {
      if (this.running) return;
      this.running = this.scan()
        .catch(() => this.logger.warn('Booking lifecycle scan failed; persistent tasks will retry'))
        .finally(() => {
          this.running = undefined;
        });
    };
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
    tick();
  }
  private async scan() {
    let ids = await this.lifecycle.dueIds(this.cursor);
    if (!ids.length && this.cursor) ids = await this.lifecycle.dueIds();
    this.cursor = ids.at(-1);
    for (const id of ids) {
      try {
        await this.lifecycle.processBooking(id);
      } catch {
        this.logger.warn('Booking lifecycle item failed; it remains pending for retry');
      }
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
