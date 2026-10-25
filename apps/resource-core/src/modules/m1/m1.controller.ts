import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PageDto } from '../d/identity.dto.js';
import { SessionGuard, RequirePermission, type IdentityRequest } from '../d/session.guard.js';
import { ServiceIdentityService } from '../d/service-identity.service.js';
import {
  AvailabilityDto,
  CheckInDto,
  IntervalDto,
  OperationsQueryDto,
  BookingDto,
  OccupancyDto,
  MaintenanceDto,
  ReasonDto,
  ResourceCommandDto,
} from './scheduling.dto.js';
import { SchedulingService } from './scheduling.service.js';
import { BookingLifecycleService } from './booking-lifecycle.service.js';
import { BookingOperationsService } from './booking-operations.service.js';

@Controller()
export class M1Controller {
  constructor(
    private readonly lifecycle: BookingLifecycleService,
    private readonly operations: BookingOperationsService,
    private readonly scheduling: SchedulingService,
    private readonly services: ServiceIdentityService,
  ) {}
  private key(value: string | undefined): string {
    if (!value || !isUUID(value)) throw new BadRequestException('Idempotency-Key must be a UUID');
    return value;
  }
  @Get('api/v1/availability/seats')
  @UseGuards(SessionGuard)
  @RequirePermission('authenticated')
  searchAvailableSeats(@Req() req: IdentityRequest, @Query() query: AvailabilityDto) {
    return this.scheduling.available(req.identity, query);
  }

  @Post('api/v1/bookings')
  @UseGuards(SessionGuard)
  @RequirePermission('m1.bookings.create')
  createBooking(
    @Req() req: IdentityRequest,
    @Body() input: BookingDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.scheduling.reserve(req.identity, input, this.key(key), String(req.id));
  }

  @Get('api/v1/bookings')
  @UseGuards(SessionGuard)
  @RequirePermission('authenticated')
  listBookings(@Req() req: IdentityRequest, @Query() query: PageDto) {
    return this.scheduling.list(req.identity, query);
  }

  @Get('api/v1/bookings/:bookingId')
  @UseGuards(SessionGuard)
  @RequirePermission('authenticated')
  getBooking(@Req() req: IdentityRequest, @Param('bookingId', new ParseUUIDPipe()) id: string) {
    return this.scheduling.get(req.identity, id);
  }

  @Post('api/v1/bookings/:bookingId/cancel')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @RequirePermission('authenticated')
  cancelBooking(
    @Req() req: IdentityRequest,
    @Param('bookingId', new ParseUUIDPipe()) id: string,
    @Body() input: ReasonDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.scheduling.cancel(req.identity, id, input.reason, this.key(key), String(req.id));
  }

  @Post('api/v1/bookings/:bookingId/check-in')
  @UseGuards(SessionGuard)
  @RequirePermission('authenticated')
  @HttpCode(200)
  checkIn(
    @Req() req: IdentityRequest,
    @Param('bookingId', new ParseUUIDPipe()) id: string,
    @Body() input: CheckInDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.lifecycle.checkIn(req.identity, id, input.code, this.key(key), String(req.id));
  }

  @Post('api/v1/bookings/:bookingId/repeat')
  @UseGuards(SessionGuard)
  @RequirePermission('m1.bookings.create')
  @HttpCode(200)
  repeatBooking(
    @Req() req: IdentityRequest,
    @Param('bookingId', new ParseUUIDPipe()) id: string,
    @Body() input: IntervalDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.lifecycle.repeat(req.identity, id, input, this.key(key), String(req.id));
  }

  @Get('api/v1/rooms/:roomId/check-in-code')
  @UseGuards(SessionGuard)
  @RequirePermission('m1.checkin-code.display')
  @Header('Cache-Control', 'no-store')
  getRoomCheckInCode(@Req() req: IdentityRequest, @Param('roomId') id: string) {
    return this.lifecycle.code(req.identity, id);
  }

  @Get('api/v1/rooms/:roomId/resource-reasons')
  @UseGuards(SessionGuard)
  @RequirePermission('m1.resource-reasons.read')
  listResourceReasons(
    @Req() req: IdentityRequest,
    @Param('roomId') id: string,
    @Query() query: OperationsQueryDto,
  ) {
    return this.operations.reasons(req.identity, id, query);
  }

  @Get('api/v1/statistics/bookings')
  @UseGuards(SessionGuard)
  @RequirePermission('m1.statistics.read')
  bookingStatistics(@Req() req: IdentityRequest, @Query() query: OperationsQueryDto) {
    return this.operations.statistics(req.identity, query);
  }

  @Put('internal/v1/room-occupancies/:applicationId')
  establishOccupancy(
    @Req() req: IdentityRequest,
    @Param('applicationId') id: string,
    @Body() input: OccupancyDto,
  ) {
    this.services.requireM2(req.headers.authorization);
    return this.scheduling.occupancy(id, input, false, String(req.id));
  }

  @Post('internal/v1/room-occupancies/:applicationId/release')
  @HttpCode(200)
  releaseOccupancy(
    @Req() req: IdentityRequest,
    @Param('applicationId') id: string,
    @Body() input: ResourceCommandDto,
  ) {
    this.services.requireM2(req.headers.authorization);
    return this.scheduling.occupancy(id, input, true, String(req.id));
  }

  @Get('internal/v1/room-occupancies/:applicationId')
  getOccupancy(@Req() req: IdentityRequest, @Param('applicationId') id: string) {
    this.services.requireM2(req.headers.authorization);
    return this.scheduling.getOccupancy(id);
  }

  @Put('internal/v1/maintenance-blocks/:workOrderId')
  establishMaintenanceBlock(
    @Req() req: IdentityRequest,
    @Param('workOrderId') id: string,
    @Body() input: MaintenanceDto,
  ) {
    this.services.requireM3(req.headers.authorization);
    return this.scheduling.occupancy(id, input, false, String(req.id), 'M3');
  }

  @Post('internal/v1/maintenance-blocks/:workOrderId/release')
  @HttpCode(200)
  releaseMaintenanceBlock(
    @Req() req: IdentityRequest,
    @Param('workOrderId') id: string,
    @Body() input: ResourceCommandDto,
  ) {
    this.services.requireM3(req.headers.authorization);
    return this.scheduling.occupancy(id, input, true, String(req.id), 'M3');
  }

  @Get('internal/v1/maintenance-blocks/:workOrderId')
  getMaintenanceBlock(@Req() req: IdentityRequest, @Param('workOrderId') id: string) {
    this.services.requireM3(req.headers.authorization);
    return this.scheduling.getOccupancy(id, 'M3');
  }
}
