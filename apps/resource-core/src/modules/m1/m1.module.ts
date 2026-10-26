import { BookingLifecycleService } from './booking-lifecycle.service.js';
import { BookingLifecycleWorker } from './booking-lifecycle.worker.js';
import { BookingOperationsService } from './booking-operations.service.js';
import { Module } from '@nestjs/common';
import { DModule } from '../d/d.module.js';
import { M1Controller } from './m1.controller.js';
import { SchedulingService } from './scheduling.service.js';
@Module({
  imports: [DModule],
  controllers: [M1Controller],
  providers: [
    SchedulingService,
    BookingLifecycleService,
    BookingLifecycleWorker,
    BookingOperationsService,
  ],
  exports: [SchedulingService],
})
export class M1Module {}
