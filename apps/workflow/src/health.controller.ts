import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { ServiceHealth } from '@campus/contracts';
import { PrismaService } from './platform/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService) {}
  @Get('live')
  live(): ServiceHealth {
    return { service: 'workflow', status: 'live', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async ready(): Promise<ServiceHealth> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      const metadata = await this.db.serviceMetadata.findUnique({ where: { key: 'service-name' } });
      if (metadata?.value !== 'workflow') throw new Error('Infrastructure seed is missing');
      return { service: 'workflow', status: 'ready', timestamp: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Database, migration or infrastructure seed is not ready',
      });
    }
  }
}
