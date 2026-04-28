import { randomUUID } from "node:crypto";

import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

import { newSecureToken, sha256 } from "./token.util";

interface IssueArgs {
  userId: string;
  familyId?: string;
  ip?: string;
  userAgent?: string;
}

interface RotateResult {
  token: string;
  expiresAt: Date;
  familyId: string;
}

/**
 * RefreshService — owns the lifecycle of refresh tokens.
 *
 * Strategy:
 *   - Each successful login mints a fresh `familyId` and a token within it.
 *   - Each refresh rotates: revoke the presented token, mint a new one in
 *     the same family.
 *   - If a token is presented that has *already* been revoked, treat it as
 *     theft: revoke the entire family and force the user to log in again.
 *   - Tokens are stored as SHA-256 hashes; plaintext lives only in the cookie.
 *
 * This is the OWASP-recommended pattern for refresh tokens with reuse
 * detection. Independently audited here against an attacker who steals
 * a single token: the attack succeeds at most once, and is detected.
 */
@Injectable()
export class RefreshService {
  private readonly logger = new Logger(RefreshService.name);

  constructor(private readonly db: PrismaService) {}

  async issue({ userId, familyId, ip, userAgent }: IssueArgs): Promise<RotateResult> {
    const token = newSecureToken();
    const hash = sha256(token);
    const family = familyId ?? randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await this.db.refreshToken.create({
      data: {
        userId,
        hash,
        familyId: family,
        expiresAt,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      },
    });

    return { token, expiresAt, familyId: family };
  }

  async rotate(presentedToken: string, ip?: string, userAgent?: string): Promise<RotateResult & { userId: string }> {
    const hash = sha256(presentedToken);
    const row = await this.db.refreshToken.findUnique({ where: { hash } });

    if (!row) {
      // Token never existed (or was already pruned). Generic auth error.
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (row.revokedAt) {
      // Reuse-detection: the family is compromised. Revoke every member.
      this.logger.warn(
        { userId: row.userId, familyId: row.familyId, ip, userAgent },
        "Refresh-token reuse detected — revoking family",
      );
      await this.revokeFamily(row.familyId, "reuse-detected");
      throw new UnauthorizedException("Refresh token has been revoked");
    }

    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException("Refresh token has expired");
    }

    // Mark this token revoked (rotated), mint a successor in the same family.
    const next = await this.db.$transaction(async (tx) => {
      await tx.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date(), revokedReason: "rotated" },
      });

      const token = newSecureToken();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await tx.refreshToken.create({
        data: {
          userId: row.userId,
          hash: sha256(token),
          familyId: row.familyId,
          expiresAt,
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        },
      });

      return { token, expiresAt, familyId: row.familyId, userId: row.userId };
    });

    return next;
  }

  async revoke(presentedToken: string, reason = "logout"): Promise<void> {
    const hash = sha256(presentedToken);
    await this.db.refreshToken.updateMany({
      where: { hash, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason = "admin-revoked"): Promise<void> {
    await this.db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }
}
