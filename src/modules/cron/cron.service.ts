import { Injectable, Logger } from "@nestjs/common";
import { CreditTxType, SubscriptionStatus } from "@prisma/client";

import { publicWebUrl } from "../../config/env";
import {
  indulgenceBirthdayTemplate,
  indulgenceCreditsExpiringTemplate,
  indulgenceCreditsReminderTemplate,
} from "../mailer/indulgence-templates";
import { MailerService } from "../mailer/mailer.service";
import { PrismaService } from "../prisma/prisma.service";
import { PromoCodesService } from "../promo-codes/promo-codes.service";

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
 *   POST /v1/cron/birthday-emails        09:00 daily
 *   POST /v1/cron/credits-reminder       10:00 daily
 *   POST /v1/cron/credits-maintenance    03:00 daily
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

  /**
   * Birthday treat: percent-off the cart subtotal. Sized to be a
   * meaningful gesture without breaking margin on a small order — at
   * 15 % a £25 cart saves £3.75, which is the cost-of-goods envelope
   * the operator was comfortable with at design time. Adjustable here
   * in one place rather than spread across email + checkout.
   */
  private static readonly BIRTHDAY_PERCENT_OFF = 15;

  /** Days the birthday code stays valid after issue (matches email copy). */
  private static readonly BIRTHDAY_VALID_DAYS = 7;

  /**
   * Floor the birthday treat at the same £25 minimum we use for the
   * pastry checkout. Otherwise a customer could try to redeem the
   * code on a £1 order and get a free pastry; the floor keeps the
   * incentive aligned with a real basket.
   */
  private static readonly BIRTHDAY_MIN_SPEND_MINOR = 25_00;

  /**
   * Heads-up window for "your credits are about to expire" emails.
   * Seven days gives the customer time to plan an order without
   * feeling rushed; shorter windows tend to read as ransom notes,
   * longer windows just get ignored. Adjustable here.
   */
  private static readonly CREDIT_EXPIRING_NOTICE_DAYS = 7;

  constructor(
    private readonly db: PrismaService,
    private readonly mailer: MailerService,
    private readonly promoCodes: PromoCodesService,
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
   * Promo code: a fresh per-user, unguessable code is issued via
   * `PromoCodesService.issueBirthdayCode` (one-shot, 7-day window,
   * `BIRTHDAY_PERCENT_OFF` % off, floor at the £25 pastry minimum).
   * The code is bound to the recipient's `userId`, so sharing it
   * with a friend (or having it scraped from an email cache) won't
   * grant a discount to anyone else.
   *
   * On the rare path where code issuance fails (transient DB error,
   * unique-collision after retries), we DON'T fall back to a static
   * code — sending a birthday email without a working code is worse
   * than silently skipping that user for the day and retrying
   * tomorrow. The error is logged with the userId so an operator
   * can re-trigger manually if needed.
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

      // Issue the per-user code FIRST so we never email a recipient
      // a code we then fail to persist. The PromoCodes service is
      // idempotent (returns the existing un-redeemed birthday code
      // if one's still valid for 24h+), so a cron retry after a
      // partial failure won't double-issue.
      let promoCodeString: string;
      try {
        const promo = await this.promoCodes.issueBirthdayCode({
          userId: u.id,
          firstName: firstNameOf(u.name) ?? u.name,
          percentOff: CronService.BIRTHDAY_PERCENT_OFF,
          validDays: CronService.BIRTHDAY_VALID_DAYS,
          minSpendMinor: CronService.BIRTHDAY_MIN_SPEND_MINOR,
        });
        promoCodeString = promo.code;
      } catch (err) {
        this.logger.error({ err, userId: u.id }, "Birthday code allocation failed; skipping");
        skipped += 1;
        continue;
      }

      try {
        const tpl = indulgenceBirthdayTemplate({
          firstName: firstNameOf(u.name) ?? u.name,
          promoCode: promoCodeString,
          validDays: CronService.BIRTHDAY_VALID_DAYS,
          accountUrl: `${publicWebUrl()}/cravings`,
        });
        await this.mailer.send({ to: u.email, ...tpl, tag: "indulgence-birthday" });

        await this.db.auditLog.create({
          data: {
            action: markerAction,
            entity: "User",
            entityId: u.id,
            actorId: "system",
            after: { promoCode: promoCodeString } as never,
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
          accountUrl: `${publicWebUrl()}/account/subscription`,
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

  // ---------- credit maintenance (expiry sweep + heads-up email) ----------

  /**
   * Daily credit-maintenance pass. Does two things in one walk, since
   * both need the same per-user accrual data:
   *
   *   1. **Expiry sweep.** For each user, find ACCRUAL rows whose
   *      `expiresAt` is in the past. Use the aggregate FIFO math
   *      `unspent_expired = max(0, expired_total − redeemed_total −
   *      previous_expiries)` to compute how much should still be
   *      forfeited, and write a single EXPIRY transaction with the
   *      negated amount. The per-day `sourceId = expiry-<YYYY-MM-DD>`
   *      combined with the DB's `@@unique([userId, sourceType,
   *      sourceId])` guarantees idempotency — re-running the same
   *      day's sweep is a no-op (a unique-violation we swallow).
   *
   *   2. **Heads-up email.** For each user with ACCRUAL rows whose
   *      `expiresAt` falls inside the next `CREDIT_EXPIRING_NOTICE_DAYS`,
   *      send one "credits expiring soon" email per accrual batch.
   *      We dedupe per-accrual via an `auditLog` row keyed on the
   *      accrual id, so the same batch is never warned about twice
   *      even across cron re-runs.
   *
   * Why both in one job: the data they need (accruals per user, with
   * `expiresAt`) is the same; running them together avoids two
   * separate full-table walks. The expiry sweep runs first so the
   * heads-up email isn't sent for a batch we've already forfeited.
   *
   * Idempotent on each pass — safe to call multiple times in a day.
   */
  async runCreditMaintenanceJob(now: Date = new Date()): Promise<{
    expired: { users: number; forfeitedMinor: number };
    expiringSoon: { sent: number; skipped: number };
  }> {
    const today = isoDate(now);

    // ---- 1. Expiry sweep ----
    // Find users with at least one ACCRUAL whose expiresAt is already
    // in the past. We start from this set so we never scan users who
    // can't possibly need a forfeit.
    const expiredUserGroups = await this.db.creditTransaction.groupBy({
      by: ["userId"],
      where: {
        type: CreditTxType.ACCRUAL,
        expiresAt: { lt: now, not: null },
      },
      _sum: { amountMinor: true },
    });

    let usersAffected = 0;
    let totalForfeitedMinor = 0;

    for (const group of expiredUserGroups) {
      const userId = group.userId;
      const expiredAccrued = group._sum.amountMinor ?? 0;
      if (expiredAccrued <= 0) continue;

      // Total redemptions over the user's lifetime (REDEMPTION rows
      // carry a NEGATIVE amountMinor, so we negate the sum to get a
      // positive magnitude). REFUND is excluded because a refund
      // restores credit (it's positive) — it shouldn't increase the
      // forfeit basis.
      const redemptionAgg = await this.db.creditTransaction.aggregate({
        where: { userId, type: CreditTxType.REDEMPTION },
        _sum: { amountMinor: true },
      });
      const redeemedTotal = Math.abs(redemptionAgg._sum.amountMinor ?? 0);

      // Sum of previous monthly-expiry forfeits (negative amounts;
      // negate for magnitude). We deliberately scope by `sourceType`
      // so the post-cancellation grace-expiry rows aren't conflated
      // with the monthly sweep.
      const previousExpiryAgg = await this.db.creditTransaction.aggregate({
        where: {
          userId,
          type: CreditTxType.EXPIRY,
          sourceType: "system.expiry-monthly",
        },
        _sum: { amountMinor: true },
      });
      const previouslyExpired = Math.abs(previousExpiryAgg._sum.amountMinor ?? 0);

      // FIFO math (see method-level docs). Clamp at 0 so a customer
      // who redeemed more than they accrued (somehow — e.g. an
      // admin adjustment offset) never sees a positive "forfeit".
      const unspentExpired = Math.max(
        0,
        expiredAccrued - redeemedTotal - previouslyExpired,
      );
      if (unspentExpired <= 0) continue;

      try {
        await this.db.creditTransaction.create({
          data: {
            userId,
            type: CreditTxType.EXPIRY,
            amountMinor: -unspentExpired,
            // Read the current balance at write time so the running
            // `balanceAfter` field stays accurate — auditors lean on
            // this column when reconciling.
            balanceAfter: await this.computeBalanceMinor(userId).then(
              (b) => b - unspentExpired,
            ),
            sourceType: "system.expiry-monthly",
            sourceId: `expiry-${today}`,
            reason: `Three-month validity window — ${unspentExpired} forfeited`,
            createdBy: "system",
          },
        });
        usersAffected += 1;
        totalForfeitedMinor += unspentExpired;
      } catch (err) {
        const e = err as { code?: string };
        // P2002 = unique constraint violation, which just means this
        // user's sweep has already been written for today — exactly
        // the idempotency we wanted. Swallow it.
        if (e.code === "P2002") {
          continue;
        }
        this.logger.error(
          { err, userId, unspentExpired },
          "Credit expiry write failed for user",
        );
      }
    }

    // ---- 2. Heads-up email for soon-to-expire accruals ----
    const noticeWindowEnd = new Date(
      now.getTime() + CronService.CREDIT_EXPIRING_NOTICE_DAYS * 24 * 60 * 60 * 1000,
    );
    // Only ACCRUAL rows whose deadline is inside [now, now+N days]
    // and which haven't already been notice-mailed. The audit-log
    // marker key includes the accrual id so each batch is warned
    // about exactly once.
    const expiringSoon = await this.db.creditTransaction.findMany({
      where: {
        type: CreditTxType.ACCRUAL,
        expiresAt: { gt: now, lt: noticeWindowEnd },
      },
      orderBy: { expiresAt: "asc" },
      select: {
        id: true,
        userId: true,
        amountMinor: true,
        expiresAt: true,
        user: { select: { email: true, name: true, deletedAt: true } },
      },
    });

    let sentCount = 0;
    let skippedCount = 0;
    for (const row of expiringSoon) {
      if (!row.user || row.user.deletedAt) {
        skippedCount += 1;
        continue;
      }

      const markerAction = `credits.expiring.${row.id}`;
      const already = await this.db.auditLog.findFirst({
        where: { entity: "User", entityId: row.userId, action: markerAction },
        select: { id: true },
      });
      if (already) {
        skippedCount += 1;
        continue;
      }

      try {
        const tpl = indulgenceCreditsExpiringTemplate({
          firstName: firstNameOf(row.user.name) ?? row.user.name,
          expiringAmountMinor: row.amountMinor,
          expiresAt: row.expiresAt ?? noticeWindowEnd,
          accountUrl: `${publicWebUrl()}/cravings`,
        });
        await this.mailer.send({
          to: row.user.email,
          ...tpl,
          tag: "indulgence-credits-expiring",
        });
        await this.db.auditLog.create({
          data: {
            action: markerAction,
            entity: "User",
            entityId: row.userId,
            actorId: "system",
          },
        });
        sentCount += 1;
      } catch (err) {
        this.logger.error(
          { err, userId: row.userId, accrualId: row.id },
          "Credit-expiring notice failed for user",
        );
        skippedCount += 1;
      }
    }

    this.logger.log(
      {
        today,
        expiredUsers: usersAffected,
        forfeitedMinor: totalForfeitedMinor,
        noticesSent: sentCount,
        noticesSkipped: skippedCount,
      },
      "Credit maintenance cron run",
    );

    return {
      expired: { users: usersAffected, forfeitedMinor: totalForfeitedMinor },
      expiringSoon: { sent: sentCount, skipped: skippedCount },
    };
  }

  /** Sum the user's CreditTransaction ledger to a running balance. */
  private async computeBalanceMinor(userId: string): Promise<number> {
    const agg = await this.db.creditTransaction.aggregate({
      where: { userId },
      _sum: { amountMinor: true },
    });
    return agg._sum.amountMinor ?? 0;
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
