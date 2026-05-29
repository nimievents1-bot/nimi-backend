import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

export class CustomisationDto {
  @IsOptional() @IsString() @MaxLength(80)
  names?: string;

  @IsOptional() @IsString() @MaxLength(80)
  dates?: string;

  @IsOptional() @IsString() @MaxLength(40)
  colourTheme?: string;

  @IsOptional() @IsString() @MaxLength(500)
  message?: string;

  /** Logo upload — handled in a later phase via a presigned URL flow. */
  @IsOptional() @IsString() @MaxLength(1024)
  logoUrl?: string;
}

export class CreateCheckoutSessionDto {
  @IsString() @Length(1, 80)
  collectionSlug!: string;

  @IsInt() @Min(1) @Max(2_000)
  quantity!: number;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsEmail() @MaxLength(254)
  email!: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  @IsOptional() @ValidateNested() @Type(() => CustomisationDto)
  @IsObject()
  customisation?: CustomisationDto;

  /** Cloudflare Turnstile token. */
  @IsString() @Length(1, 4096)
  turnstileToken!: string;

  /** Honeypot. */
  @IsOptional() @IsString() @MaxLength(0, { message: "Suspicious submission." })
  website?: string;

  /**
   * PRD-required: the customer must explicitly accept that designs need
   * approval before production starts. We refuse checkout if this isn't
   * `true` — anything else (false, undefined, missing) trips the
   * boolean validator and the form re-renders with an error.
   */
  @Equals(true, {
    message:
      "Please confirm that designs need to be approved before production begins.",
  })
  designApprovalAccepted!: boolean;
}

export enum AdminOrderStatusDto {
  PENDING_PAYMENT = "PENDING_PAYMENT",
  AWAITING_DESIGN_APPROVAL = "AWAITING_DESIGN_APPROVAL",
  DESIGN_SENT = "DESIGN_SENT",
  IN_PRODUCTION = "IN_PRODUCTION",
  SHIPPED = "SHIPPED",
  DELIVERED = "DELIVERED",
  CANCELLED = "CANCELLED",
  REFUNDED = "REFUNDED",
}

export class UpdateAdminOrderDto {
  @IsOptional() @IsEnum(AdminOrderStatusDto)
  status?: AdminOrderStatusDto;

  @IsOptional() @IsString() @MaxLength(8000)
  internalNotes?: string;
}

export class ListAdminOrdersDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;

  @IsOptional() @IsEnum(AdminOrderStatusDto)
  status?: AdminOrderStatusDto;

  @IsOptional() @IsString() @MaxLength(120)
  q?: string;
}

// ============================================================
// Admin gift-collection CRUD
// ============================================================

/**
 * Subset of `GiftCategory` exposed to the admin form. Mirrors the
 * Prisma enum exactly so a typo here would fail at runtime — we
 * deliberately don't re-derive from `@prisma/client` because keeping
 * the DTO independent of the generated client makes validation
 * predictable even before `prisma generate` has run.
 */
export enum GiftCategoryDto {
  CORPORATE = "CORPORATE",
  WEDDINGS = "WEDDINGS",
  PRIVATE = "PRIVATE",
}

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Body for `POST /v1/admin/gifting/collections`.
 *
 * The `items` field is a JSON-shaped string array on the schema
 * (e.g. `["Truffles", "Tea", "Card"]`). We accept it as a real
 * `string[]` here and let class-validator iterate via
 * `@IsString({ each: true })` — much cleaner DX in the admin form
 * than typing JSON by hand.
 */
export class CreateGiftCollectionDto {
  @IsString() @Matches(SLUG_REGEX, {
    message:
      "Slug must be lowercase letters, numbers and hyphens (e.g. `signature-collection`).",
  }) @MinLength(2) @MaxLength(60)
  slug!: string;

  @IsEnum(GiftCategoryDto)
  category!: GiftCategoryDto;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsString() @MinLength(2) @MaxLength(1000)
  description!: string;

  /**
   * Array of "what's inside" bullets. Capped at 30 entries to keep
   * the marketing card legible; each entry is bounded to 200 chars
   * so a single misuse can't blow out the card layout.
   */
  @IsArray() @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  items!: string[];

  /** Base price per box in minor units. 1p–£10,000. */
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  unitPriceMinor!: number;

  /**
   * Indicative upper price (e.g. £10–£15). Null = exact price. We
   * accept undefined to mean "no max", null to clear a previously
   * set max, and a positive integer to set one.
   */
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000)
  priceMaxMinor?: number | null;

  @IsOptional() @IsString() @MaxLength(8)
  currency?: string;

  /** Minimum order quantity per gift order. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000)
  moq?: number;

  /** Lead time in days from order to ready (production estimate). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365)
  leadTimeDays?: number;

  /**
   * Hero photograph URL. Stored absolute (https://…) — the admin
   * form's upload helper writes to R2 and returns a URL; we keep
   * accepting null so the operator can clear a previously-set
   * image without re-uploading.
   */
  @IsOptional() @IsString() @MaxLength(1024)
  imageUrl?: string | null;

  @IsOptional() @IsBoolean()
  published?: boolean;

  /** Lower renders earlier in each category. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  position?: number;
}

/**
 * Body for `PATCH /v1/admin/gifting/collections/:id`. Every field
 * is optional — clients only send what changed.
 */
export class UpdateGiftCollectionDto {
  @IsOptional() @IsString() @Matches(SLUG_REGEX) @MinLength(2) @MaxLength(60)
  slug?: string;

  @IsOptional() @IsEnum(GiftCategoryDto)
  category?: GiftCategoryDto;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(1000)
  description?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  items?: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  unitPriceMinor?: number;

  @IsOptional() @IsInt() @Min(1) @Max(1_000_000)
  priceMaxMinor?: number | null;

  @IsOptional() @IsString() @MaxLength(8)
  currency?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000)
  moq?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365)
  leadTimeDays?: number;

  @IsOptional() @IsString() @MaxLength(1024)
  imageUrl?: string | null;

  @IsOptional() @IsBoolean()
  published?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  position?: number;
}

/**
 * Query for `GET /v1/admin/gifting/collections` — narrower than
 * `listAdminOrders` because the catalog is small (handful of rows)
 * and doesn't need search/category filters yet. The admin list page
 * shows everything in one go.
 */
export class AdminListCollectionsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;

  @IsOptional() @Type(() => Boolean) @IsBoolean()
  published?: boolean;

  @IsOptional() @IsEnum(GiftCategoryDto)
  category?: GiftCategoryDto;
}
