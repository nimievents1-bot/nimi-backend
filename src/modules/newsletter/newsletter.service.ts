import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { NewsletterStatus } from "@prisma/client";

import { getEnv } from "../../config/env";
import { TurnstileService } from "../contact/turnstile.service";
import { MailerService } from "../mailer/mailer.service";
import { newsletterConfirmTemplate } from "../mailer/newsletter-templates";
import { PrismaService } from "../prisma/prisma.service";

import { type SubscribeDto } from "./dto/newsletter.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

interface NewsletterTokenPayload {
  sub: string;
  kind: "confirm" | "unsubscribe";
}

const CONFIRM_TTL = "2d";
const UNSUB_TTL = "365d";

/**
 * Newsletter service — double opt-in with signed JWT tokens.
 *
 * Strategy:
 *   - Subscribe creates a NewsletterSubscriber row in PENDING.
 *   - We send a confirmation email with a signed JWT containing the
 *     subscriber id and `kind: "confirm"`. The token expires in 2 days.
 *   - Confirm flips the row to CONFIRMED and (in future) syncs to
 *     Resend Audiences via `RESEND_AUDIENCE_ID`.
 *   - Every email includes an unsubscribe link with a different signed
 *     JWT (`kind: "unsubscribe"`, longer TTL). Required by GDPR and
 *     deliverability best practice.
 *
 * Anti-enumeration: subscribe always succeeds even for existing rows,
 * so an attacker can't probe whether a given email is on our list.
 */
@Injectable()
export class NewsletterService {
  private readonly logger = new Logger(NewsletterService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly jwt: JwtService,
    private readonly mailer: MailerService,
    private readonly turnstile: TurnstileService,
  ) {}

  async subscribe(dto: SubscribeDto, meta: RequestMeta): Promise<{ ok: true }> {
    // Honeypot — silently accept without doing anything.
    if (dto.website && dto.website.length > 0) {
      this.logger.warn({ ip: meta.ip }, "Newsletter honeypot triggered");
      return { ok: true };
    }

    const ok = await this.turnstile.verify(dto.turnstileToken, meta.ip);
    if (!ok) {
      throw new BadRequestException("Bot protection check failed. Please try again.");
    }

    const email = dto.email.toLowerCase().trim();

    // Upsert: idempotent. If they're already CONFIRMED, do nothing — but we
    // still don't tell them whether the row existed.
    const existing = await this.db.newsletterSubscriber.findUnique({ where: { email } });

    if (existing && existing.status === NewsletterStatus.CONFIRMED) {
      return { ok: true };
    }

    const sub =
      existing ??
      (await this.db.newsletterSubscriber.create({
        data: {
          email,
          status: NewsletterStatus.PENDING,
          source: dto.source?.trim() ?? null,
        },
      }));

    if (existing && existing.status === NewsletterStatus.UNSUBSCRIBED) {
      // Re-opt-in.
      await this.db.newsletterSubscriber.update({
        where: { id: existing.id },
        data: { status: NewsletterStatus.PENDING },
      });
    }

    const token = await this.jwt.signAsync(
      { sub: sub.id, kind: "confirm" } satisfies NewsletterTokenPayload,
      { secret: getEnv().JWT_SECRET, expiresIn: CONFIRM_TTL, issuer: "nimi" },
    );

    const url = `${getEnv().WEB_ORIGIN[0] ?? "http://localhost:3000"}/newsletter/confirm?token=${token}`;
    const tpl = newsletterConfirmTemplate({ url });
    try {
      await this.mailer.send({ to: email, ...tpl, tag: "newsletter-confirm" });
    } catch (err) {
      this.logger.error({ err, subscriberId: sub.id }, "Failed to send newsletter confirmation");
    }

    return { ok: true };
  }

  async confirm(token: string): Promise<{ ok: true }> {
    const payload = await this.verifyToken(token, "confirm");
    const sub = await this.db.newsletterSubscriber.findUnique({ where: { id: payload.sub } });
    if (!sub) throw new NotFoundException();

    if (sub.status === NewsletterStatus.CONFIRMED) {
      return { ok: true };
    }

    await this.db.newsletterSubscriber.update({
      where: { id: sub.id },
      data: { status: NewsletterStatus.CONFIRMED, consentAt: new Date() },
    });

    // Optional: sync to Resend Audiences for marketing-list management.
    // Done in a follow-up — for now the confirmation email is enough.

    return { ok: true };
  }

  async unsubscribe(token: string): Promise<{ ok: true }> {
    const payload = await this.verifyToken(token, "unsubscribe");
    await this.db.newsletterSubscriber.updateMany({
      where: { id: payload.sub },
      data: { status: NewsletterStatus.UNSUBSCRIBED },
    });
    return { ok: true };
  }

  /**
   * Mint a long-lived unsubscribe token. Used in newsletter sends —
   * include in the List-Unsubscribe header and the unsubscribe link.
   */
  async unsubscribeToken(subscriberId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: subscriberId, kind: "unsubscribe" } satisfies NewsletterTokenPayload,
      { secret: getEnv().JWT_SECRET, expiresIn: UNSUB_TTL, issuer: "nimi" },
    );
  }

  private async verifyToken(
    token: string,
    expectedKind: NewsletterTokenPayload["kind"],
  ): Promise<NewsletterTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<NewsletterTokenPayload>(token, {
        secret: getEnv().JWT_SECRET,
        issuer: "nimi",
      });
      if (payload.kind !== expectedKind) throw new BadRequestException("Token mismatch");
      return payload;
    } catch {
      throw new BadRequestException("This link is invalid or has expired.");
    }
  }
}
