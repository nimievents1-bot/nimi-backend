import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/** Allowed categories. Match the marketing pages that consume tiers. */
export const TIER_CATEGORIES = ["CATERING", "EVENTS"] as const;
export type TierCategory = (typeof TIER_CATEGORIES)[number];

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateServiceTierDto {
  @IsString() @IsIn(TIER_CATEGORIES as readonly string[])
  category!: string;

  @IsString() @Matches(SLUG_REGEX) @MinLength(2) @MaxLength(60)
  slug!: string;

  @IsString() @MinLength(2) @MaxLength(80)
  eyebrow!: string;

  @IsString() @MinLength(2) @MaxLength(160)
  title!: string;

  @IsString() @MinLength(2) @MaxLength(1000)
  description!: string;

  /**
   * One line per bullet on the public tier card. Capped at 20 entries
   * so a runaway paste can't blow out the card layout.
   */
  @IsArray() @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  bullets!: string[];

  @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(2048)
  imageUrl?: string | null;

  @IsOptional() @IsBoolean()
  flagship?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  position?: number;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class UpdateServiceTierDto {
  @IsOptional() @IsString() @IsIn(TIER_CATEGORIES as readonly string[])
  category?: string;

  @IsOptional() @IsString() @Matches(SLUG_REGEX) @MinLength(2) @MaxLength(60)
  slug?: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(80)
  eyebrow?: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(160)
  title?: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(1000)
  description?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  bullets?: string[];

  @IsOptional() @IsString() @MaxLength(2048)
  imageUrl?: string | null;

  @IsOptional() @IsBoolean()
  flagship?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  position?: number;

  @IsOptional() @IsBoolean()
  active?: boolean;
}
