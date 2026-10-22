import {
  ForbiddenException,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IdentityService, type Identity } from './identity.service.js';

const ACCESS = 'campus.d.access';
export const RequirePermission = (permission: string) => SetMetadata(ACCESS, permission);
export type IdentityRequest = Request & { identity: Identity };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly identities: IdentityService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.get<string>(ACCESS, context.getHandler());
    if (access === 'public') return true;
    if (!access) throw new ForbiddenException('Route authorization is not configured');
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    request.identity = await this.identities.authenticate(request.headers.authorization);
    if (
      access !== 'authenticated' &&
      !request.identity.grants.some((grant) => grant.permission === access)
    )
      throw new ForbiddenException('Permission required');
    return true;
  }
}
