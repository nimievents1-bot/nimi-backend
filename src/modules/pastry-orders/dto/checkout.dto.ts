import { IsOptional, IsString, Length, MaxLength } from "class-validator";

/**
 * Delivery address required at checkout. Country defaults to GB if the
 * client omits it. Postcode is loosely validated (length 3–10) — strict
 * UK postcode regex is intentionally avoided so test addresses and edge
 * cases (BFPO, dependencies) aren't rejected.
 *
 * All `message` options below use customer-readable copy with the field's
 * display name — never its API key. class-validator's default messages
 * ("recipientName must be longer than or equal to 2 characters") expose
 * internal property names and read like compiler output, so we override
 * every constraint with a human phrasing. The frontend renders the
 * resulting messages as a bulleted list inside the brand Alert.
 */
export class StartPastryCheckoutDto {
  @IsString({ message: "Please enter your full name." })
  @Length(2, 120, { message: "Your full name should be 2–120 characters." })
  recipientName!: string;

  @IsOptional()
  @IsString({ message: "Please enter a valid phone number." })
  @MaxLength(32, { message: "Phone number is too long (max 32 characters)." })
  phone?: string;

  @IsString({ message: "Please enter the first line of the delivery address." })
  @Length(1, 200, { message: "Address line 1 should be 1–200 characters." })
  shippingLine1!: string;

  @IsOptional()
  @IsString({ message: "Please check the second address line." })
  @MaxLength(200, { message: "Address line 2 is too long (max 200 characters)." })
  shippingLine2?: string;

  @IsString({ message: "Please enter the delivery city or town." })
  @Length(1, 80, { message: "City should be 1–80 characters." })
  shippingCity!: string;

  @IsString({ message: "Please enter the delivery postcode." })
  @Length(3, 10, { message: "Postcode should be 3–10 characters (e.g. SW1A 1AA)." })
  shippingPostcode!: string;

  @IsOptional()
  @IsString({ message: "Country code must be two letters (e.g. GB)." })
  @Length(2, 2, { message: "Country code must be exactly two letters (e.g. GB)." })
  shippingCountry?: string;

  @IsOptional()
  @IsString({ message: "Please check the kitchen notes field." })
  @MaxLength(800, { message: "Notes for the kitchen are too long (max 800 characters)." })
  notes?: string;
}
