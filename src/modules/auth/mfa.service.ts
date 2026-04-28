import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { authenticator } from "otplib";

import { PrismaService } from "../prisma/prisma.service";

import { decryptSecret, encryptSecret } from "./mfa.crypto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

const ISSUER = "Nimi Events";

/**
 * MfaService — TOTP (RFC 6238) using `otplib`.
 *
 * Flow:
 *   1. `beginSetup(userId)` generates a fresh secret, returns the otpauth
 *      URI the client renders as a QR code. Secret is *encrypted at rest*
 *      and stored on the User row immediately so the client can poll/test.
 *      The user can't actually log in with MFA until they complete step 2.
 *   2. `confirmSetup(userId, code)` verifies the first TOTP code. We don't
 *      flip the user into "MFA required" until they prove they can read
 *      it — otherwise a half-finished setup can lock them out.
 *   3. `verifyCode(userId, code)` is used during login challenge.
 *   4. `disable(userId, code)` requires a valid code (or admin override).
 *
 * Roles: SUPPORT/EDITOR/OWNER are *required* to enable MFA before they can
 * use the admin (the AdminLayout enforces this on the web side).
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(private readonly db: PrismaService) {
    // 30-second window with ±1 step tolerance for clock drift.
    authenticator.options = { window: 1, step: 30 };
  }

  hasMfa(user: { totpSecret: string | null }): boolean {
    return Boolean(user.totpSecret);
  }

  async beginSetup(userId: string): Promise<{ otpauthUrl: string; secret: string }> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    // If MFA is already active, refuse — the user must `disable` first.
    if (user.totpSecret) {
      throw new BadRequestException("MFA is already enabled — disable it first to start over.");
    }

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(user.email, ISSUER, secret);

    // Persist encrypted secret. We mark "active" only on confirmSetup; until
    // then the secret is staged so the user can scan + test before commit.
    // We use a sentinel prefix so we can distinguish staged from active.
    const staged = `staged:${encryptSecret(secret)}`;
    await this.db.user.update({
      where: { id: userId },
      data: { totpSecret: staged },
    });

    return { otpauthUrl, secret };
  }

  async confirmSetup(userId: string, code: string, meta: RequestMeta): Promise<{ ok: true }> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpSecret?.startsWith("staged:")) {
      throw new BadRequestException("No MFA setup in progress.");
    }
    const secret = decryptSecret(user.totpSecret.slice("staged:".length));
    if (!authenticator.verify({ token: code, secret })) {
      throw new UnauthorizedException("That code didn't match. Try the next one.");
    }

    await this.db.user.update({
      where: { id: userId },
      data: { totpSecret: encryptSecret(secret) }, // remove the staged: prefix
    });
    await this.audit("auth.mfa.enabled", userId, userId, meta);
    return { ok: true };
  }

  async verifyCode(userId: string, code: string): Promise<boolean> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpSecret) return false;
    if (user.totpSecret.startsWith("staged:")) return false; // not yet committed
    const secret = decryptSecret(user.totpSecret);
    return authenticator.verify({ token: code, secret });
  }

  async disable(userId: string, code: string, meta: RequestMeta): Promise<{ ok: true }> {
    const ok = await this.verifyCode(userId, code);
    if (!ok) throw new UnauthorizedException("That code didn't match.");

    await this.db.user.update({ where: { id: userId }, data: { totpSecret: null } });
    await this.audit("auth.mfa.disabled", userId, userId, meta);
    return { ok: true };
  }

  /**
   * Cancel an in-progress (staged) setup without confirming. Used when the
   * user navigates away from the setup wizard.
   */
  async cancelSetup(userId: string): Promise<{ ok: true }> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (user?.totpSecret?.startsWith("staged:")) {
      await this.db.user.update({ where: { id: userId }, data: { totpSecret: null } });
    }
    return { ok: true };
  }

  // ---- helpers ----

  private async audit(
    action: string,
    entityId: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          action,
          entity: "User",
          entityId,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.error({ err, action }, "Failed to write MFA audit log");
    }
  }
}
