import { Type } from "class-transformer";
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
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
