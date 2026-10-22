import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { MaintenanceGateway, type MaintenanceIdentity } from './resource.gateway.js';
export interface MaintenanceRequest extends Request {
  actor: MaintenanceIdentity;
  userAuthorization: string;
}
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly resources: MaintenanceGateway) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MaintenanceRequest>(),
      authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
      throw new UnauthorizedException();
    request.actor = await this.resources.identity(authorization);
    request.userAuthorization = authorization;
    return true;
  }
}
