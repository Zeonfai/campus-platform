import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
export const applicationStates = [
  'PENDING',
  'SYNCING',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
  'RELEASE_PENDING',
  'SYNC_FAILED',
] as const;
export class CreateApplicationDto {
  @IsString() @Length(1, 100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) roomId!: string;
  @IsDateString() @Matches(/(?:Z|[+-]\d{2}:\d{2})$/) startsAt!: string;
  @IsDateString() @Matches(/(?:Z|[+-]\d{2}:\d{2})$/) endsAt!: string;
  @Transform(trim) @IsString() @Length(1, 1000) purpose!: string;
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  policyId?: string;
}
export class DecisionDto {
  @IsIn(['APPROVE', 'REJECT']) decision!: 'APPROVE' | 'REJECT';
  @Transform(trim) @IsString() @Length(1, 1000) comment!: string;
  @IsInt() @Min(1) @Max(2147483646) expectedRevision!: number;
}
export class WithdrawDto {
  @Transform(trim) @IsString() @Length(1, 1000) reason!: string;
  @IsInt() @Min(1) @Max(2147483646) expectedRevision!: number;
}
export class ApplicationQueryDto {
  @IsOptional() @IsIn(['mine', 'approvals']) view?: 'mine' | 'approvals';
  @IsOptional() @IsIn(applicationStates) status?: string;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class PolicyStepDto {
  @IsString() @Length(1, 100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) roleId!: string;
  @IsIn(['DEPARTMENT', 'MANAGED_ROOMS', 'ALL']) scope!: 'DEPARTMENT' | 'MANAGED_ROOMS' | 'ALL';
}
export class SetPolicyDto {
  @IsString() @Length(1, 100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) id!: string;
  @Transform(trim) @IsString() @Length(1, 200) name!: string;
  @IsInt() @Min(1) @Max(10080) timeoutMinutes!: number;
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PolicyStepDto)
  steps!: PolicyStepDto[];
  @IsInt() @Min(0) @Max(2147483646) expectedRevision!: number;
}

export class PolicyQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
