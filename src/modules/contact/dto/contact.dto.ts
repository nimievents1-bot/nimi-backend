import { Type } from "class-transformer";
import {
  IsDate,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinDate,
  MinLength,
} from "class-validator";

export enum ContactKindDto {
  GENERAL = "GENERAL",
  CATERING = "CATERING",
  EVENTS = "EVENTS",
  GIFTING = "GIFTING",
  CRAVINGS = "CRAVINGS",
  PRESS = "PRESS",
}

/**
 * Public-form payload. Validated server-side regardless of any client checks.
 *
 * `notes` is the free-text body and capped to 4 KB. Anything longer is
 * suspect; a real customer message rarely exceeds 1 KB.
 */
export class CreateContactEnquiryDto {
  @IsEnum(ContactKindDto)
  kind: ContactKindDto = ContactKindDto.GENERAL;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsEmail() @MaxLength(254)
  email!: string;

  @IsOptional() @IsString() @MaxLength(32)
  phone?: string;

  @IsOptional() @Type(() => Date) @IsDate() @MinDate(new Date(), {
    message: "Event date must be in the future.",
  })
  eventDate?: Date;

  @IsOptional() @IsString() @MaxLength(80)
  eventType?: string;

  @IsOptional() @IsInt() @Min(1) @Max(10_000)
  guestCount?: number;

  @IsOptional() @IsString() @MaxLength(40)
  budgetBand?: string;

  @IsOptional() @IsString() @MaxLength(500)
  dietary?: string;

  @IsString() @MinLength(10) @MaxLength(4000)
  notes!: string;

  @IsOptional() @IsString() @MaxLength(80)
  source?: string;

  /** Cloudflare Turnstile token from the client widget. Required in production. */
  @IsString() @Length(1, 4096)
  turnstileToken!: string;

  /** Honeypot — if filled, silently accept and mark as SPAM. */
  @IsOptional() @IsString() @MaxLength(0, {
    message: "Suspicious submission.",
  })
  website?: string;
}
