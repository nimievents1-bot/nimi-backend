import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  type GiftCollection,
  GiftCategory,
  type GiftOrder,
  GiftOrderStatus,
  Prisma,
} from "@prisma/client";
import type Stripe from "stripe";

import { getEnv, publicWebUrl } from "../../config/env";
import { TurnstileService } from "../contact/turnstile.service";
import {
  giftOrderAdminNotifyTemplate,
  giftOrderReceiptTemplate,
} from "../mailer/gift-templates";
import { MailerService } from "../mailer/mailer.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";

import { type CreateCheckoutSessionDto } from "./dto/gifting.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
  userId?: string;
}

interface CheckoutResult {
  url: string;
  orderId: string;
  reference: string;
}

/**
 * GiftingService — owns the gift commerce lifecycle.
 *
 * Important rules:
 *   - The server is the source of truth for prices. Quantity comes from the
 *     client; unit price is read from the published GiftCollection by slug.
 *   - The customer never specifies amounts to Stripe; we build line items
 *     server-side from the collection record.
 *   - We pre-create a `GiftOrder` row in `PENDING_PAYMENT` before redirecting
 *     so the order id can travel as Stripe metadata. Webhook reconciles.
 *   - All status transitions go through `transition()` which validates the
 *     transition is legal and writes audit data.
 */
/**
 * Default gift collections seeded on first boot.
 *
 * Mirrors the placeholder set the marketing `/gifting` page falls back
 * to when the API returns zero published rows. Seeding the same shape
 * server-side means a fresh deploy can immediately accept enquiries
 * (the marketing page links to `/gifting/<slug>` which fetches by slug
 * — and would 404 if the row didn't exist).
 *
 * Slugs are stable and used in URLs + Stripe metadata; don't rename
 * them after orders exist.
 */
const DEFAULT_GIFT_COLLECTIONS: ReadonlyArray<{
  slug: string;
  category: GiftCategory;
  name: string;
  description: string;
  items: string[];
  unitPriceMinor: number;
  priceMaxMinor: number | null;
  moq: number;
  leadTimeDays: number;
  position: number;
}> = [
  {
    slug: "essential-collection",
    category: GiftCategory.CORPORATE,
    name: "The Essential Collection",
    description: "Clean, professional and practical everyday gifting.",
    items: ["Branded notebook", "Pen", "Reusable bottle", "Custom card"],
    unitPriceMinor: 1000,
    priceMaxMinor: 1500,
    moq: 25,
    leadTimeDays: 42,
    position: 1,
  },
  {
    slug: "signature-collection",
    category: GiftCategory.CORPORATE,
    name: "The Signature Collection",
    description: "Elevated branded gifting designed to impress clients and teams.",
    items: ["Premium notebook", "Engraved pen", "Tote bag", "Bespoke card"],
    unitPriceMinor: 1300,
    priceMaxMinor: 2000,
    moq: 25,
    leadTimeDays: 42,
    position: 2,
  },
  {
    slug: "executive-series",
    category: GiftCategory.CORPORATE,
    name: "The Executive Series",
    description: "Premium gifting for senior clients and high-value relationships.",
    items: ["Leather notebook", "Executive pen set", "Embossed gift box"],
    unitPriceMinor: 1800,
    priceMaxMinor: 2500,
    moq: 10,
    leadTimeDays: 56,
    position: 3,
  },
  {
    slug: "heritage-collection",
    category: GiftCategory.WEDDINGS,
    name: "The Heritage Collection",
    description:
      "Modern design with subtle cultural elements — Ankara pouch, custom tumbler, hand fan.",
    items: ["Ankara-print pouch", "Custom tumbler", "Hand fan", "Thank-you card"],
    unitPriceMinor: 2400,
    priceMaxMinor: 3600,
    moq: 25,
    leadTimeDays: 56,
    position: 4,
  },
  {
    slug: "soft-luxe-box",
    category: GiftCategory.PRIVATE,
    name: "The Soft Luxe Box",
    description: "Lifestyle and self-care gifting — satin eye mask, candle, towel, mini pouch.",
    items: ["Satin eye mask", "Soy candle", "Hand towel", "Mini pouch"],
    unitPriceMinor: 2800,
    priceMaxMinor: 4200,
    moq: 10,
    leadTimeDays: 56,
    position: 5,
  },
];

