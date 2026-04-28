import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";
import { type FastifyReply, type FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { getEnv } from "../../config/env";

import { AuthService } from "./auth.service";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
} from "./cookies";
import { MfaChallengeDto, MfaCodeDto } from "./dto/mfa.dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { MfaService } from "./mfa.service";
import { type AuthenticatedUser } from "./types";

/**
 * MFA endpoints.
 *
 * - Setup: a logged-in user begins MFA enrolment, gets the otpauth URI to
 *   scan, then confirms with a code from their authenticator app.
 * - Challenge: when login determines MFA is required, the API returns a
 *   short-lived `challengeToken`. The client posts that token + the user's
 *   TOTP code here to complete the login.
 * - Disable: requires a current TOTP code (admin recovery is a future Phase 7.1).
 */
@Controller({ path: "auth/mfa", version: "1" })
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  // ---------- enrol (logged-in) ----------

  @UseGuards(JwtAuthGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post("setup/begin")
  @HttpCode(200)
  async beginSetup(@CurrentUser() user: AuthenticatedUser) {
    const { otpauthUrl, secret } = await this.mfa.beginSetup(user.id);
    // We return both the otpauth URI (for QR) and the bare secret (in case
    // the user can't scan and types it manually). Both go over a TLS session
    // and are never logged (Pino redaction stripped via the logger config).
    return { otpauthUrl, secret };
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post("setup/confirm")
  @HttpCode(200)
  async confirmSetup(
    @Body() dto: MfaCodeDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.mfa.confirmSetup(user.id, dto.code, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post("setup/cancel")
  @HttpCode(200)
  async cancelSetup(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.cancelSetup(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post("disable")
  @HttpCode(200)
  async disable(
    @Body() dto: MfaCodeDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.mfa.disable(user.id, dto.code, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  // ---------- challenge (no session yet) ----------

  @Public()
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @Post("challenge")
  @HttpCode(200)
  async challenge(
    @Body() dto: MfaChallengeDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    let payload: { sub: string; purpose: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub: string; purpose: string }>(dto.challengeToken, {
        secret: getEnv().JWT_SECRET,
        issuer: "nimi",
      });
    } catch {
      throw new UnauthorizedException("Challenge has expired — please sign in again.");
    }
    if (payload.purpose !== "mfa-challenge") {
      throw new UnauthorizedException();
    }

    const ok = await this.mfa.verifyCode(payload.sub, dto.code);
    if (!ok) throw new UnauthorizedException("That code didn't match. Try the next one.");

    // MFA passed — issue the real session cookies.
    const session = await this.auth.completeMfaLogin(payload.sub, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    void res.setCookie(ACCESS_COOKIE, session.accessToken, accessCookieOptions());
    void res.setCookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
    return { user: session.user };
  }
}
