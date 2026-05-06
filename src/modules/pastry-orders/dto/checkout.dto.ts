import { IsOptional, IsString, Length, MaxLength } from "class-validator";

/**
 * Delivery address required at checkout. Country defaults to GB if the
 * client omits it. Postcode is loosely validated (length 3–10) — strict
 * UK postcode regex is intentionally avoided so test addresses and edge
 * cases (BFPO, dependencies) aren't rejected.
 */
export class StartPastryCheckoutDto {
  @IsString() @Length(2, 120)
  recipientName!: string;

  @IsOptional() @IsString() @MaxLength(32)
  phone?: string;

  @IsString() @Length(1, 200)
  shippingLine1!: string;

  @IsOptional() @IsString() @MaxLength(200)
  shippingLine2?: string;

  @IsString() @Length(1, 80)
  shippingCity!: string;

  @IsString() @Length(3, 10)
  shippingPostcode!: string;

  @IsOptional() @IsString() @Length(2, 2)
  shippingCountry?: string;

  @IsOptional() @IsString() @MaxLength(800)
  notes?: string;
}
