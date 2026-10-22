import { Module } from '@nestjs/common';
import { ResourceDirectoryService } from './resource-directory.service.js';
import { ServiceIdentityService } from './service-identity.service.js';
import { DController } from './d.controller.js';
import { IdentityService } from './identity.service.js';
import { DirectoryService } from './directory.service.js';
import { SessionGuard } from './session.guard.js';

@Module({
  controllers: [DController],
  providers: [
    IdentityService,
    DirectoryService,
    SessionGuard,
    ResourceDirectoryService,
    ServiceIdentityService,
  ],
  exports: [IdentityService, SessionGuard, ResourceDirectoryService, ServiceIdentityService],
})
export class DModule {}
