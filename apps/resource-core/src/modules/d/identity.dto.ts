import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class LoginDto {
  @IsString()
  @Length(1, 200)
  username!: string;

  @IsString()
  @Length(1, 200)
  password!: string;
}

export class PageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  cursor?: string;
}
