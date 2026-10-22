import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResourceApiError, ResourceCoreClient } from '@campus/contracts';
import type { components } from '@campus/contracts/api';
export type MaintenanceIdentity = components['schemas']['PrivateUserContext'];
@Injectable()
export class MaintenanceGateway {
  private readonly client: ResourceCoreClient | undefined;
  constructor(config: ConfigService) {
    const baseUrl = config.get<string>('RESOURCE_CORE_URL'),
      token = config.get<string>('M3_SERVICE_TOKEN');
    if (baseUrl && token && /^[A-Za-z0-9_-]{32,200}$/.test(token))
      this.client = new ResourceCoreClient({ baseUrl, serviceToken: () => token, timeoutMs: 5000 });
  }
  get configured(): boolean {
    return this.client !== undefined;
  }
  requireClient(): ResourceCoreClient {
    if (!this.client)
      throw new ServiceUnavailableException({
        code: 'MAINTENANCE_INTEGRATION_UNCONFIGURED',
        message: 'Maintenance service integration is not configured',
      });
    return this.client;
  }
  async identity(authorization: string): Promise<MaintenanceIdentity> {
    try {
      return await this.requireClient().getUserContext(authorization);
    } catch (error) {
      throw this.map(error);
    }
  }
  async room(roomId: string, authorization: string) {
    try {
      return await this.requireClient().getWorkOrderRoomContext(roomId, authorization);
    } catch (error) {
      throw this.map(error);
    }
  }
  async repairer(roomId: string, userId: string, authorization: string) {
    try {
      return await this.requireClient().getRepairerContext(roomId, userId, authorization);
    } catch (error) {
      throw this.map(error);
    }
  }
  private map(error: unknown): Error {
    if (error instanceof ResourceApiError) {
      if (error.status === 401) return new UnauthorizedException();
      if (error.status === 403) return new ForbiddenException();
      if (error.status === 404) return new NotFoundException();
    }
    if (error instanceof ServiceUnavailableException) return error;
    return new ServiceUnavailableException({
      code: 'MAINTENANCE_DEPENDENCY_UNAVAILABLE',
      message: 'Resource authorization could not be verified',
    });
  }
}
