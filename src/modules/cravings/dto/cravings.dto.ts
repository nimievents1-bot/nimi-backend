import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class SubscribeDto {
  @IsString() @Length(1, 80)
  planSlug!: string;

  /** Cloudflare Turnstile token. */
  @IsOptional() @IsString() @Length(1, 4096)
  turnstileToken?: string;
}

export class UpsertCravingsPlanDto {
  @IsString() @MinLength(2) @MaxLength(80)
  slug!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsInt() @Min(100) @Max(1_000_000)
  monthlyAmountMinor!: number;

  @IsOptional() @IsString() @Length(3, 6)
  currency?: string;

  @IsOptional() @IsString() @MaxLength(2_000)
  description?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  position?: number;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class AdjustCreditDto {
  @IsString() @Length(36, 36)
  userId!: string;

  @IsInt()
  amountMinor!: number;

  @IsString() @MaxLength(500)
  reason!: string;
}