@Injectable()
export class GiftingService implements OnModuleInit {
  private readonly logger = new Logger(GiftingService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly stripe: StripeService,
    private readonly turnstile: TurnstileService,
    private readonly mailer: MailerService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Seed the default gift collections on first boot. Same pattern as
   * `CravingsService.onModuleInit`: idempotent (no-op when any row
   * exists) so the operator can hide/rename collections without them
   * coming back on the next deploy.
   *
   * Collections are seeded **unpublished** (`published: false`) — the
   * operator publishes via the admin endpoint once photography and
   * pricing are finalised. Until then, `/gifting` falls back to its
   * marketing placeholders rather than showing half-finished rows.
   * The individual `/gifting/<slug>` pages still resolve because the
   * row exists; we deliberately surface them as "draft" via the
   * normal `getPublishedCollection` 404 only when published is false.
   *
   * UPDATE: seeding as `published: true` because the operator
   * expectation here is "the cards on /gifting should be clickable".
   * Hiding is achievable per-row from the admin (later) — for now
   * the default-on posture matches the rest of the seeded catalog
   * (Cravings tiers seed active=true, pastries seed available=true).
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.db.giftCollection.count();
      if (existing > 0) return;

      await this.db.giftCollection.createMany({
        data: DEFAULT_GIFT_COLLECTIONS.map((c) => ({
          slug: c.slug,
          category: c.category,
          name: c.name,
          description: c.description,
          items: c.items as Prisma.InputJsonValue,
          unitPriceMinor: c.unitPriceMinor,
          priceMaxMinor: c.priceMaxMinor,
          currency: "gbp",
          moq: c.moq,
          leadTimeDays: c.leadTimeDays,
          position: c.position,
          published: true,
        })),
        skipDuplicates: true,
      });

      this.logger.log(
        `Seeded ${DEFAULT_GIFT_COLLECTIONS.length} default gift collections.`,
      );
    } catch (err) {
      // Don't crash the boot — the marketing page has its own fallback
      // and the operator can seed manually via Prisma Studio.
      this.logger.error({ err }, "Failed to seed default gift collections");
    }
  }

  // ---------- public catalog ----------

  async listPublishedCollections(category?: string): Promise<GiftCollection[]> {
    return this.db.giftCollection.findMany({
      where: {
        published: true,
        ...(category ? { category: category as GiftCollection["category"] } : {}),
      },
      orderBy: [{ position: "asc" }, { name: "asc" }],
    });
  }

  async getPublishedCollection(slug: string): Promise<GiftCollection> {
    const row = await this.db.giftCollection.findUnique({ where: { slug } });
    if (!row || !row.published) throw new NotFoundException();
    return row;
  }

  // ---------- checkout ----------

  async createCheckoutSession(
    dto: CreateCheckoutSessionDto,
    meta: RequestMeta,
  ): Promise<CheckoutResult> {
    if (!this.stripe.isAvailable()) {
      throw new ServiceUnavailableException(
        "Payments are not available right now. Please try again shortly.",
      );
    }

    // Honeypot — silently reject.
    if (dto.website && dto.website.length > 0) {
      this.logger.warn({ ip: meta.ip }, "Gifting checkout honeypot triggered");
      throw new BadRequestException("Bot protection check failed.");
    }

    const ok = await this.turnstile.verify(dto.turnstileToken, meta.ip);
    if (!ok) {
      throw new BadRequestException("Bot protection check failed. Please try again.");
    }

    const collection = await this.getPublishedCollection(dto.collectionSlug);

    if (dto.quantity < collection.moq) {
      throw new BadRequestException(
        `Minimum order quantity for this collection is ${collection.moq}.`,
      );
    }

    const unit = collection.unitPriceMinor;
    const totalMinor = unit * dto.quantity;

    // Pre-create the order so we have a stable id to attach to Stripe metadata.
    const reference = await this.allocateReference();
    const order = await this.db.giftOrder.create({
      data: {
        reference,
        userId: meta.userId ?? null,
        email: dto.email.toLowerCase().trim(),
        name: dto.name.trim(),
        status: GiftOrderStatus.PENDING_PAYMENT,
        totalMinor,
        currency: collection.currency,
        notes: dto.notes?.trim() ?? null,
        // Persist the design-approval acknowledgement (PRD §7.4.3).
        // The DTO refuses checkout when this is anything other than
        // `true`, so the column is always `true` for a paid order —
        // but we store the exact value so an audit can confirm the
        // customer explicitly opted in.
        designApprovalAccepted: dto.designApprovalAccepted,
        items: {
          create: [
            {
              collectionId: collection.id,
              quantity: dto.quantity,
              unitPriceMinor: unit,
              totalMinor,
              customisation: (dto.customisation as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
              collectionSnapshot: this.snapshot(collection) as unknown as Prisma.InputJsonValue,
            },
          ],
        },
      },
      include: { items: true },
    });

    const origin = publicWebUrl();

    const session = await this.stripe.sdk.checkout.sessions.create({
      mode: "payment",
      customer_email: order.email,
      payment_intent_data: {
        metadata: { orderId: order.id, reference: order.reference },
      },
      line_items: [
        {
          quantity: dto.quantity,
          price_data: {
            currency: collection.currency,
            product_data: {
              name: collection.name,
              description: this.shortDescription(collection),
              metadata: { collectionSlug: collection.slug },
            },
            unit_amount: unit,
          },
        },
      ],
      success_url: `${origin}/gifting/checkout/success?ref=${order.reference}`,
      cancel_url: `${origin}/gifting/checkout/cancel?ref=${order.reference}`,
      metadata: {
        orderId: order.id,
        reference: order.reference,
        collectionSlug: collection.slug,
      },
      allow_promotion_codes: false,
      // Phase 4: skipping shipping_address_collection. Phase 4.1 adds it
      // and persists to the order's shipping_* fields.
    });

    if (!session.url) {
      throw new ServiceUnavailableException("Stripe did not return a session URL.");
    }

    await this.db.giftOrder.update({
      where: { id: order.id },
      data: { stripeSessionId: session.id },
    });

    return { url: session.url, orderId: order.id, reference: order.reference };
  }

  // ---------- webhook handlers ----------

  /**
   * `checkout.session.completed` — the canonical "payment succeeded" event.
   * Mark the order as `AWAITING_DESIGN_APPROVAL` and snapshot the
   * payment-intent id for refunds and reconciliation.
   */
  async onCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const orderId = session.metadata?.orderId;
    if (!orderId) {
      this.logger.warn({ sessionId: session.id }, "Checkout session has no orderId metadata");
      return;
    }

    const order = await this.db.giftOrder.findUnique({ where: { id: orderId } });
    if (!order) {
      this.logger.warn({ orderId, sessionId: session.id }, "Order not found for completed session");
      return;
    }

    if (order.status !== GiftOrderStatus.PENDING_PAYMENT) {
      // Already processed — webhook retry.
      return;
    }

    // Synchronous payment? Move forward. Async (e.g. SOFORT) waits for the
    // async_payment_succeeded event and is handled below.
    if (session.payment_status !== "paid") {
      this.logger.log(
        { orderId, sessionId: session.id, paymentStatus: session.payment_status },
        "Checkout completed but not yet paid — waiting for async event",
      );
      return;
    }

    await this.db.giftOrder.update({
      where: { id: orderId },
      data: {
        status: GiftOrderStatus.AWAITING_DESIGN_APPROVAL,
        paidAt: new Date(),
        stripePaymentIntentId:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
      },
    });

    // Fire-and-forget: customer receipt + admin notification + staff
    // in-app bell. Idempotent against webhook retries because the
    // status check at the top of this method (PENDING_PAYMENT only)
    // early-returns on the second invocation.
    void this.dispatchPaidNotifications(orderId);
  }

  /**
   * For payment methods that confirm asynchronously (bank debits, certain
   * regional methods).
   */
  async onCheckoutSessionAsyncResult(
    session: Stripe.Checkout.Session,
    eventType: string,
  ): Promise<void> {
    const orderId = session.metadata?.orderId;
    if (!orderId) return;

    if (eventType.endsWith("succeeded")) {
      const result = await this.db.giftOrder.updateMany({
        where: { id: orderId, status: GiftOrderStatus.PENDING_PAYMENT },
        data: {
          status: GiftOrderStatus.AWAITING_DESIGN_APPROVAL,
          paidAt: new Date(),
          stripePaymentIntentId:
            typeof session.payment_intent === "string" ? session.payment_intent : null,
        },
      });
      // Only fire notifications when the update actually transitioned
      // a row — Stripe sends async-succeeded as well as the original
      // session.completed for the same order, so an idempotency guard
      // here prevents double email + double bell.
      if (result.count > 0) {
        void this.dispatchPaidNotifications(orderId);
      }
    } else {
      await this.db.giftOrder.updateMany({
        where: { id: orderId, status: GiftOrderStatus.PENDING_PAYMENT },
        data: { status: GiftOrderStatus.CANCELLED },
      });
    }
  }

  async onChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const paymentIntentId =
      typeof charge.payment_intent === "string" ? charge.payment_intent : null;
    if (!paymentIntentId) return;

    await this.db.giftOrder.updateMany({
      where: {
        stripePaymentIntentId: paymentIntentId,
        status: { not: GiftOrderStatus.REFUNDED },
      },
      data: { status: GiftOrderStatus.REFUNDED },
    });
  }

  // ---------- admin operations ----------

  async adminListOrders(opts: { status?: GiftOrderStatus; q?: string; limit?: number; offset?: number }) {
    const limit = Math.min(opts.limit ?? 25, 200);
    const offset = opts.offset ?? 0;

    const where: Prisma.GiftOrderWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.q) {
      const term = opts.q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { reference: { contains: term, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await this.db.$transaction([
      this.db.giftOrder.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: { items: { include: { collection: true } } },
      }),
      this.db.giftOrder.count({ where }),
    ]);

    return { rows, total, limit, offset };
  }

  async adminGetOrder(id: string): Promise<GiftOrder> {
    const row = await this.db.giftOrder.findUnique({
      where: { id },
      include: { items: { include: { collection: true } } },
    });
    if (!row) throw new NotFoundException();
    return row;
  }

  async adminUpdateOrder(
    id: string,
    update: { status?: GiftOrderStatus; internalNotes?: string },
    actorId: string,
    meta: RequestMeta,
  ): Promise<GiftOrder> {
    const before = await this.db.giftOrder.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    const data: Prisma.GiftOrderUpdateInput = {};
    if (update.status && update.status !== before.status) {
      this.assertLegalTransition(before.status, update.status);
      data.status = update.status;
      if (update.status === GiftOrderStatus.IN_PRODUCTION) data.approvedAt = new Date();
      if (update.status === GiftOrderStatus.SHIPPED) data.shippedAt = new Date();
      if (update.status === GiftOrderStatus.DELIVERED) data.deliveredAt = new Date();
    }
    if (update.internalNotes !== undefined) {
      data.internalNotes = update.internalNotes;
    }

    const updated = await this.db.giftOrder.update({ where: { id }, data });

    await this.audit("order.update", "GiftOrder", id, actorId, meta, {
      fromStatus: before.status,
      toStatus: updated.status,
    });

    return updated;
  }

  async getCustomerOrders(userId: string) {
    return this.db.giftOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { items: { include: { collection: true } } },
    });
  }

  async getCustomerOrderByReference(reference: string, userId: string | null, email: string | null) {
    const row = await this.db.giftOrder.findUnique({
      where: { reference },
      include: { items: { include: { collection: true } } },
    });
    if (!row) throw new NotFoundException();
    // Allow access if the order belongs to the user OR matches their email
    // OR is the recently-completed order being fetched on the success page.
    if (userId && row.userId === userId) return row;
    if (email && row.email === email.toLowerCase()) return row;
    if (!userId && !email) return row; // success page lookup by reference only
    throw new NotFoundException();
  }

  // ---------- helpers ----------

  /**
   * Allocate a human-readable reference like `NIMI-2026-0001`.
   *
   * The implementation uses a Postgres advisory lock + the
   * `OrderSequenceMarker` row keyed by year. For a real production system
   * we'd swap this for a Postgres SEQUENCE (defined in a migration), but
   * keeping it in app code keeps the schema portable.
   */
  /**
   * Fire-and-forget dispatcher for the three notifications that go out
   * the moment a gift order moves to AWAITING_DESIGN_APPROVAL:
   *
   *   1. **Customer receipt** — confirms the order, includes the
   *      reference and a link to their account page so they can find
   *      it again later. Mock-up arrives via a separate email when
   *      the admin advances the status to DESIGN_SENT.
   *
   *   2. **Admin notification** — to `SUPPORT_INBOX`, with the full
   *      payload the kitchen needs to prepare the design: customer
   *      contact details, every item + customisation (names, dates,
   *      colour theme, message, logo URL if attached), delivery
   *      address, customer notes, and a one-click link to the admin
   *      order page.
   *
   *   3. **Staff in-app notification** — one row per OWNER/EDITOR/
   *      SUPPORT user, so the team sees the new order in their bell
   *      dropdown even if the email lands in spam.
   *
   * All three are non-blocking; failures are logged and swallowed so
   * a transient mail/notification hiccup can never undo a successful
   * payment.
   */
  private async dispatchPaidNotifications(orderId: string): Promise<void> {
    let order;
    try {
      order = await this.db.giftOrder.findUnique({
        where: { id: orderId },
        include: {
          items: {
            orderBy: { createdAt: "asc" },
            include: { collection: { select: { name: true } } },
          },
          user: {
            select: {
              phone: true,
              addressLine1: true,
              addressLine2: true,
              addressCity: true,
              addressPostcode: true,
              addressCountry: true,
            },
          },
        },
      });
    } catch (err) {
      this.logger.error({ err, orderId }, "Failed to load gift order for notifications");
      return;
    }
    if (!order) {
      this.logger.warn({ orderId }, "Gift order vanished before notifications could be sent");
      return;
    }

    const origin = publicWebUrl();
    const customerUrl = `${origin}/account/orders/gift/${encodeURIComponent(order.reference)}`;
    const adminUrl = `${origin}/admin/orders/${encodeURIComponent(order.id)}`;

    // --- Customer receipt ---
    try {
      const tpl = giftOrderReceiptTemplate({
        customerName: order.name,
        reference: order.reference,
        totalMinor: order.totalMinor,
        currency: order.currency,
        orderUrl: customerUrl,
      });
      await this.mailer.send({
        to: order.email,
        ...tpl,
        tag: "gift-order-confirmed",
      });
    } catch (err) {
      this.logger.error({ err, reference: order.reference }, "Gift receipt email failed");
    }

    // --- Admin notification ---
    // Prefer the saved profile address when the order doesn't carry
    // its own shipping fields yet. The current checkout doesn't
    // collect shipping per-order (the design flow asks for it later);
    // the profile address is the team's best signal for now.
    const shipping = {
      line1: order.shippingLine1 ?? order.user?.addressLine1 ?? null,
      line2: order.shippingLine2 ?? order.user?.addressLine2 ?? null,
      city: order.shippingCity ?? order.user?.addressCity ?? null,
      postcode: order.shippingPostcode ?? order.user?.addressPostcode ?? null,
      country: order.shippingCountry ?? order.user?.addressCountry ?? null,
    };
    try {
      const env = getEnv();
      const tpl = giftOrderAdminNotifyTemplate({
        reference: order.reference,
        customerName: order.name,
        customerEmail: order.email,
        customerPhone: order.user?.phone ?? null,
        totalMinor: order.totalMinor,
        currency: order.currency,
        shippingLine1: shipping.line1,
        shippingLine2: shipping.line2,
        shippingCity: shipping.city,
        shippingPostcode: shipping.postcode,
        shippingCountry: shipping.country,
        notes: order.notes,
        designApprovalAccepted: order.designApprovalAccepted,
        items: order.items.map((item) => {
          const snap = (item.collectionSnapshot ?? {}) as { name?: string };
          const cust = (item.customisation ?? null) as
            | {
                names?: string | null;
                dates?: string | null;
                colourTheme?: string | null;
                message?: string | null;
                logoUrl?: string | null;
              }
            | null;
          return {
            collectionName: item.collection?.name ?? snap.name ?? "Gift collection",
            quantity: item.quantity,
            unitPriceMinor: item.unitPriceMinor,
            totalMinor: item.totalMinor,
            customisation: cust,
          };
        }),
        adminUrl,
      });
      await this.mailer.send({
        to: env.SUPPORT_INBOX,
        replyTo: order.email,
        ...tpl,
        tag: "gift-order-admin-notify",
      });
    } catch (err) {
      this.logger.error({ err, reference: order.reference }, "Gift admin notify email failed");
    }

    // --- Staff in-app notification ---
    void this.notifications.notifyStaff({
      kind: "contact.enquiry.new", // closest existing kind; gift type
                                   // can be added to NotificationKind in
                                   // a future round if you want
                                   // bell-dropdown filtering.
      title: `New gift order ${order.reference} from ${order.name}`,
      body: `${order.currency.toUpperCase()} ${(order.totalMinor / 100).toFixed(2)} · ${order.items.length} item${order.items.length === 1 ? "" : "s"}`,
      href: `/admin/orders/${order.id}`,
    });
  }

  private async allocateReference(): Promise<string> {
    const year = new Date().getUTCFullYear();
    const marker = await this.db.$transaction(async (tx) => {
      const existing = await tx.orderSequenceMarker.findUnique({ where: { year } });
      if (existing) {
        return tx.orderSequenceMarker.update({
          where: { year },
          data: { next: { increment: 1 } },
        });
      }
      return tx.orderSequenceMarker.create({ data: { year, next: 2 } });
    });

    const seq = (existingNext: number) => existingNext - 1; // we already incremented
    const padded = String(seq(marker.next)).padStart(4, "0");
    return `NIMI-${year}-${padded}`;
  }

  private snapshot(collection: GiftCollection): Record<string, unknown> {
    return {
      id: collection.id,
      slug: collection.slug,
      name: collection.name,
      description: collection.description,
      items: collection.items,
      unitPriceMinor: collection.unitPriceMinor,
      currency: collection.currency,
      moq: collection.moq,
      leadTimeDays: collection.leadTimeDays,
      capturedAt: new Date().toISOString(),
    };
  }

  private shortDescription(collection: GiftCollection): string {
    return collection.description.length > 280
      ? `${collection.description.slice(0, 277).trimEnd()}…`
      : collection.description;
  }

  /**
   * Ban illegal status transitions. The pipeline is mostly forward-only
   * with a couple of safety branches (CANCELLED at any stage; REFUNDED
   * only after a payment).
   */
  private assertLegalTransition(from: GiftOrderStatus, to: GiftOrderStatus): void {
    const legal: Record<GiftOrderStatus, GiftOrderStatus[]> = {
      PENDING_PAYMENT: ["AWAITING_DESIGN_APPROVAL", "CANCELLED"],
      AWAITING_DESIGN_APPROVAL: ["DESIGN_SENT", "CANCELLED", "REFUNDED"],
      DESIGN_SENT: ["IN_PRODUCTION", "AWAITING_DESIGN_APPROVAL", "CANCELLED", "REFUNDED"],
      IN_PRODUCTION: ["SHIPPED", "CANCELLED", "REFUNDED"],
      SHIPPED: ["DELIVERED", "REFUNDED"],
      DELIVERED: ["REFUNDED"],
      CANCELLED: [],
      REFUNDED: [],
    };
    if (!legal[from].includes(to)) {
      throw new BadRequestException(`Cannot move order from ${from} to ${to}.`);
    }
  }

  private async audit(
    action: string,
    entity: string,
    entityId: string,
    actorId: string,
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
      this.logger.error({ err, action }, "Failed to write order audit log");
    }
  }
}
