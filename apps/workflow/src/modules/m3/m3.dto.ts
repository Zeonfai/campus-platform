import { Type, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
export const workOrderStates = [
  'NEW',
  'ASSIGNED',
  'BLOCK_PENDING',
  'IN_REPAIR',
  'AWAITING_ACCEPTANCE',
  'RELEASE_PENDING',
  'CLOSED',
  'CANCELLED',
  'SYNC_FAILED',
] as const;
export class CreateWorkOrderDto {
  @IsString() @Length(1, 100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) roomId!: string;
  @Transform(trim) @IsString() @Length(1, 200) category!: string;
  @Transform(trim) @IsString() @Length(1, 1000) description!: string;
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  policyId?: string;
}
export class WorkOrderQueryDto {
  @IsOptional() @IsIn(['mine', 'managed', 'assigned']) view?: 'mine' | 'managed' | 'assigned';
  @IsOptional() @IsIn(workOrderStates) status?: string;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class WorkOrderActionDto {
  @Transform(trim) @IsString() @Length(1, 1000) reason!: string;
  @IsInt() @Min(1) @Max(2147483646) expectedRevision!: number;
}
export class AssignWorkOrderDto extends WorkOrderActionDto {
  @IsString() @Length(1, 100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) assigneeId!: string;
}
export class AcceptWorkOrderDto {
  @IsBoolean() accepted!: boolean;
  @Transform(trim) @IsString() @Length(1, 1000) comment!: string;
  @IsInt() @Min(1) @Max(2147483646) expectedRevision!: number;
}
export class RateWorkOrderDto {
  @IsInt() @Min(1) @Max(5) score!: number;
  @Transform(trim) @IsString() @Length(1, 1000) comment!: string;
  @IsInt() @Min(1) @Max(2147483646) expectedRevision!: number;
}
export class MaintenancePolicyQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class SetMaintenancePolicyDto {
  @IsString() @Length(1, 100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) id!: string;
  @Transform(trim) @IsString() @Length(1, 200) name!: string;
  @IsInt() @Min(1) @Max(43200) responseMinutes!: number;
  @IsInt() @Min(1) @Max(43200) repairMinutes!: number;
  @IsInt() @Min(1) @Max(43200) acceptanceMinutes!: number;
  @IsInt() @Min(0) @Max(2147483646) expectedRevision!: number;
}
