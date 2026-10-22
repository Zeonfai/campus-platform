import { Module } from '@nestjs/common';
import { M3Controller } from './m3.controller.js';
import { M3Service } from './m3.service.js';
import { M3Worker } from './m3.worker.js';
import { MaintenanceGateway } from './resource.gateway.js';
import { MaintenanceGuard } from './maintenance.guard.js';
@Module({
  controllers: [M3Controller],
  providers: [M3Service, M3Worker, MaintenanceGateway, MaintenanceGuard],
})
export class M3Module {}
