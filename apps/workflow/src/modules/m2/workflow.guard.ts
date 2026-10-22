import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { ResourceGateway, type WorkflowIdentity } from './resource.gateway.js';
export interface WorkflowRequest extends Request {
  actor: WorkflowIdentity;
  userAuthorization: string;
}
@Injectable()
export class WorkflowGuard implements CanActivate {
  constructor(private readonly resources: ResourceGateway) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkflowRequest>();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
      throw new UnauthorizedException();
    request.actor = await this.resources.identity(authorization);
    request.userAuthorization = authorization;
    return true;
  }
}
