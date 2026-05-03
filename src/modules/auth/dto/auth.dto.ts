import { Type } from "class-transformer";
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * Auth DTOs — every field validated by class-validator.
 *
 * Password rules: minimum 12 characters, must include at least one of:
 * lowercase, uppercase, digit, special. We reject the most-common breached
 * passwords at the service layer (zxcvbn) on top of these structural rules.
 */

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])(.{12,128})$/;

export class RegisterDto {
  @IsEmail() @MaxLength(254)
  email!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsString()
  @Matches(PASSWORD_REGEX, {
    message:
      "Password must be 12–128 chars and include lower, upper, number and a special character.",
  })
  password!: string;

  @IsOptional() @IsString() @MaxLength(32)
  phone?: string;

  /**
   * Optional birthday (day + month only, never year). Used to fire the
   * Klaviyo birthday flow. We don't store the year to keep this out of
   * GDPR special-category data and to make the field feel low-stakes.
   * Both must be provided together — the API ignores a half-set DOB.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(31)
  birthDay?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12)
  birthMonth?: number;
}

export class LoginDto {
  @IsEmail() @MaxLength(254)
  email!: string;

  @IsString() @IsNotEmpty() @MaxLength(128)
  password!: string;
}

export class VerifyEmailDto {
  @IsString() @Length(20, 200)
  token!: string;
}

export class ForgotPasswordDto {
  @IsEmail() @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @IsString() @Length(20, 200)
  token!: string;

  @IsString()
  @Matches(PASSWORD_REGEX, {
    message:
      "Password must be 12–128 chars and include lower, upper, number and a special character.",
  })
  password!: string;
}
