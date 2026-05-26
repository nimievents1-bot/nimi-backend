import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Public list query — bounded so anyone can hit `/pastries` without nuking the DB. */
export class ListPastriesQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000)
  offset?: number;
}

/** Admin list — wider bounds and visibility filter. */
export class AdminListPastriesQueryDto extends ListPastriesQueryDto {
  @IsOptional() @Type(() => Boolean) @IsBoolean()
  available?: boolean;

  @IsOptional() @IsString() @MaxLength(120)
  q?: string;
}

export class CreatePastryDto {
  @IsString() @Matches(SLUG_REGEX, {
    message: "Slug must be lowercase letters, numbers and hyphens (e.g. `meat-pie`).",
  }) @MinLength(2) @MaxLength(60)
  slug!: string;

  @IsString() @MinLength(2) @MaxLength(80)
  name!: string;

  @IsOptional() @IsString() @MaxLength(800)
  description?: string;

  /** Price in minor units (pence). 1p–£10,000. */
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  priceMinor!: number;

  @IsOptional() @IsString() @MaxLength(8)
  currency?: string;

  @IsOptional() @IsUrl({ require_protocol: true })
  imageUrl?: string;

  @IsOptional() @IsString() @MaxLength(160)
  imageAlt?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20)
  tags?: string[];

  /**
   * Daily kitchen cap. `null` = no cap (clears any previously-set
   * value); a positive integer is the cap.
   *
   * Why no `@Type(() => Number)`:
   *   The body is JSON, so the value arrives as the right type
   *   already (number or null). `@Type(() => Number)` would coerce
   *   `null` to `0` via `Number(null)`, after which `@Min(1)` would
   *   reject it — and the admin form would silently fail to clear
   *   the cap. Skipping the transform lets `null` pass through to
   *   `@IsOptional()`, which short-circuits validation when the
   *   value is `null` or `undefined`.
   *
   * Semantics for the service:
   *   - `undefined` → operator didn't touch this field; leave the DB row alone.
   *   - `null`      → operator cleared the field; set the column to NULL.
   *   - integer ≥ 1 → operator set a new cap.
   */
  @IsOptional() @IsInt() @Min(1) @Max(10_000)
  batchLimit?: number | null;

  /**
   * Minimum units a customer must order in one go. Bounded to keep
   * the admin form sane — a four-figure minimum is almost certainly
   * a typo, and anything below 1 doesn't make sense. The cart and
   * checkout both enforce this on quantity changes.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(999)
  minQuantity?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60)
  leadTimeDays?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  displayOrder?: number;

  @IsOptional() @IsBoolean()
  available?: boolean;
}

export class UpdatePastryDto {
  @IsOptional() @IsString() @Matches(SLUG_REGEX) @MinLength(2) @MaxLength(60)
  slug?: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(80)
  name?: string;

  @IsOptional() @IsString() @MaxLength(800)
  description?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  priceMinor?: number;

  @IsOptional() @IsString() @MaxLength(8)
  currency?: string;

  @IsOptional() @IsUrl({ require_protocol: true })
  imageUrl?: string;

  @IsOptional() @IsString() @MaxLength(160)
  imageAlt?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20)
  tags?: string[];

  /**
   * Daily kitchen cap. `null` = no cap (clears any previously-set
   * value); a positive integer is the cap.
   *
   * Why no `@Type(() => Number)`:
   *   The body is JSON, so the value arrives as the right type
   *   already (number or null). `@Type(() => Number)` would coerce
   *   `null` to `0` via `Number(null)`, after which `@Min(1)` would
   *   reject it — and the admin form would silently fail to clear
   *   the cap. Skipping the transform lets `null` pass through to
   *   `@IsOptional()`, which short-circuits validation when the
   *   value is `null` or `undefined`.
   *
   * Semantics for the service:
   *   - `undefined` → operator didn't touch this field; leave the DB row alone.
   *   - `null`      → operator cleared the field; set the column to NULL.
   *   - integer ≥ 1 → operator set a new cap.
   */
  @IsOptional() @IsInt() @Min(1) @Max(10_000)
  batchLimit?: number | null;

  /**
   * Minimum units a customer must order in one go. Bounded to keep
   * the admin form sane — a four-figure minimum is almost certainly
   * a typo, and anything below 1 doesn't make sense. The cart and
   * checkout both enforce this on quantity changes.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(999)
  minQuantity?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60)
  leadTimeDays?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  displayOrder?: number;

  @IsOptional() @IsBoolean()
  available?: boolean;
}
