import { IsInt, Max, Min } from 'class-validator';
export class BookingPolicyDto {
  @IsInt() @Min(1) @Max(24) maxHours!: number;
  @IsInt() @Min(1) @Max(2147483646) revision!: number;
  @IsInt() @Min(0) @Max(60) checkInBeforeMinutes!: number;
  @IsInt() @Min(0) @Max(60) reminderBeforeMinutes!: number;
  @IsInt() @Min(0) @Max(59) reminderAfterMinutes!: number;
  @IsInt() @Min(1) @Max(60) noShowAfterMinutes!: number;
}
