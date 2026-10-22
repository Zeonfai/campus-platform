import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

@Injectable()
export class ServiceIdentityService {
  constructor(private readonly config: ConfigService) {}
  requireWorkflow(header: string | undefined): void {
    const candidates = ['M2_SERVICE_TOKEN', 'M3_SERVICE_TOKEN']
      .map((name) => this.config.get<string>(name))
      .filter((value): value is string => Boolean(value && value.length >= 32));
    if (!candidates.length)
      throw new ServiceUnavailableException('Workflow service identity has not been configured');
    const match = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(header ?? '');
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (
      !match?.[1] ||
      !candidates
        .map((value) => timingSafeEqual(digest(match[1] ?? ''), digest(value)))
        .some(Boolean)
    )
      throw new UnauthorizedException('Service identity required');
  }
  requireM3(header: string | undefined): void {
    const configured = this.config.get<string>('M3_SERVICE_TOKEN');
    if (!configured || configured.length < 32)
      throw new ServiceUnavailableException('M3 service identity has not been configured');
    const match = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(header ?? '');
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), digest(configured)))
      throw new UnauthorizedException('Service identity required');
  }
  requireM2(header: string | undefined): void {
    const configured = this.config.get<string>('M2_SERVICE_TOKEN');
    if (!configured || configured.length < 32)
      throw new ServiceUnavailableException('M2 service identity has not been configured');
    const match = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(header ?? '');
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), digest(configured)))
      throw new UnauthorizedException('Service identity required');
  }
}
