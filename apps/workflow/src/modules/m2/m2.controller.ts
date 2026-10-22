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
import { M2Service } from './m2.service.js';
import {
  ApplicationQueryDto,
  CreateApplicationDto,
  DecisionDto,
  SetPolicyDto,
  PolicyQueryDto,
  WithdrawDto,
} from './m2.dto.js';
import { WorkflowGuard, type WorkflowRequest } from './workflow.guard.js';
@Controller()
@UseGuards(WorkflowGuard)
export class M2Controller {
  constructor(private readonly service: M2Service) {}
  @Post('api/v1/applications')
  createApplication(
    @Req() req: WorkflowRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateApplicationDto,
  ) {
    return this.service.create(req.actor, req.userAuthorization, key, body);
  }
  @Get('api/v1/applications')
  listApplications(@Req() req: WorkflowRequest, @Query() query: ApplicationQueryDto) {
    return this.service.list(req.actor, query);
  }
  @Get('api/v1/applications/:applicationId')
  getApplication(
    @Req() req: WorkflowRequest,
    @Param('applicationId', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.get(req.actor, id);
  }
  @Post('api/v1/applications/:applicationId/steps/:stepId/decision')
  @HttpCode(200)
  decideApplicationStep(
    @Req() req: WorkflowRequest,
    @Param('applicationId', new ParseUUIDPipe()) id: string,
    @Param('stepId', new ParseUUIDPipe()) stepId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: DecisionDto,
  ) {
    return this.service.decide(req.actor, id, stepId, key, body);
  }
  @Post('api/v1/applications/:applicationId/withdraw')
  @HttpCode(200)
  withdrawApplication(
    @Req() req: WorkflowRequest,
    @Param('applicationId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: WithdrawDto,
  ) {
    return this.service.withdraw(req.actor, id, key, body);
  }
  @Get('api/v1/approval-policies')
  listApprovalPolicies(@Req() req: WorkflowRequest, @Query() query: PolicyQueryDto) {
    return this.service.policies(req.actor, query);
  }
  @Put('api/v1/approval-policies/:policyId')
  setApprovalPolicy(
    @Req() req: WorkflowRequest,
    @Param('policyId') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SetPolicyDto,
  ) {
    return this.service.setPolicy(req.actor, id, key, body);
  }
}
