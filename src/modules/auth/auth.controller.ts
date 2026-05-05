import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { type FastifyReply, type FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";

import { AuthService } from "./auth.service";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookieOptions,
  expiredCookieOptions,
  refreshCookieOptions,
} from "./cookies";
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from "./dto/auth.dto";
import { type AuthenticatedUser } from "./types";

/**
 * Auth endpoints. Versioned at /api/v1/auth/* by the global prefix + versioning.
 *
 * Cookies are set/cleared here; the access token never leaves the server side.
 * The web app authenticates by calling these endpoints with `credentials: "include"`.
 */
@Controller({ path: "auth", version: "1" })
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

  // ---------- public ----------

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  @HttpCode(201)
  async register(
    @Body() dto: RegisterDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const meta = { ip: req.ip, userAgent: req.headers["user-agent"] };
    const user = await this.auth.register(dto, meta);

    // Auto-login after register so the verify-email banner is shown to a
    // signed-in user, not a fresh guest. New users have no MFA, so the
    // login result is always a session, never a challenge.
    const result = await this.auth.login({ email: user.email, password: dto.password }, meta);
    if (result.mfaRequired) {
      // Defensive: shouldn't happen for fresh registrations, but if a future
      // policy auto-enables MFA, surface the challenge to the client.
      return { mfaRequired: true, challengeToken: result.challengeToken };
    }
    void res.setCookie(ACCESS_COOKIE, result.accessToken, accessCookieOptions());
    void res.setCookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions());
    return { user: result.user };
  }

  @Public()
  // 20/min IP throttle — combined with the per-account 8-failed-login
  // lockout in AuthService, this is still strong brute-force protection
  // (an attacker would burn one IP every 24s without progress) while
  // letting legitimate users retry a fat-fingered password without
  // hitting "Too Many Requests".
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("login")
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const meta = { ip: req.ip, userAgent: req.headers["user-agent"] };
    const result = await this.auth.login(dto, meta);

    if (result.mfaRequired) {
      // No cookies set — the client must call /auth/mfa/challenge with the token.
      return { mfaRequired: true, challengeToken: result.challengeToken };
    }

    void res.setCookie(ACCESS_COOKIE, result.accessToken, accessCookieOptions());
    void res.setCookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions());
    return { user: result.user };
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies ?? {};
    const presented = cookies[REFRESH_COOKIE];
    if (!presented) throw new UnauthorizedException();

    const meta = { ip: req.ip, userAgent: req.headers["user-agent"] };
    const session = await this.auth.refreshSession(presented, meta);

    void res.setCookie(ACCESS_COOKIE, session.accessToken, accessCookieOptions());
    void res.setCookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
    return { user: session.user };
  }

  @Post("logout")
  @HttpCode(200)
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies ?? {};
    const meta = { ip: req.ip, userAgent: req.headers["user-agent"] };
    await this.auth.logout(cookies[REFRESH_COOKIE], user?.id, meta);

    void res.setCookie(ACCESS_COOKIE, "", expiredCookieOptions("/"));
    void res.setCookie(REFRESH_COOKIE, "", expiredCookieOptions("/api/v1/auth"));
    return { ok: true };
  }

  // ---------- email verification ----------

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("verify-email")
  @HttpCode(200)
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: FastifyRequest) {
    return this.auth.verifyEmail(dto.token, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  // ---------- password reset ----------

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("forgot-password")
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: FastifyRequest) {
    // Always returns ok, even if the email doesn't exist — anti-enumeration.
    return this.auth.forgotPassword(dto.email, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("reset-password")
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: FastifyRequest) {
    return this.auth.resetPassword(dto.token, dto.password, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  // ---------- session ----------

  @Post("me")
  @HttpCode(200)
  me(@CurrentUser() user: AuthenticatedUser) {
    return { user };
  }
}
