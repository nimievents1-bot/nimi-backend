import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * Postcode prefix shape — letters and digits only, 1-4 characters.
 * Matches how UK postcodes are usually grouped by their leading
 * area code (B, BD, LS, IV, KW etc.) without forcing a particular
 * length.
 */
const PREFIX_REGEX = /^[A-Z0-9]{1,4}$/;

export class CreateShippingZoneDto {
  @IsString() @MinLength(2) @MaxLength(80)
  name!: string;

  @IsOptional() @IsString() @MaxLength(400)
  description?: string;

  /**
   * Comma-separated postcode prefixes from the admin form, pre-
   * split to a string array. Empty array = catch-all (default
   * zone). Bounded so the admin form can't trigger an O(thousands)
   * walk on every checkout.
   */
  @IsArray() @ArrayMaxSize(200)
  @IsString({ each: true })
  @Matches(PREFIX_REGEX, { each: true, message: "Prefixes must be A-Z + 0-9 only, 1-4 chars (e.g. BD, LS, IV, KW1)." })
  postcodePrefixes!: string[];

  /** Base fee in pence. 0 = free zone. Capped at £1000 for sanity. */
  @Type(() => Number) @IsInt() @Min(0) @Max(100_000)
  feeMinor!: number;

  @IsOptional() @IsBoolean()
  freeOverEnabled?: boolean;

  /**
   * Order subtotal in pence at which the fee drops to zero in this
   * zone (only meaningful when `freeOverEnabled` is true). Allow
   * null so the operator can switch from "free over £75" to "no
   * free delivery in this zone" without re-typing.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  freeOverMinor?: number | null;

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  position?: number;
}

export class UpdateShippingZoneDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80)
  name?: string;

  @IsOptional() @IsString() @MaxLength(400)
  description?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(200)
  @IsString({ each: true })
  @Matches(PREFIX_REGEX, { each: true })
  postcodePrefixes?: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000)
  feeMinor?: number;

  @IsOptional() @IsBoolean()
  freeOverEnabled?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  freeOverMinor?: number | null;

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  position?: number;
}
