import { Module } from '@nestjs/common';
import { M2Controller } from './m2.controller.js';
import { M2Service } from './m2.service.js';
import { M2Worker } from './m2.worker.js';
import { ResourceGateway } from './resource.gateway.js';
import { WorkflowGuard } from './workflow.guard.js';
@Module({
  controllers: [M2Controller],
  providers: [M2Service, M2Worker, ResourceGateway, WorkflowGuard],
})
export class M2Module {}
