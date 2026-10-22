import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PageDto } from '../d/identity.dto.js';

export class IntervalDto {
  @IsISO8601({ strict: true, strictSeparator: true })
  startsAt!: string;
  @IsISO8601({ strict: true, strictSeparator: true })
  endsAt!: string;
}
export class BookingDto extends IntervalDto {
  @IsString() @Length(1, 100) seatId!: string;
}
export class AvailabilityDto extends PageDto {
  @IsISO8601({ strict: true, strictSeparator: true }) startsAt!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) endsAt!: string;
  @IsOptional() @IsString() @Length(1, 100) roomId?: string;
  @IsOptional() @IsIn(['NONE', 'FIXED', 'RAIL']) powerType?: 'NONE' | 'FIXED' | 'RAIL';
}
export class ReasonDto {
  @IsString() @Length(1, 1000) reason!: string;
}
export class ResourceCommandDto extends ReasonDto {
  @IsUUID() operationId!: string;
  @IsInt() @Min(1) @Max(2147483647) revision!: number;
  @IsString() @Length(1, 100) actorId!: string;
}
export class OccupancyDto extends ResourceCommandDto {
  @IsString() @Length(1, 100) roomId!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) startsAt!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) endsAt!: string;
}

export class MaintenanceDto extends ResourceCommandDto {
  @IsString() @Length(1, 100) roomId!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) startsAt!: string;
}
