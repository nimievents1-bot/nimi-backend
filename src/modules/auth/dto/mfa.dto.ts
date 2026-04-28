import { IsString, Length, Matches } from "class-validator";

export class MfaCodeDto {
  /** Six-digit TOTP code from the authenticator app. */
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/)
  code!: string;
}

export class MfaChallengeDto {
  /** Short-lived JWT issued by the login endpoint when MFA is required. */
  @IsString() @Length(20, 4096)
  challengeToken!: string;

  /** Six-digit TOTP code. */
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/)
  code!: string;
}
