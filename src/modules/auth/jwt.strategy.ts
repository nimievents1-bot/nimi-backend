import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { type FastifyRequest } from "fastify";
import { Strategy, type StrategyOptions } from "passport-jwt";

import { getEnv } from "../../config/env";
import { PrismaService } from "../prisma/prisma.service";

import { ACCESS_COOKIE } from "./cookies";
import { type AuthenticatedUser } from "./types";

/**
 * JWT validation strategy.
 *
 * The token lives in an httpOnly cookie (never localStorage) and is
 * extracted by the function below. We deliberately do NOT fall back to
 * the Authorization header — the brand has no public API surface, so
 * cookie-only is simpler and safer.
 *
 * On success we re-fetch the user from the DB (a) to confirm they still
 * exist and (b) to pick up role / email-verified state changes since the
 * token was minted.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(private readonly db: PrismaService) {
    const opts: StrategyOptions = {
      jwtFromRequest: (req: FastifyRequest) => {
        const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
        return cookies?.[ACCESS_COOKIE] ?? null;
      },
      secretOrKey: getEnv().JWT_SECRET,
      issuer: "nimi",
      ignoreExpiration: false,
    };
    super(opts);
  }

  async validate(payload: { sub: string; email: string }): Promise<AuthenticatedUser> {
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, emailVerifiedAt: true, deletedAt: true },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException();
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerifiedAt: user.emailVerifiedAt,
    };
  }
}
