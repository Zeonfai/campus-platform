import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageDto } from './identity.dto.js';

export class ExpectedRevisionDto {
  @IsOptional() @IsInt() @Min(0) @Max(2147483646) expectedRevision?: number;
}
export class DepartmentWriteDto extends ExpectedRevisionDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 200)
  name!: string;
}
export class RoleWriteDto extends DepartmentWriteDto {
  @IsIn(['SELF', 'DEPARTMENT', 'MANAGED_ROOMS', 'ALL']) scope!:
    'SELF' | 'DEPARTMENT' | 'MANAGED_ROOMS' | 'ALL';
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  permissionIds!: string[];
}
export class RoomWriteDto extends DepartmentWriteDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(1, 200)
  code!: string;
  @IsOptional() @IsString() @Length(1, 100) departmentId?: string | null;
  @IsBoolean() restrictedToDepartment!: boolean;
  @IsBoolean() enabled!: boolean;
}
export class SeatWriteDto extends ExpectedRevisionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(1, 200)
  code!: string;
  @IsBoolean() enabled!: boolean;
  @IsIn(['NONE', 'FIXED', 'RAIL']) powerType!: 'NONE' | 'FIXED' | 'RAIL';
}
export class UserAccessWriteDto {
  @IsInt() @Min(1) @Max(2147483646) expectedRevision!: number;
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  roleIds!: string[];
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  managedRoomIds!: string[];
  @IsBoolean() enabled!: boolean;
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 1000)
  reason!: string;
}
export class OpeningRulesWriteDto {
  @IsInt() @Min(1) @Max(2147483646) expectedRevision!: number;
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays!: number[];
  @IsString() @Matches(/^(?:[01][0-9]|2[0-3]):00$/) opensAt!: string;
  @IsString() @Matches(/^(?:(?:[01][0-9]|2[0-3]):00|24:00)$/) closesAt!: string;
  @IsIn(['Asia/Shanghai']) timezone!: 'Asia/Shanghai';
}
export class AuditQueryDto extends PageDto {
  @IsOptional() @IsString() @Length(1, 100) actorId?: string;
  @IsOptional() @IsString() @Length(1, 100) action?: string;
  @IsOptional() @IsString() @Length(1, 100) targetId?: string;
}
