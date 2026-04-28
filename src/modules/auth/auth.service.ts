import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { getEnv } from "../../config/env";
import { MailerService } from "../mailer/mailer.service";
import {
  passwordResetTemplate,
  verifyEmailTemplate,
} from "../mailer/templates";
import { PrismaService } from "../prisma/prisma.service";

import { type LoginDto, type RegisterDto } from "./dto/auth.dto";
import { PasswordService } from "./password.service";
import { RefreshService } from "./refresh.service";
import { newSecureToken, sha256 } from "./token.util";
import { AUTH_EVENTS, type AuthenticatedUser } from "./types";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * AuthService — orchestrates registration, login, refresh and password flows.
 *
 * Designed to be:
 *   - resistant to user enumeration (forgot-password is always 200)
 *   - resistant to brute force (per-account lockout + ThrottlerGuard)
 *   - resistant to token theft (refresh-token rotation with reuse detection)
 *   - auditable (every meaningful event written to AuditLog)
 *
 * The controller layer does NOTHING but: parse the request, call this
 * service, and set/clear cookies. All policy lives here.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly password: PasswordService,
    private readonly refresh: RefreshService,
    private readonly jwt: JwtService,
    private readonly mailer: MailerService,
  ) {}

  // ---------- registration ----------

  async register(dto: RegisterDto, meta: RequestMeta) {
    const existing = await this.db.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      select: { id: true },
    });
    if (existing) {
      // Rate-limited at the controller; safe to be specific to legitimate users.
      throw new ConflictException("An account already exists for that email.");
    }

    const passwordHash = await this.password.hash(dto.password);
    const user = await this.db.user.create({
      data: {
        email: dto.email.toLowerCase(),
        name: dto.name.trim(),
        phone: dto.phone?.trim() || null,
        passwordHash,
      },
      select: { id: true, email: true, name: true, role: true, emailVerifiedAt: true },
    });

    await this.audit(AUTH_EVENTS.REGISTER, "User", user.id, user.id, meta);

    // Fire-and-forget verification email — user can resend if they miss it.
    void this.sendVerificationEmail(user.id, user.email, user.name);

    return user;
  }

  async sendVerificationEmail(userId: string, email: string, name?: string): Promise<void> {
    const token = newSecureToken();
    const hash = sha256(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.db.emailVerificationToken.create({
      data: { userId, hash, expiresAt },
    });

    const url = `${getEnv().WEB_ORIGIN[0] ?? "http://localhost:3000"}/verify-email?token=${token}`;
    const tpl = verifyEmailTemplate({ recipientName: name, url });
    try {
      await this.mailer.send({ to: email, ...tpl, tag: "verify-email" });
    } catch (err) {
      this.logger.error({ err, userId }, "Failed to send verification email");
    }
  }

  async verifyEmail(token: string, meta: RequestMeta): Promise<{ ok: true }> {
    const hash = sha256(token);
    const row = await this.db.emailVerificationToken.findUnique({ where: { hash } });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException("This verification link is invalid or has expired.");
    }

    await this.db.$transaction([
      this.db.emailVerificationToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      this.db.user.update({
        where: { id: row.userId },
        data: { emailVerifiedAt: new Date() },
      }),
    ]);

    await this.audit(AUTH_EVENTS.VERIFY_OK, "User", row.userId, row.userId, meta);
    return { ok: true };
  }

  // ---------- login ----------

  async login(dto: LoginDto, meta: RequestMeta) {
    const user = await this.db.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user || user.deletedAt) {
      // Constant-time-ish: still hash a dummy to avoid leaking whether the
      // user exists by response time. Argon2 cost dominates the request anyway.
      await this.password.hash("decoy-decoy-decoy");
      await this.audit(AUTH_EVENTS.LOGIN_FAIL, "User", null, null, meta, { email: dto.email });
      throw new UnauthorizedException("Invalid email or password.");
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.audit(AUTH_EVENTS.LOGIN_LOCKED, "User", user.id, user.id, meta);
      throw new UnauthorizedException(
        "This account is temporarily locked. Please try again in 15 minutes or reset your password.",
      );
    }

    const ok = await this.password.verify(user.passwordHash, dto.password);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const shouldLock = failed >= MAX_FAILED_LOGINS;
      await this.db.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failed,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MS) : null,
        },
      });
      await this.audit(AUTH_EVENTS.LOGIN_FAIL, "User", user.id, user.id, meta, {
        failedLoginCount: failed,
        locked: shouldLock,
      });
      throw new UnauthorizedException("Invalid email or password.");
    }

    // Successful password verification. Reset counter; rehash if parameters changed.
    const updates: { failedLoginCount: number; lockedUntil: null; passwordHash?: string } = {
      failedLoginCount: 0,
      lockedUntil: null,
    };
    if (this.password.needsRehash(user.passwordHash)) {
      updates.passwordHash = await this.password.hash(dto.password);
    }
    await this.db.user.update({ where: { id: user.id }, data: updates });

    // If the user has MFA enabled and committed (not staged), don't issue a
    // session yet — return a short-lived challenge token instead.
    if (user.totpSecret && !user.totpSecret.startsWith("staged:")) {
      const challengeToken = await this.jwt.signAsync(
        { sub: user.id, purpose: "mfa-challenge" },
        { expiresIn: "5m", issuer: "nimi" },
      );
      await this.audit("auth.mfa.challenge.issued", "User", user.id, user.id, meta);
      return { mfaRequired: true as const, challengeToken };
    }

    const session = await this.issueSession(user.id, user.email, user.role, meta);
    await this.audit(AUTH_EVENTS.LOGIN_OK, "User", user.id, user.id, meta);

    return {
      mfaRequired: false as const,
      ...session,
      user: this.publicUser(user),
    };
  }

  /**
   * Called by MfaController after a successful TOTP code is verified.
   * Issues the real session cookies; identical post-conditions to a
   * straight password login.
   */
  async completeMfaLogin(userId: string, meta: RequestMeta) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.deletedAt) throw new UnauthorizedException();
    const session = await this.issueSession(user.id, user.email, user.role, meta);
    await this.audit(AUTH_EVENTS.LOGIN_OK, "User", user.id, user.id, meta);
    return { ...session, user: this.publicUser(user) };
  }

  // ---------- refresh ----------

  async refreshSession(presentedToken: string, meta: RequestMeta) {
    const next = await this.refresh.rotate(presentedToken, meta.ip, meta.userAgent);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: next.userId } });

    const access = await this.jwt.signAsync({ sub: user.id, email: user.email });
    await this.audit(AUTH_EVENTS.REFRESH_OK, "RefreshToken", null, user.id, meta, {
      familyId: next.familyId,
    });

    return {
      accessToken: access,
      refreshToken: next.token,
      refreshExpiresAt: next.expiresAt,
      user: this.publicUser(user),
    };
  }

  async logout(presentedRefreshToken: string | undefined, userId: string | undefined, meta: RequestMeta) {
    if (presentedRefreshToken) {
      await this.refresh.revoke(presentedRefreshToken, "logout");
    }
    if (userId) {
      await this.audit(AUTH_EVENTS.LOGOUT, "User", userId, userId, meta);
    }
    return { ok: true as const };
  }

  // ---------- password reset ----------

  async forgotPassword(email: string, meta: RequestMeta): Promise<{ ok: true }> {
    // Anti-enumeration: always succeed.
    const user = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user && !user.deletedAt) {
      const token = newSecureToken();
      const hash = sha256(token);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

      await this.db.passwordResetToken.create({
        data: {
          userId: user.id,
          hash,
          expiresAt,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
      });

      const url = `${getEnv().WEB_ORIGIN[0] ?? "http://localhost:3000"}/reset-password?token=${token}`;
      const tpl = passwordResetTemplate({ recipientName: user.name, url, ip: meta.ip });
      try {
        await this.mailer.send({ to: user.email, ...tpl, tag: "password-reset" });
      } catch (err) {
        this.logger.error({ err, userId: user.id }, "Failed to send reset email");
      }

      await this.audit(AUTH_EVENTS.RESET_REQUEST, "User", user.id, user.id, meta);
    }
    return { ok: true };
  }

  async resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<{ ok: true }> {
    const hash = sha256(token);
    const row = await this.db.passwordResetToken.findUnique({ where: { hash } });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException("This reset link is invalid or has expired.");
    }

    const passwordHash = await this.password.hash(newPassword);

    await this.db.$transaction(async (tx) => {
      await tx.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      });
      await tx.user.update({
        where: { id: row.userId },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      });
    });

    // Revoke every refresh token for this user — force a fresh login everywhere.
    await this.refresh.revokeAllForUser(row.userId, "password-reset");
    await this.audit(AUTH_EVENTS.RESET_OK, "User", row.userId, row.userId, meta);
    return { ok: true };
  }

  // ---------- helpers ----------

  private async issueSession(
    userId: string,
    email: string,
    role: AuthenticatedUser["role"],
    meta: RequestMeta,
  ) {
    const accessToken = await this.jwt.signAsync({ sub: userId, email, role });
    const refresh = await this.refresh.issue({
      userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return {
      accessToken,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  private publicUser(user: { id: string; email: string; name: string; role: AuthenticatedUser["role"]; emailVerifiedAt: Date | null }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      emailVerifiedAt: user.emailVerifiedAt,
    };
  }

  private async audit(
    action: string,
    entity: string,
    entityId: string | null,
    actorId: string | null,
    meta: RequestMeta,
    after?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          action,
          entity,
          entityId,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          after: (after ?? undefined) as never,
        },
      });
    } catch (err) {
      // Audit failures must never break the user-facing flow.
      this.logger.error({ err, action }, "Failed to write audit log");
    }
  }
}
