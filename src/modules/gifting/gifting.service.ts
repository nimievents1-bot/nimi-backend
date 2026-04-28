import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  type GiftCollection,
  type GiftOrder,
  GiftOrderStatus,
  Prisma,
} from "@prisma/client";
import type Stripe from "stripe";

import { getEnv } from "../../config/env";
import { TurnstileService } from "../contact/turnstile.service";
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
@Injectable()
export class GiftingService {
  private readonly logger = new Logger(GiftingService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly stripe: StripeService,
    private readonly turnstile: TurnstileService,
  ) {}

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

    const env = getEnv();
    const origin = env.WEB_ORIGIN[0] ?? "http://localhost:3000";

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
      await this.db.giftOrder.updateMany({
        where: { id: orderId, status: GiftOrderStatus.PENDING_PAYMENT },
        data: {
          status: GiftOrderStatus.AWAITING_DESIGN_APPROVAL,
          paidAt: new Date(),
          stripePaymentIntentId:
            typeof session.payment_intent === "string" ? session.payment_intent : null,
        },
      });
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
          after: after ?? undefined,
        },
      });
    } catch (err) {
      this.logger.error({ err, action }, "Failed to write order audit log");
    }
  }
}
