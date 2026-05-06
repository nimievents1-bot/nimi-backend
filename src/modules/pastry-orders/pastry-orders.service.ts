import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  CreditTxType,
  type PastryOrder,
  PastryOrderStatus,
  Prisma,
} from "@prisma/client";
import type Stripe from "stripe";

import { getEnv } from "../../config/env";
import { MailerService } from "../mailer/mailer.service";
import {
  PastryCartService,
  PASTRY_CART_MIN_MINOR,
} from "../pastry-cart/pastry-cart.service";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";

import { type StartPastryCheckoutDto } from "./dto/checkout.dto";

interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * PastryOrdersService — owns the checkout flow and order lifecycle.
 *
 * Checkout invariant: an order is created in PENDING_PAYMENT *before*
 * Stripe redirect, so we always have a row to attach the webhook event
 * to. Credits are not deducted until the webhook lands; if the customer
 * abandons the checkout, the order sits in PENDING_PAYMENT and the cart
 * stays full so they can return.
 *
 * Two zero-cost-on-Stripe edge cases handled:
 *   1. Cart subtotal is fully covered by credits → no Stripe session,
 *      we mark PAID immediately and deduct credits.
 *   2. Cart subtotal doesn't meet £25 minimum → 400, no order created.
 */
@Injectable()
export class PastryOrdersService {
  private readonly logger = new Logger(PastryOrdersService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly stripe: StripeService,
    private readonly cart: PastryCartService,
    private readonly mailer: MailerService,
  ) {}

  // ---------- checkout ----------

