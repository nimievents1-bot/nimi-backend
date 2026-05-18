import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { type AuthenticatedUser } from "../auth/types";

import { ProfileService } from "./profile.service";

/**
 * DTO for the customer-facing profile update. Every field is optional
 * so the customer can patch one detail at a time without restating
 * the rest. Each constraint carries a friendly `message` so a
 * validation rejection reads like guidance, not a stack trace.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString({ message: "Please enter a valid name." })
  @Length(1, 120, { message: "Name should be 1–120 characters." })
  name?: string;

  @IsOptional()
  @IsString({ message: "Please enter a valid phone number." })
  @MaxLength(32, { message: "Phone number is too long (max 32 characters)." })
  phone?: string;

  @IsOptional()
  @IsString({ message: "Please enter a valid address line." })
  @MaxLength(200, { message: "Address line 1 is too long (max 200 characters)." })
  addressLine1?: string;

  @IsOptional()
  @IsString({ message: "Please enter a valid second address line." })
  @MaxLength(200, { message: "Address line 2 is too long (max 200 characters)." })
  addressLine2?: string;

  @IsOptional()
  @IsString({ message: "Please enter a valid city." })
  @MaxLength(80, { message: "City is too long (max 80 characters)." })
  addressCity?: string;

  @IsOptional()
  @IsString({ message: "Please enter a valid postcode." })
  @Length(3, 10, { message: "Postcode should be 3–10 characters (e.g. SW1A 1AA)." })
  addressPostcode?: string;

  @IsOptional()
  @IsString({ message: "Country code must be two letters." })
  @Length(2, 2, { message: "Country code must be exactly two letters (e.g. GB)." })
  @Matches(/^[A-Za-z]{2}$/, { message: "Country code must be two letters (e.g. GB)." })
  addressCountry?: string;

  /**
   * Day of birthday (1–31). Optional, but if provided must be paired
   * with `birthMonth`. We deliberately do NOT collect year so the row
   * never carries age-PII. The service validates the day/month pair
   * yields a real calendar date (e.g. rejects 31 Feb) before persisting.
   *
   * Sending `null` (rather than omitting) explicitly clears the saved
   * birthday — useful if the customer wants to remove their DOB from
   * the account after sign-up.
   */
  @IsOptional()
  @IsInt({ message: "Birthday day must be a whole number." })
  @Min(1, { message: "Birthday day must be 1–31." })
  @Max(31, { message: "Birthday day must be 1–31." })
  birthDay?: number | null;

  @IsOptional()
  @IsInt({ message: "Birthday month must be a whole number." })
  @Min(1, { message: "Birthday month must be 1–12." })
  @Max(12, { message: "Birthday month must be 1–12." })
  birthMonth?: number | null;
}

/**
 * Profile API — customer-facing read/write for the bits of the User
 * record that aren't auth-critical (name, phone, default delivery
 * address, etc.). Auth-sensitive operations (email change, password)
 * still live under `/auth/*` because they have separate confirmation
 * flows.
 *
 * Routes:
 *   GET   /profile   Returns the full editable profile shape.
 *   PATCH /profile   Updates one or more fields. Empty strings clear
 *                    the field (the service maps "" → null at the DB).
 */
@Controller({ path: "profile", version: "1" })
@UseGuards(JwtAuthGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.profile.getForUser(user.id);
  }

  @Patch()
  @HttpCode(200)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profile.update(user.id, dto);
  }
}
