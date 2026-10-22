import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { M3Service } from './m3.service.js';
import {
  AcceptWorkOrderDto,
  AssignWorkOrderDto,
  CreateWorkOrderDto,
  MaintenancePolicyQueryDto,
  RateWorkOrderDto,
  SetMaintenancePolicyDto,
  WorkOrderActionDto,
  WorkOrderQueryDto,
} from './m3.dto.js';
import { MaintenanceGuard, type MaintenanceRequest } from './maintenance.guard.js';
@Controller()
@UseGuards(MaintenanceGuard)
export class M3Controller {
  constructor(private readonly service: M3Service) {}
  @Post('api/v1/work-orders')
  createWorkOrder(
    @Req() req: MaintenanceRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateWorkOrderDto,
  ) {
    return this.service.create(req.actor, req.userAuthorization, key, body);
  }
  @Get('api/v1/work-orders')
  listWorkOrders(@Req() req: MaintenanceRequest, @Query() query: WorkOrderQueryDto) {
    return this.service.list(req.actor, query);
  }
  @Get('api/v1/work-orders/:workOrderId')
  getWorkOrder(
    @Req() req: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.get(req.actor, id);
  }
  @Post('api/v1/work-orders/:workOrderId/assign')
  @HttpCode(200)
  assignWorkOrder(
    @Req() req: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AssignWorkOrderDto,
  ) {
    return this.service.assign(req.actor, req.userAuthorization, id, key, body);
  }
  @Post('api/v1/work-orders/:workOrderId/start')
  @HttpCode(200)
  startWorkOrder(
    @Req() req: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: WorkOrderActionDto,
  ) {
    return this.service.start(req.actor, id, key, body);
  }
  @Post('api/v1/work-orders/:workOrderId/complete')
  @HttpCode(200)
  completeWorkOrder(
    @Req() req: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: WorkOrderActionDto,
  ) {
    return this.service.complete(req.actor, id, key, body);
  }
  @Post('api/v1/work-orders/:workOrderId/accept')
  @HttpCode(200)
  acceptWorkOrder(
    @Req() req: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AcceptWorkOrderDto,
  ) {
    return this.service.accept(req.actor, id, key, body);
  }
  @Post('api/v1/work-orders/:workOrderId/cancel')
  @HttpCode(200)
  cancelWorkOrder(
    @Req() req: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: WorkOrderActionDto,
  ) {
    return this.service.cancel(req.actor, id, key, body);
  }
  @Post('api/v1/work-orders/:workOrderId/rating')
  @HttpCode(200)
  rateWorkOrder(
    @Req() req: MaintenanceRequest,
    @Param('workOrderId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: RateWorkOrderDto,
  ) {
    return this.service.rate(req.actor, id, key, body);
  }
  @Get('api/v1/maintenance-policies')
  listMaintenancePolicies(
    @Req() req: MaintenanceRequest,
    @Query() query: MaintenancePolicyQueryDto,
  ) {
    return this.service.policies(req.actor, query);
  }
  @Put('api/v1/maintenance-policies/:policyId')
  setMaintenancePolicy(
    @Req() req: MaintenanceRequest,
    @Param('policyId') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SetMaintenancePolicyDto,
  ) {
    return this.service.setPolicy(req.actor, id, key, body);
  }
}