  /**
   * Build the order, apply credits, and return a Stripe Checkout URL —
   * unless credits cover the entire order, in which case we mark PAID
   * immediately and return a "no payment needed" success URL.
   */
  async startCheckout(
    dto: StartPastryCheckoutDto,
    user: SessionUser,
  ): Promise<{ url: string; orderId: string; reference: string }> {
    if (!this.stripe.isAvailable()) {
      throw new ServiceUnavailableException(
        "Online payment is not configured yet — please try again later.",
      );
    }

    const view = await this.cart.view(user.id);
    if (view.lines.length === 0) {
      throw new BadRequestException("Your cart is empty.");
    }
    if (!view.meetsMinimum) {
      const minPounds = (PASTRY_CART_MIN_MINOR / 100).toFixed(2);
      throw new BadRequestException(
        `Minimum order is £${minPounds}. Add a few more items to continue.`,
      );
    }
    // Defensive: refuse if any item became unavailable while in cart.
    const unavailable = view.lines.filter((l) => !l.available);
    if (unavailable.length > 0) {
      throw new BadRequestException(
        `One or more items are no longer available: ${unavailable
          .map((l) => l.name)
          .join(", ")}. Please remove them and try again.`,
      );
    }

    const subtotalMinor = view.subtotalMinor;
    const creditApplied = view.applicableCreditMinor;
    const payable = view.payableMinor;
    const reference = await this.allocateReference();

    const env = getEnv();
    const origin = env.WEB_ORIGIN[0] ?? "http://localhost:3000";

    // Snapshot every cart line into a JSON-serialisable shape we can
    // store in PastryOrderItem.itemSnapshot, decoupling the order from
    // future PastryItem edits.
    const itemSnapshots = view.lines.map((line) => ({
      slug: line.slug,
      name: line.name,
      description: line.description,
      imageUrl: line.imageUrl,
    }));

    if (payable === 0) {
      // Credits cover the whole order — no Stripe needed. Create order
      // PAID and deduct credits in a single transaction.
      const orderId = await this.db.$transaction(async (tx) => {
        const order = await tx.pastryOrder.create({
          data: {
            reference,
            userId: user.id,
            email: user.email,
            name: dto.recipientName,
            phone: dto.phone ?? null,
            status: PastryOrderStatus.PAID,
            subtotalMinor,
            creditAppliedMinor: creditApplied,
            totalMinor: 0,
            currency: view.currency,
            shippingLine1: dto.shippingLine1,
            shippingLine2: dto.shippingLine2 ?? null,
            shippingCity: dto.shippingCity,
            shippingPostcode: dto.shippingPostcode,
            shippingCountry: dto.shippingCountry ?? "GB",
            notes: dto.notes ?? null,
            paidAt: new Date(),
            items: {
              create: view.lines.map((line, idx) => ({
                pastryItemId: line.itemId,
                itemSnapshot: itemSnapshots[idx]! as Prisma.InputJsonValue,
                quantity: line.quantity,
                unitPriceMinor: line.unitPriceMinor,
                totalMinor: line.lineTotalMinor,
              })),
            },
          },
          select: { id: true },
        });

        const txRow = await tx.creditTransaction.create({
          data: {
            userId: user.id,
            type: CreditTxType.REDEMPTION,
            amountMinor: -creditApplied,
            balanceAfter: 0, // recomputed by next aggregate read
            sourceType: "pastry.order",
            sourceId: order.id,
            reason: `Pastry order ${reference}`,
            createdBy: "system",
          },
          select: { id: true },
        });

        await tx.pastryOrder.update({
          where: { id: order.id },
          data: { creditTransactionId: txRow.id },
        });

        await this.cart.clearForCheckout(user.id, tx);
        return order.id;
      });

      // Send confirmation email — no Stripe receipt to lean on.
      void this.sendPaidEmail(user.email, dto.recipientName, reference, 0);

      return {
        url: `${origin}/cart/success?order=${reference}`,
        orderId,
        reference,
      };
    }

    // Stripe-paid path. Create the order in PENDING_PAYMENT, then create
    // a Stripe Checkout session whose metadata points back to our order.
    const order = await this.db.pastryOrder.create({
      data: {
        reference,
        userId: user.id,
        email: user.email,
        name: dto.recipientName,
        phone: dto.phone ?? null,
        status: PastryOrderStatus.PENDING_PAYMENT,
        subtotalMinor,
        creditAppliedMinor: creditApplied,
        totalMinor: payable,
        currency: view.currency,
        shippingLine1: dto.shippingLine1,
        shippingLine2: dto.shippingLine2 ?? null,
        shippingCity: dto.shippingCity,
        shippingPostcode: dto.shippingPostcode,
        shippingCountry: dto.shippingCountry ?? "GB",
        notes: dto.notes ?? null,
        items: {
          create: view.lines.map((line, idx) => ({
            pastryItemId: line.itemId,
            itemSnapshot: itemSnapshots[idx]! as Prisma.InputJsonValue,
            quantity: line.quantity,
            unitPriceMinor: line.unitPriceMinor,
            totalMinor: line.lineTotalMinor,
          })),
        },
      },
      select: { id: true },
    });

    const session = await this.stripe.sdk.checkout.sessions.create({
      mode: "payment",
      customer_email: user.email,
      line_items: view.lines.map((line) => ({
        quantity: line.quantity,
        price_data: {
          currency: view.currency,
          unit_amount: line.unitPriceMinor,
          product_data: {
            name: line.name,
            ...(line.description ? { description: line.description.slice(0, 200) } : {}),
            ...(line.imageUrl ? { images: [line.imageUrl] } : {}),
          },
        },
      })),
      // Communicate the credit applied as a discount line so the customer
      // sees the math on Stripe's checkout page.
      ...(creditApplied > 0
        ? {
            discounts: [
              {
                coupon: await this.ensureSessionCoupon(creditApplied, view.currency),
              },
            ],
          }
        : {}),
      metadata: {
        kind: "pastry_order",
        orderId: order.id,
        reference,
        userId: user.id,
        creditApplied: String(creditApplied),
      },
      payment_intent_data: {
        metadata: {
          kind: "pastry_order",
          orderId: order.id,
          reference,
        },
      },
      success_url: `${origin}/cart/success?order=${reference}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cart?status=cancelled`,
    });

    if (!session.url) {
      throw new ServiceUnavailableException("Stripe didn't return a checkout URL.");
    }

    await this.db.pastryOrder.update({
      where: { id: order.id },
      data: { stripeSessionId: session.id },
    });

    return { url: session.url, orderId: order.id, reference };
  }

  // ---------- webhook ----------

