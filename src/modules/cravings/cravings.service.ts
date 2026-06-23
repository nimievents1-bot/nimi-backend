import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  CreditTxType,
  type CravingsPlan,
  Prisma,
  type Subscription,
  SubscriptionStatus,
} from "@prisma/client";
import type Stripe from "stripe";

import { getEnv, publicWebUrl } from "../../config/env";
import { adminSubscriptionStartedTemplate } from "../mailer/cravings-admin-templates";
import {
  indulgenceCreditsIssuedTemplate,
  indulgenceWelcomeTemplate,
} from "../mailer/indulgence-templates";
import { MailerService } from "../mailer/mailer.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";

import { type SubscribeDto, type UpsertCravingsPlanDto } from "./dto/cravings.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * Returns true for Stripe SDK errors that mean "the resource you
 * referenced doesn't exist in this account/mode". The Stripe v17 SDK
 * leaves `err.name` as the bare string "Error" (not
 * "StripeInvalidRequestError" as older versions did), so we cannot
 * rely on the class name. Instead we check the canonical fields the
 * SDK guarantees: `type` (the discriminator) and `code` (the
 * machine-readable reason). A fallback string-match on the message
 * is included as belt-and-braces against future SDK schema changes.
 */
function isStripeResourceMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { type?: unknown; name?: unknown; code?: unknown; message?: unknown };
  if (e.code === "resource_missing") return true;
  // e.type is the Stripe API error type ("invalid_request_error"), not the class name.
  // e.name is the SDK class name ("StripeInvalidRequestError"). Check both for safety.
  const isInvalidRequest =
    e.type === "invalid_request_error" || e.name === "StripeInvalidRequestError";
  if (isInvalidRequest && typeof e.message === "string") {
    return /No such (product|price|customer|plan)/i.test(e.message) ||
      /similar object exists in test mode/i.test(e.message);
  }
  return false;
}

interface SessionUser {
  id: string;
  email: string;
}

/**
 * Default ceiling on the rolling credit balance (in minor units).
 * Configurable per environment via `CREDIT_CAP_MINOR` if needed; for now
 * the cap is constant. The cap matches the policy in the PRD.
 */
const DEFAULT_CREDIT_CAP_MINOR = 100_000; // £1,000

/**
 * Months of grace after subscription cancellation during which the customer
 * can still redeem accrued credit.
 */
const CREDIT_GRACE_MONTHS = 12;

/**
 * Per-accrual validity window — credits issued in month N are valid
 * until month N+CREDIT_VALID_MONTHS, then forfeited if unspent. The
 * Indulgence Club welcome email tells the customer "credits valid for
 * three months from issue"; this constant is the policy backing that
 * promise. Stamped onto each ACCRUAL row as `expiresAt`, swept daily
 * by the `cron/credits-maintenance` job.
 */
export const CREDIT_VALID_MONTHS = 3;

/**
 * CravingsService — owns plans, subscriptions, and the credit ledger.
 *
 * Financial-discipline rules:
 *   - The credit balance is *derived from a sum* of CreditTransaction rows.
 *     Anywhere we read the balance, we trust the sum.
 *   - Every accrual is idempotent on `(userId, sourceType, sourceId)`. A
 *     duplicate Stripe webhook never double-credits.
 *   - The cap is enforced at accrual time: anything above the cap is
 *     written as a paired ACCRUAL + CAP_FORFEIT transaction so the audit
 *     log reflects what was earned vs what was forfeited.
 *   - Status transitions go through `applySubscriptionEvent` which mirrors
 *     Stripe state — Stripe is the source of truth.
 */
/**
 * Default Indulgence Club tiers seeded on first boot.
 *
 * These match the three tiers shown on the marketing /cravings page
 * (£25 / £50 / £100) so the customer-facing UI and the database are
 * coherent from the moment the API comes up. The rows are seeded with
 * `stripePriceId = null` — the admin must run an upsert through
 * `POST /admin/cravings/plans` (or set STRIPE_SECRET_KEY before first
 * boot) to wire each tier to a real Stripe Price. Until then, the
 * subscribe endpoint refuses with a 503 and the UI shows "Coming soon".
 *
 * Slugs are stable and used in Stripe metadata; do not rename them
 * after Stripe products have been created or webhooks will mis-route.
 */
