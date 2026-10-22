import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { notImplemented } from '../../platform/not-implemented.js';

import { isUUID } from 'class-validator';
import { ServiceIdentityService } from './service-identity.service.js';
import { IdentityService } from './identity.service.js';
import { DirectoryService } from './directory.service.js';
import { ResourceDirectoryService } from './resource-directory.service.js';
import { PrismaService } from '../../platform/prisma.service.js';
import { NotFoundException } from '@nestjs/common';
import { LoginDto, PageDto } from './identity.dto.js';
import { SessionGuard, RequirePermission, type IdentityRequest } from './session.guard.js';

@Controller()
@UseGuards(SessionGuard)
export class DController {
  constructor(
    private readonly identities: IdentityService,
    private readonly directory: DirectoryService,
    private readonly services: ServiceIdentityService,
    private readonly resources: ResourceDirectoryService,
    private readonly db: PrismaService,
  ) {}
  @Post('api/v1/auth/login')
  @RequirePermission('public')
  @HttpCode(200)
  login(@Body() input: LoginDto, @Req() request: IdentityRequest) {
    return this.identities.login(
      input.username,
      input.password,
      request.socket.remoteAddress ?? 'unknown',
      String(request.id),
    );
  }

  @Post('api/v1/auth/logout')
  @RequirePermission('public')
  @HttpCode(204)
  async logout(
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IdentityRequest,
  ): Promise<void> {
    if (!key || !isUUID(key)) throw new BadRequestException('Idempotency-Key must be a UUID');
    await this.identities.logout(request.headers.authorization, String(request.id));
  }

  @Get('internal/v1/identity/context')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('public')
  getDelegatedUserContext(
    @Req() request: IdentityRequest,
    @Headers('x-user-authorization') userAuthorization: string | undefined,
  ) {
    this.services.requireWorkflow(request.headers.authorization);
    return this.identities.authenticate(userAuthorization);
  }