  /**
   * `checkout.session.completed` handler for pastry orders. Idempotent —
   * if the order is already PAID we no-op. Credit deduction happens here
   * (not at order creation), so a customer who never completes payment
   * never loses credits.
   */
  async onCheckoutCompleted(event: Stripe.Event): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.kind !== "pastry_order") return;

    const orderId = session.metadata.orderId;
    if (!orderId) {
      this.logger.warn({ sessionId: session.id }, "Pastry checkout missing orderId metadata");
      return;
    }

    const order = await this.db.pastryOrder.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, status: true, reference: true, name: true, totalMinor: true, creditAppliedMinor: true, email: true },
    });
    if (!order) {
      this.logger.warn({ orderId, sessionId: session.id }, "Pastry checkout for unknown order");
      return;
    }
    if (order.status === PastryOrderStatus.PAID || order.status === PastryOrderStatus.PREPARING) {
      return; // already processed
    }

    await this.db.$transaction(async (tx) => {
      // Mark PAID + record payment intent.
      await tx.pastryOrder.update({
        where: { id: order.id },
        data: {
          status: PastryOrderStatus.PAID,
          paidAt: new Date(),
          stripePaymentIntentId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : null,
        },
      });

      // Deduct credits if any were applied. Idempotent on (userId,
      // sourceType, sourceId) so a webhook retry won't re-debit.
      if (order.creditAppliedMinor > 0) {
        const existing = await tx.creditTransaction.findUnique({
          where: {
            userId_sourceType_sourceId: {
              userId: order.userId,
              sourceType: "pastry.order",
              sourceId: order.id,
            },
          },
          select: { id: true },
        });
        if (!existing) {
          const txRow = await tx.creditTransaction.create({
            data: {
              userId: order.userId,
              type: CreditTxType.REDEMPTION,
              amountMinor: -order.creditAppliedMinor,
              balanceAfter: 0,
              sourceType: "pastry.order",
              sourceId: order.id,
              reason: `Pastry order ${order.reference}`,
              createdBy: "system",
            },
            select: { id: true },
          });
          await tx.pastryOrder.update({
            where: { id: order.id },
            data: { creditTransactionId: txRow.id },
          });
        }
      }

      // Clear the cart of the items we just paid for.
      await this.cart.clearForCheckout(order.userId, tx);
    });

    void this.sendPaidEmail(order.email, order.name, order.reference, order.totalMinor);
  }

  // ---------- customer reads ----------

  async listMyOrders(userId: string): Promise<
    Array<{
      id: string;
      reference: string;
      status: PastryOrderStatus;
      totalMinor: number;
      currency: string;
      createdAt: string;
      itemCount: number;
    }>
  > {
    const rows = await this.db.pastryOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { _count: { select: { items: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      totalMinor: r.totalMinor,
      currency: r.currency,
      createdAt: r.createdAt.toISOString(),
      itemCount: r._count.items,
    }));
  }

  async getMyOrderByReference(
    userId: string,
    reference: string,
  ): Promise<PastryOrder & { items: Array<unknown> }> {
    const order = await this.db.pastryOrder.findUnique({
      where: { reference },
      include: { items: true },
    });
    if (!order || order.userId !== userId) throw new NotFoundException();
    return order;
  }

  // ---------- admin ----------

  /**
   * Admin list with filter + free-text search across reference, name and
   * email. Sorted newest first so freshly-paid orders surface for the
   * kitchen team without needing to filter.
   */
  async adminList(opts: {
    limit?: number;
    offset?: number;
    status?: PastryOrderStatus;
    q?: string;
  }): Promise<{
    rows: Array<
      PastryOrder & {
        _count: { items: number };
      }
    >;
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const where: Prisma.PastryOrderWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.q) {
      const term = opts.q.trim();
      where.OR = [
        { reference: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await this.db.$transaction([
      this.db.pastryOrder.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: { _count: { select: { items: true } } },
      }),
      this.db.pastryOrder.count({ where }),
    ]);

    return { rows, total, limit, offset };
  }

  async adminGetByReference(reference: string): Promise<
    PastryOrder & { items: Array<unknown> }
  > {
    const order = await this.db.pastryOrder.findUnique({
      where: { reference },
      include: { items: true },
    });
    if (!order) throw new NotFoundException();
    return order;
  }

  /**
   * Allowed status transitions. Forward-only; we never let admins reverse
   * a status (e.g. DELIVERED → READY) because that breaks the timeline
   * timestamps and the customer's expectations. The only "back" path is
   * CANCELLED, which is allowed from any non-terminal state, and REFUNDED,
   * which is allowed only from PAID/PREPARING/READY/SHIPPED/DELIVERED.
   */
  private static readonly ALLOWED_TRANSITIONS: Record<
    PastryOrderStatus,
    ReadonlyArray<PastryOrderStatus>
  > = {
    [PastryOrderStatus.PENDING_PAYMENT]: [PastryOrderStatus.CANCELLED],
    [PastryOrderStatus.PAID]: [
      PastryOrderStatus.PREPARING,
      PastryOrderStatus.CANCELLED,
      PastryOrderStatus.REFUNDED,
    ],
    [PastryOrderStatus.PREPARING]: [
      PastryOrderStatus.READY,
      PastryOrderStatus.CANCELLED,
      PastryOrderStatus.REFUNDED,
    ],
    [PastryOrderStatus.READY]: [
      PastryOrderStatus.SHIPPED,
      PastryOrderStatus.DELIVERED,
      PastryOrderStatus.CANCELLED,
      PastryOrderStatus.REFUNDED,
    ],
    [PastryOrderStatus.SHIPPED]: [
      PastryOrderStatus.DELIVERED,
      PastryOrderStatus.REFUNDED,
    ],
    [PastryOrderStatus.DELIVERED]: [PastryOrderStatus.REFUNDED],
    [PastryOrderStatus.CANCELLED]: [],
    [PastryOrderStatus.REFUNDED]: [],
  };

  /**
   * Admin transitions an order's status. Stamps the matching `*At`
   * timestamp, writes an AuditLog row, and dispatches a customer email
   * if the transition has user-facing meaning (PREPARING / READY /
   * SHIPPED / DELIVERED / CANCELLED).
   */
  async adminUpdateStatus(
    reference: string,
    next: PastryOrderStatus,
    note: string | undefined,
    actorId: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<PastryOrder> {
    const order = await this.db.pastryOrder.findUnique({
      where: { reference },
    });
    if (!order) throw new NotFoundException();

    const allowed =
      PastryOrdersService.ALLOWED_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(next)) {
      throw new BadRequestException(
        `Cannot transition pastry order from ${order.status} to ${next}.`,
      );
    }

    const data: Prisma.PastryOrderUpdateInput = { status: next };
    const now = new Date();
    switch (next) {
      case PastryOrderStatus.PREPARING:
        data.preparingAt = now;
        break;
      case PastryOrderStatus.READY:
        data.readyAt = now;
        break;
      case PastryOrderStatus.SHIPPED:
        data.shippedAt = now;
        break;
      case PastryOrderStatus.DELIVERED:
        data.deliveredAt = now;
        break;
      case PastryOrderStatus.CANCELLED:
        data.cancelledAt = now;
        break;
      default:
        break;
    }

    const updated = await this.db.pastryOrder.update({
      where: { id: order.id },
      data,
    });

    // Audit (best-effort).
    try {
      await this.db.auditLog.create({
        data: {
          action: `pastry_order.${next.toLowerCase()}`,
          entity: "PastryOrder",
          entityId: order.id,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          after: { reference: order.reference, ...(note ? { note } : {}) } as never,
        },
      });
    } catch (err) {
      this.logger.error({ err, reference }, "Failed to write pastry order audit log");
    }

    // Customer-facing emails. Wrapped in try/catch — admin should be able
    // to advance status even if Resend has a wobble.
    try {
      await this.dispatchStatusEmail(updated);
    } catch (err) {
      this.logger.warn({ err, reference }, "Pastry order status email failed (non-fatal)");
    }

    return updated;
  }

  async adminUpdateNotes(
    reference: string,
    internalNotes: string | undefined,
  ): Promise<PastryOrder> {
    const order = await this.db.pastryOrder.findUnique({
      where: { reference },
      select: { id: true },
    });
    if (!order) throw new NotFoundException();
    return this.db.pastryOrder.update({
      where: { id: order.id },
      data: { internalNotes: internalNotes ?? null },
    });
  }

  // ---------- helpers ----------

  /**
   * Allocate the next NIMI-P-YYYY-NNNN reference. Uses a separate
   * sequence table so we don't lean on uuids in customer-facing strings.
   */
  private async allocateReference(): Promise<string> {
    const year = new Date().getFullYear();
    const result = await this.db.$transaction(async (tx) => {
      const row = await tx.pastryOrderSequenceMarker.upsert({
        where: { year },
        create: { year, nextNumber: 2 },
        update: { nextNumber: { increment: 1 } },
      });
      // upsert returns the post-update row, so n=1 means next-after-create.
      return row.nextNumber - 1;
    });
    return `NIMI-P-${year}-${String(result).padStart(4, "0")}`;
  }

  /**
   * Stripe coupons are simpler than discount codes for ad-hoc fixed-amount
   * discounts. We create a one-off coupon valid for this session only,
   * named after the credit amount.
   */
  private async ensureSessionCoupon(amountMinor: number, currency: string): Promise<string> {
    const coupon = await this.stripe.sdk.coupons.create({
      amount_off: amountMinor,
      currency,
      duration: "once",
      name: `Indulgence Credit (${currency.toUpperCase()} ${(amountMinor / 100).toFixed(2)})`,
    });
    return coupon.id;
  }

  /**
   * Plain-text confirmation. We don't send a templated HTML email here
   * for v1 — Stripe sends its own receipt for paid orders, and this
   * lightweight confirmation lets the customer find their reference
   * even if the Stripe email gets lost in spam.
   */
  private async sendPaidEmail(
    to: string,
    recipientName: string,
    reference: string,
    totalMinor: number,
  ): Promise<void> {
    const total =
      totalMinor === 0 ? "fully covered by credits" : `£${(totalMinor / 100).toFixed(2)}`;
    try {
      await this.mailer.send({
        to,
        subject: `Order ${reference} confirmed`,
        text: `Hi ${recipientName.split(" ")[0]},

Your pastry order is confirmed.

Reference: ${reference}
Total: ${total}

We'll be in touch when it's prepared. Thank you for ordering with us.

— Nimi Events`,
        html: `<p>Hi ${recipientName.split(" ")[0]},</p>
<p>Your pastry order is confirmed.</p>
<p><strong>Reference:</strong> ${reference}<br>
<strong>Total:</strong> ${total}</p>
<p>We&rsquo;ll be in touch when it&rsquo;s prepared. Thank you for ordering with us.</p>
<p>— Nimi Events</p>`,
        tag: "pastry-order-confirmed",
      });
    } catch (err) {
      this.logger.error({ err, reference }, "Pastry order confirmation email failed");
    }
  }

  /**
   * Customer-facing email for status transitions that materially change
   * what the customer is waiting for. PAID is handled separately via the
   * payment-confirmed mail; PENDING_PAYMENT is internal-only.
   */
  private async dispatchStatusEmail(order: PastryOrder): Promise<void> {
    const env = getEnv();
    const accountUrl = `${env.WEB_ORIGIN[0] ?? "http://localhost:3000"}/account/orders`;
    const firstName = order.name.split(" ")[0] ?? order.name;

    let subject: string | undefined;
    let body: string | undefined;
    switch (order.status) {
      case PastryOrderStatus.PREPARING:
        subject = `Order ${order.reference} — we're on it`;
        body = `Hi ${firstName},

The kitchen has started on your order. We'll be in touch when it's ready.

Reference: ${order.reference}
View order: ${accountUrl}

— Nimi Events`;
        break;
      case PastryOrderStatus.READY:
        subject = `Order ${order.reference} — ready for dispatch`;
        body = `Hi ${firstName},

Your order is ready and queued for delivery.

Reference: ${order.reference}
Delivery to: ${order.shippingLine1}${order.shippingLine2 ? `, ${order.shippingLine2}` : ""}, ${order.shippingCity} ${order.shippingPostcode}
View order: ${accountUrl}

— Nimi Events`;
        break;
      case PastryOrderStatus.SHIPPED:
        subject = `Order ${order.reference} — on its way`;
        body = `Hi ${firstName},

Your order is out for delivery and should be with you shortly.

Reference: ${order.reference}
View order: ${accountUrl}

— Nimi Events`;
        break;
      case PastryOrderStatus.DELIVERED:
        subject = `Order ${order.reference} — delivered`;
        body = `Hi ${firstName},

Your order has been delivered. We hope every bite was worth the wait.

If anything wasn't right, hit reply and let us know — we read every message.

Reference: ${order.reference}

— Nimi Events`;
        break;
      case PastryOrderStatus.CANCELLED:
        subject = `Order ${order.reference} — cancelled`;
        body = `Hi ${firstName},

Your order has been cancelled. Any payment will be refunded to your original card within 5–10 business days, and any Indulgence Credits used have been returned to your balance.

Reference: ${order.reference}

— Nimi Events`;
        break;
      default:
        // PAID, PENDING_PAYMENT, REFUNDED — handled elsewhere (or silent).
        return;
    }

    if (!subject || !body) return;

    await this.mailer.send({
      to: order.email,
      subject,
      text: body,
      html: body
        .split("\n\n")
        .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
        .join(""),
      tag: `pastry-order-${order.status.toLowerCase()}`,
    });
  }
}
