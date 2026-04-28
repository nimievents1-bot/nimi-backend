import { IsEmail, IsOptional, IsString, Length, MaxLength } from "class-validator";

export class SubscribeDto {
  @IsEmail() @MaxLength(254)
  email!: string;

  @IsOptional() @IsString() @MaxLength(80)
  source?: string;

  /** Cloudflare Turnstile token from the client widget. */
  @IsString() @Length(1, 4096)
  turnstileToken!: string;

  /** Honeypot — must be empty. */
  @IsOptional() @IsString() @MaxLength(0, { message: "Suspicious submission." })
  website?: string;
}

export class ConfirmDto {
  @IsString() @Length(20, 200)
  token!: string;
}

export class UnsubscribeDto {
  @IsString() @Length(20, 200)
  token!: string;
}