  @Get('internal/v1/identity/rooms/:roomId')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('public')
  async getDelegatedRoomContext(
    @Req() request: IdentityRequest,
    @Param('roomId') roomId: string,
    @Headers('x-user-authorization') userAuthorization: string | undefined,
  ) {
    this.services.requireM2(request.headers.authorization);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(roomId) || roomId.includes('..'))
      throw new BadRequestException('Invalid room ID');
    const identity = await this.identities.authenticate(userAuthorization);
    return this.db.$transaction(async (tx) => {
      const room = await this.resources.room(tx, roomId);
      if (!room.enabled) throw new NotFoundException('Room not available');
      this.resources.requireRoom(identity, room, 'm2.applications.create', true);
      return {
        id: room.id,
        code: room.code,
        name: room.name,
        ...(room.departmentId ? { departmentId: room.departmentId } : {}),
        restrictedToDepartment: room.restrictedToDepartment,
        enabled: room.enabled,
      };
    });
  }

  @Get('internal/v1/identity/work-order-rooms/:roomId')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('public')
  async getDelegatedWorkOrderRoomContext(
    @Req() request: IdentityRequest,
    @Param('roomId') roomId: string,
    @Headers('x-user-authorization') userAuthorization: string | undefined,
  ) {
    this.services.requireM3(request.headers.authorization);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(roomId) || roomId.includes('..'))
      throw new BadRequestException('Invalid room ID');
    const identity = await this.identities.authenticate(userAuthorization);
    return this.db.$transaction(async (tx) => {
      const room = await this.resources.room(tx, roomId);
      if (!room.enabled) throw new NotFoundException('Room not available');
      this.resources.requireRoom(identity, room, 'm3.work-orders.create', true);
      return {
        room: {
          id: room.id,
          code: room.code,
          name: room.name,
          enabled: room.enabled,
          restrictedToDepartment: room.restrictedToDepartment,
          ...(room.departmentId ? { departmentId: room.departmentId } : {}),
        },
        escalationRecipientIds: await this.resources.maintenanceRecipients(tx, room),
      };
    });
  }

  @Get('internal/v1/identity/work-order-rooms/:roomId/repairers/:userId')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('public')
  async getDelegatedRepairerContext(
    @Req() request: IdentityRequest,
    @Param('roomId') roomId: string,
    @Param('userId') userId: string,
    @Headers('x-user-authorization') userAuthorization: string | undefined,
  ) {
    this.services.requireM3(request.headers.authorization);
    for (const id of [roomId, userId])
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || id.includes('..'))
        throw new BadRequestException('Invalid context ID');
    const dispatcher = await this.identities.authenticate(userAuthorization);
    return this.db.$transaction(async (tx) => {
      const room = await this.resources.room(tx, roomId);
      this.resources.requireRoom(dispatcher, room, 'm3.dispatch');
      const repairer = await this.resources.actor(tx, userId);
      this.resources.requireRoom(repairer, room, 'm3.repair');
      return { userId: repairer.user.id, displayName: repairer.user.displayName };
    });
  }

  @Get('api/v1/auth/me')
  @RequirePermission('authenticated')
  getCurrentUser(@Req() request: IdentityRequest) {
    return request.identity.user;
  }

  @Get('api/v1/departments')
  @RequirePermission('d.departments.read')
  listDepartments(@Req() request: IdentityRequest, @Query() query: PageDto) {
    return this.directory.departments(request.identity, query);
  }

  @Post('api/v1/departments')
  @RequirePermission('d.departments.write')
  createDepartment(): never {
    return notImplemented('createDepartment');
  }

  @Patch('api/v1/departments/:departmentId')
  @RequirePermission('d.departments.write')
  updateDepartment(): never {
    return notImplemented('updateDepartment');
  }

  @Get('api/v1/roles')
  @RequirePermission('d.roles.read')
  listRoles(@Req() request: IdentityRequest, @Query() query: PageDto) {
    return this.directory.roles(request.identity, query);
  }

  @Post('api/v1/roles')
  @RequirePermission('d.roles.write')
  createRole(): never {
    return notImplemented('createRole');
  }

  @Patch('api/v1/roles/:roleId')
  @RequirePermission('d.roles.write')
  updateRole(): never {
    return notImplemented('updateRole');
  }

  @Get('api/v1/rooms')
  @RequirePermission('d.rooms.read')
  listRooms(@Req() request: IdentityRequest, @Query() query: PageDto) {
    return this.directory.rooms(request.identity, query);
  }

  @Post('api/v1/rooms')
  @RequirePermission('d.rooms.write')
  createRoom(): never {
    return notImplemented('createRoom');
  }

  @Patch('api/v1/rooms/:roomId')
  @RequirePermission('d.rooms.write')
  updateRoom(): never {
    return notImplemented('updateRoom');
  }

  @Get('api/v1/permissions')
  @RequirePermission('d.roles.write')
  listPermissions(@Req() request: IdentityRequest, @Query() query: PageDto) {
    return this.directory.permissions(request.identity, query);
  }

  @Get('api/v1/users')
  @RequirePermission('d.users.read')
  listUsers(): never {
    return notImplemented('listUsers');
  }

  @Put('api/v1/users/:userId/access')
  @RequirePermission('d.users.write')
  updateUserAccess(): never {
    return notImplemented('updateUserAccess');
  }

  @Get('api/v1/rooms/:roomId/seats')
  @RequirePermission('d.rooms.read')
  listRoomSeats(
    @Req() request: IdentityRequest,
    @Param('roomId') roomId: string,
    @Query() query: PageDto,
  ) {
    return this.directory.seats(request.identity, roomId, query);
  }

  @Post('api/v1/rooms/:roomId/seats')
  @RequirePermission('d.rooms.write')
  createSeat(): never {
    return notImplemented('createSeat');
  }

  @Patch('api/v1/seats/:seatId')
  @RequirePermission('d.rooms.write')
  updateSeat(): never {
    return notImplemented('updateSeat');
  }

  @Put('api/v1/rooms/:roomId/opening-rules')
  @RequirePermission('d.rooms.write')
  setOpeningRules(): never {
    return notImplemented('setOpeningRules');
  }

  @Get('api/v1/settings/booking-policy')
  @RequirePermission('authenticated')
  getBookingPolicy(): never {
    return notImplemented('getBookingPolicy');
  }

  @Put('api/v1/settings/booking-policy')
  @RequirePermission('d.settings.write')
  setBookingPolicy(): never {
    return notImplemented('setBookingPolicy');
  }

  @Get('api/v1/notifications')
  @RequirePermission('authenticated')
  listNotifications(): never {
    return notImplemented('listNotifications');
  }

  @Post('api/v1/notifications/:notificationId/read')
  @RequirePermission('authenticated')
  markNotificationRead(): never {
    return notImplemented('markNotificationRead');
  }

  @Get('api/v1/audit-events')
  @RequirePermission('d.audit.read')
  listAuditEvents(): never {
    return notImplemented('listAuditEvents');
  }
}
