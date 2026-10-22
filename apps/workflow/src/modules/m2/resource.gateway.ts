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
export type WorkflowIdentity = components['schemas']['PrivateUserContext'];
@Injectable()
export class ResourceGateway {
  private readonly client: ResourceCoreClient | undefined;
  constructor(config: ConfigService) {
    const baseUrl = config.get<string>('RESOURCE_CORE_URL');
    const token = config.get<string>('M2_SERVICE_TOKEN');
    if (baseUrl && token && /^[A-Za-z0-9_-]{32,200}$/.test(token))
      this.client = new ResourceCoreClient({ baseUrl, serviceToken: () => token, timeoutMs: 5000 });
  }
  get configured(): boolean {
    return this.client !== undefined;
  }
  requireClient(): ResourceCoreClient {
    if (!this.client)
      throw new ServiceUnavailableException({
        code: 'WORKFLOW_INTEGRATION_UNCONFIGURED',
        message: 'Resource service integration is not configured',
      });
    return this.client;
  }
  async identity(authorization: string): Promise<WorkflowIdentity> {
    try {
      return await this.requireClient().getUserContext(authorization);
    } catch (error) {
      throw this.map(error);
    }
  }
  async room(roomId: string, authorization: string): Promise<components['schemas']['Room']> {
    try {
      return await this.requireClient().getRoomContext(roomId, authorization);
    } catch (error) {
      throw this.map(error);
    }
  }
  private map(error: unknown): Error {
    if (error instanceof ResourceApiError) {
      if (error.status === 401) return new UnauthorizedException();
      if (error.status === 403) return new ForbiddenException();
      if (error.status === 404) return new NotFoundException();
      return new ServiceUnavailableException({
        code: 'IDENTITY_DEPENDENCY_UNAVAILABLE',
        message: 'Resource identity could not be verified',
      });
    }
    if (error instanceof Error && error instanceof ServiceUnavailableException) return error;
    return new ServiceUnavailableException({
      code: 'IDENTITY_DEPENDENCY_UNAVAILABLE',
      message: 'Resource identity could not be verified',
    });
  }
}
