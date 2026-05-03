import { Injectable, Logger } from "@nestjs/common";
import { SubscriptionStatus } from "@prisma/client";

import { getEnv } from "../../config/env";
import {
  indulgenceBirthdayTemplate,
  indulgenceCreditsReminderTemplate,
} from "../mailer/indulgence-templates";
import { MailerService } from "../mailer/mailer.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * CronService — pull-style scheduled jobs.
 *
 * The two endpoints in CronController are HTTP-triggered (we don't run an
 * in-process scheduler) so any external scheduler can drive them: Railway
 * cron, Vercel cron, GitHub Actions, EasyCron, an external shell loop —
 * whatever the operator finds easiest. The endpoints are idempotent on
 * each run, so triggering twice in a day is safe.
 *
 * Recommended schedule (UTC):
 *   POST /v1/cron/birthday-emails       09:00 daily
 *   POST /v1/cron/credits-reminder      10:00 daily
 *
 * Authentication is a shared secret in the `x-cron-secret` header (see
 * CronController).
 */
@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  /**
   * If a customer hasn't placed an order in this window since their last
   * credit accrual, send the "your credits are still here" reminder.
   */
  private static readonly REMINDER_WINDOW_DAYS = 14;

  /** Skip reminders for any subscription with a balance below this floor. */
  private static readonly REMINDER_BALANCE_FLOOR_MINOR = 25_00; // £25 — matches the pastry minimum

  constructor(
    private readonly db: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  // ---------- birthday flow ----------

  /**
   * Send a birthday email to every user whose `(birthDay, birthMonth)` matches
   * "today" in the configured operator timezone. We use UTC by default — if
   * you need GMT/BST awareness, set the cron schedule to fire at the right
   * UTC hour for your locale rather than localising server-side.
   *
   * Idempotency: we write an `auditLog` row tagged `birthday.sent.<userId>.<YYYY-MM-DD>`
   * after a successful send, and skip any user with an existing marker for
   * today. Triggering the cron twice in one day is therefore safe.
   *
   * Promo code: a single static code (`NIMIBDAY`) is sent. The operator
   * configures this as a Stripe Promotion Code with one-redemption-per-customer
   * and 7-day validity from issue. (When the per-user generator lands in
   * Track 8b, this method will switch to per-user codes.)
   */
  async runBirthdayJob(now: Date = new Date()): Promise<{
    candidates: number;
    sent: number;
    skipped: number;
  }> {
    const day = now.getUTCDate();
    const month = now.getUTCMonth() + 1; // JS months are 0-based
    const today = `${now.getUTCFullYear()}-${pad(month)}-${pad(day)}`;

    const users = await this.db.user.findMany({
      where: {
        birthDay: day,
        birthMonth: month,
        deletedAt: null,
        emailVerifiedAt: { not: null },
      },
      select: { id: true, email: true, name: true },
    });

    let sent = 0;
    let skipped = 0;

    for (const u of users) {
      const markerAction = `birthday.sent.${today}`;
      const already = await this.db.auditLog.findFirst({
        where: { entity: "User", entityId: u.id, action: markerAction },
        select: { id: true },
      });
      if (already) {
        skipped += 1;
        continue;
      }

      try {
        const tpl = indulgenceBirthdayTemplate({
          firstName: firstNameOf(u.name) ?? u.name,
          promoCode: "NIMIBDAY",
          validDays: 7,
          accountUrl: `${getEnv().WEB_ORIGIN[0] ?? "http://localhost:3000"}/cravings`,
        });
        await this.mailer.send({ to: u.email, ...tpl, tag: "indulgence-birthday" });

        await this.db.auditLog.create({
          data: {
            action: markerAction,
            entity: "User",
            entityId: u.id,
            actorId: "system",
          },
        });
        sent += 1;
      } catch (err) {
        this.logger.error({ err, userId: u.id }, "Birthday email failed for user");
      }
    }

    this.logger.log({ today, candidates: users.length, sent, skipped }, "Birthday cron run");
    return { candidates: users.length, sent, skipped };
  }

  // ---------- credits reminder flow ----------

  /**
   * Find subscribers with positive credit balance whose last accrual was
   * more than `REMINDER_WINDOW_DAYS` ago AND who haven't placed any pastry
   * order since (we'll know about pastry orders once that endpoint exists;
   * for now the absence-of-redemption check uses CreditTransaction sums).
   *
   * Idempotency: marker `credits.reminder.<userId>.<YYYY-MM-DD>`. Sends
   * once per day per user.
   */
  async runCreditsReminderJob(now: Date = new Date()): Promise<{
    candidates: number;
    sent: number;
    skipped: number;
  }> {
    const today = isoDate(now);
    const windowMs = CronService.REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const cutoff = new Date(now.getTime() - windowMs);

    // Find active subscriptions where the last credit transaction is older
    // than the cutoff and balance is healthy enough to warrant a reminder.
    const subs = await this.db.subscription.findMany({
      where: { status: SubscriptionStatus.ACTIVE },
      select: {
        userId: true,
        user: { select: { id: true, email: true, name: true } },
      },
    });

    let sent = 0;
    let skipped = 0;
    let candidates = 0;

    for (const sub of subs) {
      if (!sub.user) continue;

      const balanceAgg = await this.db.creditTransaction.aggregate({
        where: { userId: sub.userId },
        _sum: { amountMinor: true },
      });
      const balance = balanceAgg._sum.amountMinor ?? 0;
      if (balance < CronService.REMINDER_BALANCE_FLOOR_MINOR) {
        skipped += 1;
        continue;
      }

      const lastTx = await this.db.creditTransaction.findFirst({
        where: { userId: sub.userId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (!lastTx || lastTx.createdAt > cutoff) {
        skipped += 1;
        continue;
      }

      candidates += 1;

      const markerAction = `credits.reminder.${today}`;
      const already = await this.db.auditLog.findFirst({
        where: { entity: "User", entityId: sub.user.id, action: markerAction },
        select: { id: true },
      });
      if (already) {
        skipped += 1;
        continue;
      }

      try {
        const tpl = indulgenceCreditsReminderTemplate({
          firstName: firstNameOf(sub.user.name) ?? sub.user.name,
          balanceMinor: balance,
          accountUrl: `${getEnv().WEB_ORIGIN[0] ?? "http://localhost:3000"}/account/subscription`,
        });
        await this.mailer.send({
          to: sub.user.email,
          ...tpl,
          tag: "indulgence-credits-reminder",
        });
        await this.db.auditLog.create({
          data: {
            action: markerAction,
            entity: "User",
            entityId: sub.user.id,
            actorId: "system",
          },
        });
        sent += 1;
      } catch (err) {
        this.logger.error({ err, userId: sub.user.id }, "Credits reminder failed for user");
      }
    }

    this.logger.log({ today, candidates, sent, skipped }, "Credits reminder cron run");
    return { candidates, sent, skipped };
  }
}

const pad = (n: number): string => n.toString().padStart(2, "0");
const isoDate = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function firstNameOf(displayName: string): string | undefined {
  const trimmed = displayName.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/)[0];
}