const DEFAULT_CRAVINGS_PLANS: ReadonlyArray<{
  slug: string;
  name: string;
  description: string;
  monthlyAmountMinor: number;
  position: number;
}> = [
  {
    slug: "cravings-25",
    name: "£25 / month",
    description: "A weekly treat — perfect for individuals.",
    monthlyAmountMinor: 2500,
    position: 1,
  },
  {
    slug: "cravings-50",
    name: "£50 / month",
    description: "The sweet spot for households and small offices.",
    monthlyAmountMinor: 5000,
    position: 2,
  },
  {
    slug: "cravings-100",
    name: "£100 / month",
    description: "For frequent celebrations and bigger teams.",
    monthlyAmountMinor: 10000,
    position: 3,
  },
];

@Injectable()
export class CravingsService implements OnModuleInit {
  private readonly logger = new Logger(CravingsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly stripe: StripeService,
    private readonly mailer: MailerService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Seed the three default Indulgence Club tiers if the table is empty.
   * Runs once per boot. Idempotent: if any plan exists the seeder is a
   * no-op, so the admin can rename or hide rows without them coming
   * back on the next deploy.
   *
   * Stripe wiring is intentionally NOT done here. Two reasons:
   *   1. Boot must succeed even when STRIPE_SECRET_KEY is unset.
   *   2. The Stripe Product/Price creation is non-idempotent across
   *      modes (test vs live) — the admin should make that call
   *      explicitly via the upsert endpoint, which already handles
   *      reuse + price-change archival cleanly.
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.db.cravingsPlan.count();
      if (existing > 0) return;

      await this.db.cravingsPlan.createMany({
        data: DEFAULT_CRAVINGS_PLANS.map((p) => ({
          slug: p.slug,
          name: p.name,
          description: p.description,
          monthlyAmountMinor: p.monthlyAmountMinor,
          currency: "gbp",
          position: p.position,
          active: true,
          stripeProductId: null,
          stripePriceId: null,
        })),
        skipDuplicates: true,
      });

      this.logger.log(
        `Seeded ${DEFAULT_CRAVINGS_PLANS.length} default Indulgence Club tiers ` +
          "(Stripe Price IDs pending — admin must publish via /admin/cravings/plans).",
      );
    } catch (err) {
      // Never let a seeding failure prevent the API from booting. The
      // marketing page falls back to an empty state if the table really
      // is empty, so customers see "Coming soon" rather than a crash.
      this.logger.error({ err }, "Failed to seed default Indulgence Club tiers");
    }
  }

  // ---------- public catalog ----------

  async listActivePlans(): Promise<CravingsPlan[]> {
    return this.db.cravingsPlan.findMany({
      where: { active: true },
      orderBy: [{ position: "asc" }, { monthlyAmountMinor: "asc" }],
    });
  }

  async getPlanBySlug(slug: string): Promise<CravingsPlan> {
    const row = await this.db.cravingsPlan.findUnique({ where: { slug } });
    if (!row || !row.active) throw new NotFoundException();
    return row;
  }

  /**
   * Admin-only getter that returns ANY plan by slug — active or hidden —
   * so the admin tier editor can pre-fill the form even for plans the
   * operator has chosen to hide from /cravings. Never call from a public
   * route: leaks the `stripePriceId` and `stripeProductId` which are
   * internal-only.
   */
  async getPlanBySlugForAdmin(slug: string): Promise<CravingsPlan> {
    const row = await this.db.cravingsPlan.findUnique({ where: { slug } });
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * Admin-facing listing of every plan in the catalog, including hidden
   * tiers and tiers that haven't been wired to a Stripe Price yet.
   * The boolean `stripeReady` lets the admin UI render a one-click
   * "Publish to Stripe" affordance for tiers that need finalising.
   * Never call from a public route — exposes operational state.
   */
  async listAllPlansForAdmin(): Promise<
    Array<{
      slug: string;
      name: string;
      description: string | null;
      monthlyAmountMinor: number;
      currency: string;
      position: number;
      active: boolean;
      stripeReady: boolean;
    }>
  > {
    const rows = await this.db.cravingsPlan.findMany({
      orderBy: [{ position: "asc" }, { monthlyAmountMinor: "asc" }],
    });
    return rows.map((p) => ({
      slug: p.slug,
      name: p.name,
      description: p.description,
      monthlyAmountMinor: p.monthlyAmountMinor,
      currency: p.currency,
      position: p.position,
      active: p.active,
      stripeReady: Boolean(p.stripePriceId),
    }));
  }

  // ---------- subscribe ----------

  async createSubscriptionCheckout(dto: SubscribeDto, user: SessionUser): Promise<{ url: string }> {
    if (!this.stripe.isAvailable()) {
      throw new ServiceUnavailableException("Subscriptions are not available right now.");
    }

    const plan = await this.getPlanBySlug(dto.planSlug);
    if (!plan.stripePriceId) {
      throw new ServiceUnavailableException(
        "This plan isn't configured with a Stripe price yet. Please try another plan.",
      );
    }

    // Reuse-or-create a Stripe customer pinned to our user.
    const customerId = await this.ensureStripeCustomer(user);

    const origin = publicWebUrl();

    const session = await this.stripe.sdk.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      subscription_data: {
        metadata: {
          userId: user.id,
          planId: plan.id,
          planSlug: plan.slug,
        },
      },
      success_url: `${origin}/account/subscription?status=subscribed`,
      cancel_url: `${origin}/cravings?status=cancelled`,
      allow_promotion_codes: false,
    });

    if (!session.url) {
      throw new ServiceUnavailableException("Stripe did not return a session URL.");
    }
    return { url: session.url };
  }

  /**
   * Open a Stripe Customer Portal session so the customer can pause, change
   * plan, update card, or cancel. Returns the URL the web should redirect to.
   */
  async createPortalSession(user: SessionUser): Promise<{ url: string }> {
    if (!this.stripe.isAvailable()) {
      throw new ServiceUnavailableException("Subscriptions are not available right now.");
    }

    // Require an existing Subscription row before opening the portal:
    // there's no point launching the portal for a user who has never
    // subscribed (it would just show an empty state and confuse them).
    const sub = await this.db.subscription.findUnique({ where: { userId: user.id } });
    if (!sub) throw new NotFoundException();

    // Route through `ensureStripeCustomer` so a stale stripeCustomerId
    // self-heals here too. Without this, the prior bug ("No such
    // customer" → 500) returned even though the upstream save flow
    // was already fixed.
    const customerId = await this.ensureStripeCustomer(user);

    const origin = publicWebUrl();

    const portal = await this.stripe.sdk.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/account/subscription`,
    });
    return { url: portal.url };
  }

  // ---------- customer reads ----------

  async getMySubscription(userId: string): Promise<{
    subscription: Subscription | null;
    plan: CravingsPlan | null;
    balanceMinor: number;
    creditCapMinor: number;
    recent: Awaited<ReturnType<CravingsService["recentTransactions"]>>;
  }> {
    const sub = await this.db.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });
    const balanceMinor = await this.balance(userId);
    const recent = await this.recentTransactions(userId);
    return {
      subscription: sub,
      plan: sub?.plan ?? null,
      balanceMinor,
      creditCapMinor: DEFAULT_CREDIT_CAP_MINOR,
      recent,
    };
  }

  async balance(userId: string): Promise<number> {
    const result = await this.db.creditTransaction.aggregate({
      where: { userId },
      _sum: { amountMinor: true },
    });
    return result._sum.amountMinor ?? 0;
  }

  async recentTransactions(userId: string, limit = 12) {
    return this.db.creditTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  // ---------- admin ----------

  async upsertPlan(dto: UpsertCravingsPlanDto): Promise<CravingsPlan> {
    if (!this.stripe.isAvailable() && dto.active) {
      throw new ServiceUnavailableException(
        "Stripe must be configured before publishing a plan.",
      );
    }

    const existing = await this.db.cravingsPlan.findUnique({ where: { slug: dto.slug } });
    const currency = dto.currency ?? "gbp";

    let stripeProductId = existing?.stripeProductId ?? null;
    let stripePriceId = existing?.stripePriceId ?? null;

    // Create / reuse Stripe Product + Price when the price changes
    // or the plan is being published.
    //
    // Self-healing path: if `stripeProductId` is set but the product
    // no longer exists in Stripe (e.g. the operator deleted it in
    // the dashboard, or the env was switched between test and live
    // mode and IDs from one don't exist in the other), Stripe throws
    // `StripeInvalidRequestError` with `code: "resource_missing"`.
    // Treat that as "the stored ID is stale" and fall back to
    // creating a fresh product. Without this, every save on a tier
    // with a stale ID would 500 forever, and the operator would have
    // to edit the DB by hand to recover. Same logic for the price.
    if (this.stripe.isAvailable()) {
      let product: Stripe.Product | null = null;
      if (stripeProductId) {
        try {
          product = await this.stripe.sdk.products.update(stripeProductId, {
            name: dto.name,
            ...(dto.description ? { description: dto.description } : {}),
          });
        } catch (err) {
          // Narrow on the Stripe code rather than err.name because
          // the SDK leaves `.name` as the literal "Error" — see the
          // exception filter's classifyError for the gory details.
          if (isStripeResourceMissing(err)) {
            this.logger.warn(
              { planSlug: dto.slug, staleId: stripeProductId },
              "Stored stripeProductId no longer exists in Stripe — recreating.",
            );
            stripeProductId = null;
            // Also clear the price ID — a price is bound to a
            // specific product, so the stale product invalidates
            // the price too. We'll mint both anew below.
            stripePriceId = null;
          } else {
            throw err;
          }
        }
      }
      if (!product) {
        product = await this.stripe.sdk.products.create({
          name: dto.name,
          ...(dto.description ? { description: dto.description } : {}),
          metadata: { planSlug: dto.slug },
        });
      }
      stripeProductId = product.id;

      const needsNewPrice =
        !stripePriceId ||
        existing?.monthlyAmountMinor !== dto.monthlyAmountMinor ||
        (existing?.currency ?? "gbp") !== currency;

      if (needsNewPrice) {
        // Archive the old price so it can't be used by new
        // checkouts. Swallow errors here because the price might
        // already be archived or missing — we don't want a stale
        // ID lookup to block the main save path. Distinct from
        // the product recovery above, which is needed for
        // correctness; this is best-effort cleanup.
        if (stripePriceId) {
          await this.stripe.sdk.prices
            .update(stripePriceId, { active: false })
            .catch(() => {});
        }
        const price = await this.stripe.sdk.prices.create({
          unit_amount: dto.monthlyAmountMinor,
          currency,
          recurring: { interval: "month" },
          product: stripeProductId,
          metadata: { planSlug: dto.slug },
        });
        stripePriceId = price.id;
      }
    }

    return this.db.cravingsPlan.upsert({
      where: { slug: dto.slug },
      create: {
        slug: dto.slug,
        name: dto.name,
        monthlyAmountMinor: dto.monthlyAmountMinor,
        currency,
        description: dto.description ?? null,
        // Tri-state on `imageUrl`: undefined → use null on create;
        // explicit null → null; string → set.
        imageUrl: dto.imageUrl ?? null,
        position: dto.position ?? 0,
        active: dto.active ?? false,
        stripeProductId,
        stripePriceId,
      },
      update: {
        name: dto.name,
        monthlyAmountMinor: dto.monthlyAmountMinor,
        currency,
        description: dto.description ?? null,
        // On update: undefined → don't touch (preserve existing
        // image); null → clear; string → set. Matches the
        // pattern used for batchLimit on PastryItem.
        ...(dto.imageUrl !== undefined
          ? { imageUrl: dto.imageUrl === null ? null : dto.imageUrl }
          : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        stripeProductId,
        stripePriceId,
      },
    });
  }

  async listAdminSubscribers(opts: { limit?: number; offset?: number; status?: SubscriptionStatus }) {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const where: Prisma.SubscriptionWhereInput = {};
    if (opts.status) where.status = opts.status;

    const [rows, total] = await this.db.$transaction([
      this.db.subscription.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          user: {
            select: {
              email: true,
              name: true,
              phone: true,
              // Surface the default delivery address so the admin
              // table can show where to ship the monthly package
              // without having to drill into each profile.
              addressLine1: true,
              addressLine2: true,
              addressCity: true,
              addressPostcode: true,
              addressCountry: true,
            },
          },
          plan: true,
        },
      }),
      this.db.subscription.count({ where }),
    ]);

    // Attach balance for each (small N — for v1 this is fine; cache later).
    const withBalances = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        balanceMinor: await this.balance(r.userId),
      })),
    );

    return { rows: withBalances, total, limit, offset };
  }

  async adminAdjustCredit(
    userId: string,
    amountMinor: number,
    reason: string,
    actorId: string,
    meta: RequestMeta,
  ) {
    if (amountMinor === 0) throw new BadRequestException("Amount must be non-zero.");

    const txId = `adj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return this.applyTransaction({
      userId,
      type: CreditTxType.ADJUSTMENT,
      amountMinor,
      sourceType: "admin",
      sourceId: txId,
      reason,
      createdBy: actorId,
      meta,
    });
  }

  // ---------- webhook handlers ----------

  /**
   * customer.subscription.{created,updated,deleted} — mirror Stripe state
   * into our Subscription row. We never decide subscription state ourselves.
   */
  async onSubscriptionEvent(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    const userId = sub.metadata?.userId;
    if (!userId) {
      this.logger.warn({ subscriptionId: sub.id }, "Subscription event has no userId metadata");
      return;
    }

    const planId = sub.metadata?.planId ?? null;
    const stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const status = mapStripeStatus(sub.status, Boolean(sub.pause_collection));
    const item = sub.items.data[0];
    const monthlyAmountMinor = item?.price.unit_amount ?? 0;
    const currency = item?.price.currency ?? "gbp";

    const data: Prisma.SubscriptionUpdateInput = {
      status,
      stripeSubscriptionId: sub.id,
      monthlyAmountMinor,
      currency,
      currentPeriodStart: sub.current_period_start
        ? new Date(sub.current_period_start * 1000)
        : null,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      pausedUntil: sub.pause_collection?.resumes_at
        ? new Date(sub.pause_collection.resumes_at * 1000)
        : null,
      cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
      cancelledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    };

    if (status === SubscriptionStatus.CANCELLED || status === SubscriptionStatus.ENDED) {
      data.creditExpiresAt = addMonths(new Date(), CREDIT_GRACE_MONTHS);
    }

    await this.db.subscription.upsert({
      where: { userId },
      create: {
        userId,
        planId,
        stripeCustomerId,
        stripeSubscriptionId: sub.id,
        status,
        monthlyAmountMinor,
        currency,
        currentPeriodStart: data.currentPeriodStart as Date | null,
        currentPeriodEnd: data.currentPeriodEnd as Date | null,
        pausedUntil: data.pausedUntil as Date | null,
        cancelAt: data.cancelAt as Date | null,
        cancelledAt: data.cancelledAt as Date | null,
        creditExpiresAt: data.creditExpiresAt as Date | undefined,
      },
      update: data,
    });

    // Send the welcome email on the *first* transition to ACTIVE. We
    // detect "first transition" by checking that we don't already have a
    // CONFIRMATION row for this subscription id — idempotent against
    // Stripe webhook retries and the rare ACTIVE → PAUSED → ACTIVE flow.
    //
    // The admin notification fires alongside the customer welcome, with
    // its own audit marker so Stripe webhook retries can't double-send
    // either email. Both are wrapped in try/catch — a mail-provider
    // wobble must not cause the webhook to fail (which would make
    // Stripe retry the whole event indefinitely).
    if (status === SubscriptionStatus.ACTIVE) {
      try {
        await this.sendWelcomeIfFirstTime({
          userId,
          stripeSubscriptionId: sub.id,
          monthlyAmountMinor,
        });
      } catch (err) {
        this.logger.warn(
          { err, userId, subscriptionId: sub.id },
          "Indulgence welcome email failed (non-fatal)",
        );
      }
      try {
        await this.sendAdminSubscriptionIfFirstTime({
          userId,
          stripeSubscriptionId: sub.id,
          monthlyAmountMinor,
          currency,
          currentPeriodEnd: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
        });
      } catch (err) {
        this.logger.warn(
          { err, userId, subscriptionId: sub.id },
          "Admin subscription notification failed (non-fatal)",
        );
      }
    }
  }

  /**
   * invoice.paid for a Cravings subscription — accrue credit, capped.
   * Idempotent on the (userId, "stripe.invoice", invoice.id) tuple.
   */
  async onInvoicePaid(event: Stripe.Event): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;
    if (!invoice.subscription) return;

    const subscriptionId =
      typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription.id;

    const ourSub = await this.db.subscription.findUnique({
      where: { stripeSubscriptionId: subscriptionId },
    });
    if (!ourSub) {
      this.logger.warn({ invoiceId: invoice.id, subscriptionId }, "Invoice for unknown subscription");
      return;
    }

    if (invoice.amount_paid <= 0) return;

    const result = await this.applyTransaction({
      userId: ourSub.userId,
      type: CreditTxType.ACCRUAL,
      amountMinor: invoice.amount_paid,
      sourceType: "stripe.invoice",
      sourceId: invoice.id,
      reason: `Cravings monthly accrual for invoice ${invoice.id}`,
      createdBy: "system",
      meta: {},
    });

    // Send the "credits available" email — only when `applied: true`, so
    // duplicate webhook deliveries don't double-mail the customer.
    if (result.applied) {
      try {
        const user = await this.db.user.findUnique({
          where: { id: ourSub.userId },
          select: { email: true, name: true },
        });
        if (user) {
          const tpl = indulgenceCreditsIssuedTemplate({
            firstName: firstNameOf(user.name) ?? user.name,
            amountMinor: invoice.amount_paid,
            balanceMinor: result.balanceAfter,
            accountUrl: `${publicWebUrl()}/account/subscription`,
          });
          await this.mailer.send({
            to: user.email,
            ...tpl,
            tag: "indulgence-credits-issued",
          });
        }
      } catch (err) {
        this.logger.warn(
          { err, invoiceId: invoice.id },
          "Indulgence credits-issued email failed (non-fatal)",
        );
      }
    }
  }

  /**
   * Charge refund — write a negative REFUND transaction tied to the original invoice.
   * (Phase 5.1 will add a more sophisticated mapping; for now we attribute it to the
   *  most recent ACCRUAL for that invoice if we can find it.)
   */
  async onCravingsRefund(charge: Stripe.Charge): Promise<void> {
    const invoiceId = typeof charge.invoice === "string" ? charge.invoice : null;
    if (!invoiceId) return;

    const accrual = await this.db.creditTransaction.findFirst({
      where: { sourceType: "stripe.invoice", sourceId: invoiceId, type: CreditTxType.ACCRUAL },
      orderBy: { createdAt: "desc" },
    });
    if (!accrual) return;

    const refundAmount = charge.amount_refunded;
    if (refundAmount <= 0) return;

    await this.applyTransaction({
      userId: accrual.userId,
      type: CreditTxType.REFUND,
      amountMinor: -Math.min(refundAmount, accrual.amountMinor),
      sourceType: "stripe.refund",
      sourceId: charge.id,
      reason: `Refund for invoice ${invoiceId}`,
      createdBy: "system",
      meta: {},
    });
  }

  // ---------- ledger primitive ----------

  /**
   * Apply a credit transaction with cap enforcement and idempotency.
   *
   * - For ACCRUAL: if the new balance would exceed `DEFAULT_CREDIT_CAP_MINOR`,
   *   we write the up-to-cap accrual *and* a CAP_FORFEIT row equal to the
   *   excess so the books reconcile and the customer sees what was forfeited.
   * - Other types apply directly.
   * - Idempotency: relies on the unique `(userId, sourceType, sourceId)`
   *   index. Duplicates throw P2002, which we translate to "already applied"
   *   and return the existing row.
   */
  private async applyTransaction(params: {
    userId: string;
    type: CreditTxType;
    amountMinor: number;
    sourceType: string;
    sourceId: string | null;
    reason: string;
    createdBy: string;
    meta: RequestMeta;
  }): Promise<{ applied: boolean; balanceAfter: number }> {
    return this.db.$transaction(async (tx) => {
      // Idempotency check using the unique constraint.
      if (params.sourceId) {
        const existing = await tx.creditTransaction.findUnique({
          where: {
            userId_sourceType_sourceId: {
              userId: params.userId,
              sourceType: params.sourceType,
              sourceId: params.sourceId,
            },
          },
        });
        if (existing) {
          return { applied: false, balanceAfter: existing.balanceAfter };
        }
      }

      const before = await tx.creditTransaction.aggregate({
        where: { userId: params.userId },
        _sum: { amountMinor: true },
      });
      const balanceBefore = before._sum.amountMinor ?? 0;

      if (params.type === CreditTxType.ACCRUAL) {
        // Per-accrual 3-month expiry — the Indulgence Club's
        // "credits valid for three months from issue" policy. Stamped
        // here so every accrual carries its own deadline; the daily
        // credit-maintenance cron will forfeit any unspent remainder
        // once `expiresAt` is in the past.
        const accrualExpiresAt = addMonths(new Date(), CREDIT_VALID_MONTHS);

        const wouldBe = balanceBefore + params.amountMinor;
        if (wouldBe <= DEFAULT_CREDIT_CAP_MINOR) {
          await tx.creditTransaction.create({
            data: {
              userId: params.userId,
              type: CreditTxType.ACCRUAL,
              amountMinor: params.amountMinor,
              balanceAfter: wouldBe,
              sourceType: params.sourceType,
              sourceId: params.sourceId,
              reason: params.reason,
              createdBy: params.createdBy,
              expiresAt: accrualExpiresAt,
            },
          });
          return { applied: true, balanceAfter: wouldBe };
        }
        // Partial accrual + forfeit overflow.
        const headroom = Math.max(0, DEFAULT_CREDIT_CAP_MINOR - balanceBefore);
        const forfeit = params.amountMinor - headroom;
        const cappedBalance = balanceBefore + headroom;

        if (headroom > 0) {
          await tx.creditTransaction.create({
            data: {
              userId: params.userId,
              type: CreditTxType.ACCRUAL,
              amountMinor: headroom,
              balanceAfter: cappedBalance,
              sourceType: params.sourceType,
              sourceId: params.sourceId,
              reason: params.reason,
              createdBy: params.createdBy,
              expiresAt: accrualExpiresAt,
            },
          });
        }

        if (forfeit > 0) {
          await tx.creditTransaction.create({
            data: {
              userId: params.userId,
              type: CreditTxType.CAP_FORFEIT,
              amountMinor: 0, // forfeit doesn't change balance — it's an information row
              balanceAfter: cappedBalance,
              sourceType: params.sourceType,
              sourceId: params.sourceId ? `${params.sourceId}#forfeit` : null,
              reason: `Cap reached — forfeited ${forfeit} ${"minor"}`,
              createdBy: "system",
            },
          });
        }

        return { applied: true, balanceAfter: cappedBalance };
      }

      // Non-accrual.
      const newBalance = balanceBefore + params.amountMinor;
      await tx.creditTransaction.create({
        data: {
          userId: params.userId,
          type: params.type,
          amountMinor: params.amountMinor,
          balanceAfter: newBalance,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          reason: params.reason,
          createdBy: params.createdBy,
        },
      });
      return { applied: true, balanceAfter: newBalance };
    });
  }

  // ---------- helpers ----------

  /**
   * Send the Indulgence Club welcome email exactly once per Stripe
   * subscription. Idempotency is enforced via an auditLog row; any
   * re-delivery of the `customer.subscription.{created,updated}` event
   * just sees the marker and skips.
   *
   * Why audit log and not a column on Subscription: it avoids a schema
   * change, gives us a free trail of when the welcome was sent, and
   * survives plan changes / re-subscriptions cleanly (each new Stripe
   * subscription id is its own welcome trigger).
   */
  private async sendWelcomeIfFirstTime(opts: {
    userId: string;
    stripeSubscriptionId: string;
    monthlyAmountMinor: number;
  }): Promise<void> {
    const marker = await this.db.auditLog.findFirst({
      where: {
        entity: "Subscription",
        entityId: opts.stripeSubscriptionId,
        action: "subscription.welcome_sent",
      },
      select: { id: true },
    });
    if (marker) return;

    const user = await this.db.user.findUnique({
      where: { id: opts.userId },
      select: { email: true, name: true },
    });
    if (!user) return;

    const tpl = indulgenceWelcomeTemplate({
      firstName: firstNameOf(user.name) ?? user.name,
      monthlyAmountMinor: opts.monthlyAmountMinor,
      accountUrl: `${publicWebUrl()}/account/subscription`,
    });

    await this.mailer.send({
      to: user.email,
      ...tpl,
      tag: "indulgence-welcome",
    });

    // Persist the marker so a webhook retry never double-sends.
    await this.db.auditLog.create({
      data: {
        action: "subscription.welcome_sent",
        entity: "Subscription",
        entityId: opts.stripeSubscriptionId,
        actorId: "system",
      },
    });
  }

  /**
   * Admin notification for a new subscriber. Audit-marker pattern is
   * identical to `sendWelcomeIfFirstTime` so Stripe webhook retries
   * (or the ACTIVE → PAUSED → ACTIVE pattern) can't fire the email
   * twice. Sent to `SUPPORT_INBOX`, with reply-to set to the
   * subscriber so the kitchen team can answer them directly.
   *
   * Loads the customer's saved profile address so the admin email
   * shows where to ship monthly deliveries to without needing to dig
   * through Stripe Dashboard or chase the customer.
   */
  private async sendAdminSubscriptionIfFirstTime(opts: {
    userId: string;
    stripeSubscriptionId: string;
    monthlyAmountMinor: number;
    currency: string;
    currentPeriodEnd: string | null;
  }): Promise<void> {
    const marker = await this.db.auditLog.findFirst({
      where: {
        entity: "Subscription",
        entityId: opts.stripeSubscriptionId,
        action: "subscription.admin_notified",
      },
      select: { id: true },
    });
    if (marker) return;

    const user = await this.db.user.findUnique({
      where: { id: opts.userId },
      select: {
        email: true,
        name: true,
        phone: true,
        addressLine1: true,
        addressLine2: true,
        addressCity: true,
        addressPostcode: true,
        addressCountry: true,
        subscription: {
          select: { plan: { select: { name: true } } },
        },
      },
    });
    if (!user) {
      this.logger.warn(
        { userId: opts.userId, subscriptionId: opts.stripeSubscriptionId },
        "Admin subscription notify: user vanished",
      );
      return;
    }

    const env = getEnv();
    const tpl = adminSubscriptionStartedTemplate({
      customerName: user.name,
      customerEmail: user.email,
      customerPhone: user.phone,
      planName: user.subscription?.plan?.name ?? "Indulgence Club",
      monthlyAmountMinor: opts.monthlyAmountMinor,
      currency: opts.currency,
      currentPeriodEnd: opts.currentPeriodEnd,
      address: {
        line1: user.addressLine1,
        line2: user.addressLine2,
        city: user.addressCity,
        postcode: user.addressPostcode,
        country: user.addressCountry,
      },
      adminUrl: `${publicWebUrl()}/admin/cravings`,
    });

    await this.mailer.send({
      to: env.SUPPORT_INBOX,
      replyTo: user.email,
      ...tpl,
      tag: "indulgence-admin-subscription-started",
    });

    // In-app notification for every staff member so the team sees the
    // new subscriber in the bell dropdown even if the email lands in
    // a spam folder. Fire-and-forget — a notification write failure
    // must not cause the webhook handler to fail (Stripe would retry
    // the whole event indefinitely otherwise).
    const planName = user.subscription?.plan?.name ?? "Indulgence Club";
    const monthlyDisplay = `${opts.currency.toUpperCase()} ${(opts.monthlyAmountMinor / 100).toFixed(2)}`;
    void this.notifications.notifyStaff({
      kind: "cravings.subscription.new",
      title: `New Indulgence Club subscriber: ${user.name}`,
      body: `${planName} · ${monthlyDisplay}/month`,
      href: "/admin/cravings",
    });

    // Marker prevents a Stripe retry (or a PAUSED↔ACTIVE flap) from
    // sending a second admin email.
    await this.db.auditLog.create({
      data: {
        action: "subscription.admin_notified",
        entity: "Subscription",
        entityId: opts.stripeSubscriptionId,
        actorId: "system",
      },
    });
  }

  private async ensureStripeCustomer(user: SessionUser): Promise<string> {
    const existing = await this.db.subscription.findUnique({ where: { userId: user.id } });
    if (existing?.stripeCustomerId) {
      // Verify the cached ID is still valid in Stripe. Three things
      // can invalidate it: the operator deletes the customer in the
      // dashboard; we switch the API key between live and test mode;
      // a Stripe restore-from-backup invalidates the prior IDs.
      // Without this check, every downstream call (portal session,
      // checkout) 500s with "No such customer" and there's no
      // recovery short of editing the DB by hand. Self-heal by
      // detecting the stale ID and minting a fresh customer below.
      try {
        const customer = await this.stripe.sdk.customers.retrieve(
          existing.stripeCustomerId,
        );
        // `retrieve` can return either a live customer or a
        // "deleted: true" stub — both are objects. We treat the
        // stub as "no usable customer" because Stripe will reject
        // it from checkout / portal sessions even though it does
        // technically exist in the account.
        if (!customer.deleted) return existing.stripeCustomerId;
        this.logger.warn(
          { userId: user.id, staleId: existing.stripeCustomerId },
          "Stored stripeCustomerId is marked deleted in Stripe — recreating.",
        );
      } catch (err) {
        if (isStripeResourceMissing(err)) {
          this.logger.warn(
            { userId: user.id, staleId: existing.stripeCustomerId },
            "Stored stripeCustomerId no longer exists in Stripe — recreating.",
          );
        } else {
          throw err;
        }
      }
    }

    const customer = await this.stripe.sdk.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });

    await this.db.subscription.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        stripeCustomerId: customer.id,
        status: SubscriptionStatus.PENDING,
        monthlyAmountMinor: 0,
        currency: "gbp",
      },
      update: { stripeCustomerId: customer.id },
    });

    return customer.id;
  }
}

function mapStripeStatus(status: string, isPaused: boolean): SubscriptionStatus {
  if (isPaused) return SubscriptionStatus.PAUSED;
  switch (status) {
    case "active":
    case "trialing":
      return SubscriptionStatus.ACTIVE;
    case "past_due":
    case "unpaid":
      return SubscriptionStatus.PAST_DUE;
    case "canceled":
      return SubscriptionStatus.CANCELLED;
    case "incomplete":
    case "incomplete_expired":
      return SubscriptionStatus.PENDING;
    default:
      return SubscriptionStatus.PENDING;
  }
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function firstNameOf(displayName: string): string | undefined {
  const trimmed = displayName.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/)[0];
}
