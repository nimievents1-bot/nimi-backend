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

import { getEnv, publicWebUrl } from "../../config/env";
import { MailerService } from "../mailer/mailer.service";
import {
  pastryOrderAdminNotifyTemplate,
  pastryOrderConfirmedTemplate,
  pastryOrderStatusTemplate,
  type PastryOrderStatusForEmail,
} from "../mailer/pastry-templates";
import { NotificationsService } from "../notifications/notifications.service";
import { PastryCartService } from "../pastry-cart/pastry-cart.service";
import { PrismaService } from "../prisma/prisma.service";
import { PromoCodesService } from "../promo-codes/promo-codes.service";
import { ShippingService } from "../shipping/shipping.service";
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
    private readonly notifications: NotificationsService,
    private readonly promoCodes: PromoCodesService,
    private readonly shipping: ShippingService,
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
      const minPounds = (view.minimumMinor / 100).toFixed(2);
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

    // ---- Per-item minimum order quantity ----
    // The cart's `view()` already reports `meetsMinimum` per line, and
    // the cart UI refuses to enable the checkout button until every
    // line clears it. We re-check server-side because a determined
    // client could still POST to this endpoint directly.
    const belowMinimum = view.lines.filter((l) => !l.meetsMinimum);
    if (belowMinimum.length > 0) {
      const offender = belowMinimum[0];
      throw new BadRequestException(
        belowMinimum.length === 1
          ? `${offender.name} needs at least ${offender.minQuantity} per order — you have ${offender.quantity}.`
          : `Several items are below their minimum order quantity. Please adjust the cart and try again.`,
      );
    }

    // ---- Daily kitchen batch cap ----
    // Same shape — the cart `view()` reports `withinBatch` per line so
    // the UI can disable the button, and we re-verify here so a
    // direct API call can't slip through. By the time a customer
    // reaches this endpoint, someone else may have filled the last
    // remaining capacity since they put items in the cart — the
    // checkout safety net catches that race and asks them to retry.
    const overBatch = view.lines.filter((l) => !l.withinBatch);
    if (overBatch.length > 0) {
      const offender = overBatch[0];
      const left = Math.max(0, (offender.batchLimit ?? 0) - offender.bookedToday);
      throw new BadRequestException(
        left === 0
          ? `${offender.name} is fully booked for today. Remove it or come back tomorrow.`
          : `${offender.name} now has only ${left} left for today — please drop your quantity to ${left} or fewer.`,
      );
    }

    const subtotalMinor = view.subtotalMinor;

    // ---- Shipping fee resolution ----
    // Compute the delivery fee from the customer's postcode against
    // the admin-configured zones. A null return from `resolveFee`
    // means "no zone matched and there's no catch-all" — which on
    // first deploy (before the admin has set up any zones) means
    // "no shipping config yet"; we treat that as free shipping so
    // existing checkout flows don't regress. Once at least one
    // catch-all zone exists, the resolver always returns a match.
    //
    // Indulgence Credits are deliberately NOT applied to the
    // shipping fee — credits are for pastries, the courier still
    // needs paying. Promo codes also leave shipping alone for the
    // same reason.
    const shippingResult = await this.shipping.resolveFee(
      dto.shippingPostcode,
      subtotalMinor,
    );
    const shippingMinor = shippingResult?.feeMinor ?? 0;
    const shippingZoneId = shippingResult?.zoneId ?? null;
    const shippingZoneName = shippingResult?.zoneName ?? null;

    // ---- Promo code resolution (read-only, no mutation here) ----
    // We compute the discount up-front so credits + Stripe coupon can
    // both see the post-promo total. The atomic redemption happens
    // later, inside the order-creation transaction, so we never burn
    // a code if the order itself fails to persist.
    let promoPreview: Awaited<ReturnType<PromoCodesService["preview"]>> | null = null;
    if (dto.promoCode && dto.promoCode.trim().length > 0) {
      promoPreview = await this.promoCodes.preview({
        code: dto.promoCode,
        userId: user.id,
        subtotalMinor,
        currency: view.currency,
      });
    }
    const promoDiscount = promoPreview?.discountMinor ?? 0;

    // Promo applies BEFORE credits, so the customer gets their full
    // advertised percent-off even if credits would have covered the
    // bill. Credits then fill in whatever's left of the post-promo
    // subtotal — they can't reduce the payable below £0.
    const subtotalAfterPromo = Math.max(0, subtotalMinor - promoDiscount);
    const creditApplied = Math.min(view.applicableCreditMinor, subtotalAfterPromo);
    const payable = Math.max(0, subtotalAfterPromo - creditApplied);
    const reference = await this.allocateReference();

    const origin = publicWebUrl();

    // Snapshot every cart line into a JSON-serialisable shape we can
    // store in PastryOrderItem.itemSnapshot, decoupling the order from
    // future PastryItem edits.
    const itemSnapshots = view.lines.map((line) => ({
      slug: line.slug,
      name: line.name,
      description: line.description,
      imageUrl: line.imageUrl,
    }));

    // Grand total the customer must pay = items-portion-after-credits
    // PLUS the shipping fee. We only skip Stripe when BOTH are zero
    // (credits cover items AND shipping is free for this zone /
    // basket size). When shipping is non-zero, even a 100%-credit-
    // covered cart still needs Stripe to charge the courier fee.
    const grandTotal = payable + shippingMinor;

    if (grandTotal === 0) {
      // Credits cover items, shipping is free — no Stripe needed.
      // Create order PAID, deduct credits, and atomically redeem the
      // promo code, all in one transaction so a half-applied state
      // can't survive a failure.
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
            promoDiscountMinor: promoDiscount,
            promoCodeId: promoPreview?.promo.id ?? null,
            totalMinor: 0,
            currency: view.currency,
            shippingLine1: dto.shippingLine1,
            shippingLine2: dto.shippingLine2 ?? null,
            shippingCity: dto.shippingCity,
            shippingPostcode: dto.shippingPostcode,
            shippingCountry: dto.shippingCountry ?? "GB",
            // Shipping is 0 by definition on this branch, but we
            // persist the resolved zone snapshot anyway so admin
            // analytics can still attribute the order to a zone.
            shippingFeeMinor: 0,
            shippingZoneId,
            shippingZoneName,
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

        // Atomically claim the promo code, if any. If two concurrent
        // checkouts race for the same code, exactly one will succeed
        // (the failed call throws BadRequest and the whole transaction
        // rolls back — order, credit row, and cart-clear all undone).
        if (promoPreview) {
          await this.promoCodes.redeem({
            promoId: promoPreview.promo.id,
            userId: user.id,
            orderRef: reference,
            tx,
          });
        }

        if (creditApplied > 0) {
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
        }

        await this.cart.clearForCheckout(user.id, tx);
        return order.id;
      });

      // Customer confirmation + admin notification. Fire-and-forget;
      // the helper refetches the order with items so the admin email
      // can render the full bill of materials.
      void this.dispatchPaidNotifications(orderId);

      return {
        url: `${origin}/cart/success?order=${reference}`,
        orderId,
        reference,
      };
    }

    // Stripe-paid path. Create the order in PENDING_PAYMENT *and*
    // atomically claim the promo code in one transaction. If the
    // promo redemption fails (race with another checkout), the order
    // never gets a row in the DB and the customer sees a clean
    // BadRequest. We do the redemption here, BEFORE the Stripe API
    // call, because rolling back a Stripe Checkout session is far
    // messier than rolling back our own transaction.
    const order = await this.db.$transaction(async (tx) => {
      const row = await tx.pastryOrder.create({
        data: {
          reference,
          userId: user.id,
          email: user.email,
          name: dto.recipientName,
          phone: dto.phone ?? null,
          status: PastryOrderStatus.PENDING_PAYMENT,
          subtotalMinor,
          creditAppliedMinor: creditApplied,
          promoDiscountMinor: promoDiscount,
          promoCodeId: promoPreview?.promo.id ?? null,
          // Grand total Stripe will charge = items-after-credits + shipping.
          totalMinor: grandTotal,
          currency: view.currency,
          shippingLine1: dto.shippingLine1,
          shippingLine2: dto.shippingLine2 ?? null,
          shippingCity: dto.shippingCity,
          shippingPostcode: dto.shippingPostcode,
          shippingCountry: dto.shippingCountry ?? "GB",
          // Persist the resolved shipping snapshot. Future receipts
          // / refunds reflect the price the customer paid even if
          // the operator rerates the zone tomorrow.
          shippingFeeMinor: shippingMinor,
          shippingZoneId,
          shippingZoneName,
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
      if (promoPreview) {
        await this.promoCodes.redeem({
          promoId: promoPreview.promo.id,
          userId: user.id,
          orderRef: reference,
          tx,
        });
      }
      return row;
    });

    // Pre-create the discount coupon BEFORE the sessions.create call so
    // a coupon failure surfaces as its own typed error and doesn't get
    // tangled in the session-creation try/catch. Stripe Checkout
    // accepts at most one discount per session, so we bundle the
    // Indulgence Credit AND the promo discount into a single coupon
    // with a combined amount and a descriptive name. The on-page
    // breakdown the customer sees on Stripe still shows the
    // line-item subtotal then "- £X" — they get the right number;
    // our PastryOrder rows store the breakdown for the receipt.
    const totalCouponMinor = creditApplied + promoDiscount;
    const couponLabel = (() => {
      if (creditApplied > 0 && promoDiscount > 0) {
        return `Indulgence Credit + Promo Code`;
      }
      if (creditApplied > 0) return `Indulgence Credit`;
      return `Promo Code`;
    })();
    const couponId = totalCouponMinor > 0
      ? await this.ensureSessionCoupon(
          totalCouponMinor,
          view.currency,
          couponLabel,
        ).catch((err: unknown) => {
          this.logger.error(
            {
              err,
              orderId: order.id,
              creditApplied,
              promoDiscount,
              currency: view.currency,
            },
            "Failed to create Stripe discount coupon",
          );
          throw new ServiceUnavailableException(
            "We couldn't apply your discount. Please try again in a moment.",
          );
        })
      : null;

    // Wrap the Stripe session create so any provider failure becomes a
    // typed HttpException with an actionable message — without this, a
    // raw StripeError would fall through to the generic 500 handler and
    // the customer would only see "An unexpected error occurred."
    // Defensive URL validation. Stripe rejects the entire session if
    // ANY URL (success_url, cancel_url, or any image in line_items) is
    // malformed — and the rejection looks like a plain `Error: Not a
    // valid URL` rather than a typed StripeInvalidRequestError, so it
    // used to surface as "Payment setup failed". We validate every URL
    // up-front and drop bad image URLs (the product line still ships,
    // it just renders without an image on Stripe's page). For the
    // success/cancel URLs we hard-fail here with a typed exception —
    // the page can't function without them, but at least the operator
    // sees a precise message telling them what to fix.
    const isValidHttpUrl = (value: string): boolean => {
      try {
        const u = new URL(value);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    };

    const successUrl = `${origin}/cart/success?order=${reference}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/cart?status=cancelled`;
    // Strip Stripe's `{CHECKOUT_SESSION_ID}` placeholder before
    // running through URL() — the parser doesn't accept curly braces.
    if (!isValidHttpUrl(successUrl.replace("{CHECKOUT_SESSION_ID}", "x"))) {
      this.logger.error(
        { successUrl, cancelUrl, origin, orderId: order.id, reference },
        "Computed success/cancel URL is not a valid http(s) URL — check WEB_PUBLIC_URL / WEB_ORIGIN env",
      );
      await this.db.pastryOrder
        .update({ where: { id: order.id }, data: { status: PastryOrderStatus.CANCELLED } })
        .catch(() => undefined);
      throw new ServiceUnavailableException(
        "Checkout is misconfigured on the server (WEB_PUBLIC_URL must be a full https:// URL). The site administrator has been notified.",
      );
    }

    // Build line items, silently dropping image URLs that don't pass
    // the URL guard so a single bad upload can't block the whole
    // checkout. The product still appears on Stripe's checkout — just
    // without the image thumbnail.
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = view.lines.map(
      (line) => {
        const validImage = line.imageUrl && isValidHttpUrl(line.imageUrl) ? line.imageUrl : null;
        if (line.imageUrl && !validImage) {
          this.logger.warn(
            { pastryItemId: line.itemId, imageUrl: line.imageUrl },
            "Dropping invalid imageUrl from Stripe Checkout line item",
          );
        }
        return {
          quantity: line.quantity,
          price_data: {
            currency: view.currency,
            unit_amount: line.unitPriceMinor,
            product_data: {
              name: line.name,
              ...(line.description ? { description: line.description.slice(0, 200) } : {}),
              ...(validImage ? { images: [validImage] } : {}),
            },
          },
        } satisfies Stripe.Checkout.SessionCreateParams.LineItem;
      },
    );

    // Append the delivery fee as its own line item so the customer
    // sees a clean "Delivery — £X.XX" row on Stripe's checkout page.
    // We deliberately don't use Stripe's `shipping_options` API
    // because that requires `shipping_address_collection`, which
    // would re-prompt the customer for an address they've already
    // entered on /cart. A plain line item gives the same accounting
    // outcome (the fee charges, the receipt shows it) without the
    // duplicate-address UX. Skipped when shipping is 0 — no
    // misleading "£0 delivery" row on the receipt.
    if (shippingMinor > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: view.currency,
          unit_amount: shippingMinor,
          product_data: {
            name: shippingZoneName
              ? `Delivery — ${shippingZoneName}`
              : "Delivery",
          },
        },
      });
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.sdk.checkout.sessions.create({
        mode: "payment",
        customer_email: user.email,
        line_items: lineItems,
        // Communicate the credit applied as a discount line so the customer
        // sees the math on Stripe's checkout page.
        ...(couponId ? { discounts: [{ coupon: couponId }] } : {}),
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
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
    } catch (err) {
      // Log everything we can correlate against Stripe Dashboard.
      // `err.cause` and `err.code` aren't standard on Error but the
      // Stripe SDK and Node's undici fetch sometimes set them, and
      // they're the most useful signals when an error has a useless
      // name like "Error". We also dump the constructor name in case
      // the SDK is shipping a custom class without setting `name`.
      const e = err as Error & { cause?: unknown; code?: unknown };
      this.logger.error(
        {
          err,
          errName: e?.name,
          errMessage: e?.message,
          errCode: e?.code,
          errCause: e?.cause,
          errCtor: e?.constructor?.name,
          stack: e?.stack,
          orderId: order.id,
          reference,
          subtotalMinor,
          creditApplied,
          payable,
          currency: view.currency,
          lineCount: view.lines.length,
        },
        "Stripe Checkout session create failed",
      );

      // Best-effort: mark the pending order as cancelled so it doesn't
      // sit in PENDING_PAYMENT forever. Webhook-driven reconciliation
      // would also clean this up eventually, but a sync cancel keeps
      // the admin pastry-orders list tidy.
      await this.db.pastryOrder
        .update({ where: { id: order.id }, data: { status: PastryOrderStatus.CANCELLED } })
        .catch(() => undefined);

      // Translate Stripe failure modes into actionable copy. The full
      // error stays in logs (above); the user-facing message is short
      // enough to act on but specific enough that the operator can
      // recognise the failure mode from the surface.
      //
      // We deliberately include a short diagnostic suffix in the
      // detail (the error short-code) so a customer can quote it to
      // support and the operator can match it against the request id
      // without log access. We strip the "Stripe" prefix and "Error"
      // suffix so the surface is "AuthenticationError" rather than
      // the noisier raw name.
      const errName = (err as Error)?.name ?? "UnknownError";
      const errMessage = (err as Error)?.message ?? "";
      const shortCode = errName.replace(/^Stripe/, "").replace(/Error$/, "") || "Unknown";

      // The Stripe SDK exposes a `type` property (lowercase, e.g.
      // "StripeAuthenticationError" has type "authentication_error").
      // Use it as a secondary signal when `name` isn't a Stripe* prefix.
      const stripeType = (err as { type?: string })?.type ?? "";

      const isStripe = errName.startsWith("Stripe") || stripeType.endsWith("_error");

      if (errName === "StripeAuthenticationError" || stripeType === "authentication_error") {
        throw new ServiceUnavailableException(
          `Payments aren't available right now — the Stripe key on the server is missing or wrong. The site administrator has been notified. [${shortCode}]`,
        );
      }
      if (errName === "StripePermissionError" || stripeType === "permission_error") {
        throw new ServiceUnavailableException(
          `The Stripe account isn't set up to accept Checkout payments yet. The site administrator has been notified. [${shortCode}]`,
        );
      }
      if (errName === "StripeInvalidRequestError" || stripeType === "invalid_request_error") {
        // Most often: invalid image URL, currency mismatch, customer
        // email malformed, or a Checkout configuration the Dashboard
        // is rejecting. The Stripe message often names the bad field
        // — safe-ish to surface a trimmed version because the customer
        // can sometimes self-correct (e.g. retry).
        const trimmedHint = errMessage.length > 140 ? errMessage.slice(0, 140) + "…" : errMessage;
        throw new ServiceUnavailableException(
          `We couldn't set up the payment for this order. ${trimmedHint || "Please refresh and try again."} [${shortCode}]`,
        );
      }
      if (errName === "StripeRateLimitError" || stripeType === "rate_limit_error") {
        throw new ServiceUnavailableException(
          `Too many checkout attempts in a short window. Please wait a minute and try again. [${shortCode}]`,
        );
      }
      if (errName === "StripeConnectionError" || stripeType === "api_connection_error") {
        throw new ServiceUnavailableException(
          `We couldn't reach Stripe just now. Please try again in a moment. [${shortCode}]`,
        );
      }
      if (errName === "StripeAPIError" || stripeType === "api_error") {
        throw new ServiceUnavailableException(
          `Stripe is having an issue on their end. Please try again shortly. [${shortCode}]`,
        );
      }
      if (isStripe) {
        throw new ServiceUnavailableException(
          `Our payment provider returned an error. Please wait a moment and try again. [${shortCode}]`,
        );
      }
      // Not a Stripe error at all — most likely the StripeService
      // sdk getter threw because the client was never initialised
      // (STRIPE_SECRET_KEY truly missing), or some upstream library
      // threw. Surface BOTH the name and the message so the operator
      // can identify the failure without searching logs. We trim the
      // message to keep the response readable.
      const trimmed = errMessage.length > 200 ? errMessage.slice(0, 200) + "…" : errMessage;
      throw new ServiceUnavailableException(
        `Payment setup failed (${errName}): ${trimmed || "no error message"}. The site administrator can read the full error in the API logs.`,
      );
    }

    if (!session.url) {
      throw new ServiceUnavailableException("Stripe didn't return a checkout URL.");
    }

    await this.db.pastryOrder.update({
      where: { id: order.id },
      data: { stripeSessionId: session.id },
    });

    return { url: session.url, orderId: order.id, reference };
  }

  // ---------- promo preview (cart UI) ----------

  /**
   * Validate a promo code against the user's current cart WITHOUT
   * mutating any state. Drives the cart-page "Apply code" button so
   * the customer sees the discount land before they commit to
   * checkout. The actual atomic redemption happens later, inside
   * `startCheckout`, so the customer can change their mind without
   * burning the code.
   *
   * Returns the resolved `discountMinor` so the cart can show a
   * post-discount total side-by-side with the subtotal.
   */
  async previewPromoCode(
    userId: string,
    code: string,
  ): Promise<{
    code: string;
    discountMinor: number;
    subtotalMinor: number;
    payableAfterPromoMinor: number;
    appliedCreditAfterPromoMinor: number;
    currency: string;
  }> {
    const view = await this.cart.view(userId);
    if (view.lines.length === 0) {
      throw new BadRequestException("Your cart is empty — add an item before applying a code.");
    }
    const preview = await this.promoCodes.preview({
      code,
      userId,
      subtotalMinor: view.subtotalMinor,
      currency: view.currency,
    });
    const subtotalAfter = Math.max(0, view.subtotalMinor - preview.discountMinor);
    const credit = Math.min(view.applicableCreditMinor, subtotalAfter);
    return {
      code: preview.promo.code,
      discountMinor: preview.discountMinor,
      subtotalMinor: view.subtotalMinor,
      payableAfterPromoMinor: Math.max(0, subtotalAfter - credit),
      appliedCreditAfterPromoMinor: credit,
      currency: view.currency,
    };
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

    // Customer confirmation + admin notification — the helper refetches
    // with items so the admin email can render the full bill of materials.
    void this.dispatchPaidNotifications(order.id);
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
    // Customer-facing list — deliberately filtered so abandoned and
    // auto-cancelled attempts don't clutter the inbox. Specifically:
    //   - CANCELLED: hidden entirely. Two ways an order ends up here:
    //     (a) the operator cancelled it (rare on the customer side),
    //     (b) our auto-cancel kicked in when Stripe rejected the
    //         Checkout session because of a transient config error.
    //     Either way, the customer never saw money move; there's no
    //     reason to show them a list of false starts.
    //   - PENDING_PAYMENT: only shown if it's recent (<= 30 min old)
    //     because that's a legitimate "I started checkout, came back
    //     to my account before paying" case. Older pending rows are
    //     stale abandons and the webhook would never reconcile them.
    //
    // The admin list (`listAdminOrders`) shows everything regardless;
    // operators need the full picture for cleanup and audit.
    const cutoffForPending = new Date(Date.now() - 30 * 60 * 1000);
    const rows = await this.db.pastryOrder.findMany({
      where: {
        userId,
        OR: [
          { status: { notIn: [PastryOrderStatus.CANCELLED, PastryOrderStatus.PENDING_PAYMENT] } },
          {
            status: PastryOrderStatus.PENDING_PAYMENT,
            createdAt: { gte: cutoffForPending },
          },
        ],
      },
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

  /**
   * Re-verify a `PENDING_PAYMENT` order against Stripe and force-
   * complete it if Stripe confirms the session is paid. Used by the
   * `/cart/success` page as a webhook safety net — if the customer
   * paid but our DB still shows PENDING_PAYMENT (because the webhook
   * is slow, misconfigured, or in flight), this endpoint asks Stripe
   * directly and calls the existing idempotent webhook handler.
   *
   * Ownership-checked: customer can only reconcile their own orders.
   * No-op when the order is already past PENDING_PAYMENT.
   */
  async reconcileFromSession(
    userId: string,
    reference: string,
    sessionId: string | undefined,
  ): Promise<{ status: PastryOrderStatus; reconciled: boolean }> {
    if (!sessionId || !sessionId.startsWith("cs_")) {
      throw new BadRequestException("Missing Stripe session id.");
    }
    const order = await this.db.pastryOrder.findUnique({
      where: { reference },
      select: { id: true, userId: true, status: true, stripeSessionId: true },
    });
    if (!order || order.userId !== userId) throw new NotFoundException();

    // Already moved past PENDING_PAYMENT — nothing to do. Return the
    // current status so the client can stop polling.
    if (order.status !== PastryOrderStatus.PENDING_PAYMENT) {
      return { status: order.status, reconciled: false };
    }

    // Safety: only trust a session id that matches the one we stamped
    // onto the order at checkout creation. Prevents a customer from
    // passing any random session id to force-complete another order.
    if (order.stripeSessionId && order.stripeSessionId !== sessionId) {
      this.logger.warn(
        { reference, expected: order.stripeSessionId, presented: sessionId },
        "Reconcile attempt with mismatched session id",
      );
      throw new BadRequestException("Session id does not match this order.");
    }

    if (!this.stripe.isAvailable()) {
      throw new ServiceUnavailableException("Payments are not available right now.");
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.sdk.checkout.sessions.retrieve(sessionId);
    } catch (err) {
      this.logger.error({ err, sessionId, reference }, "Stripe session.retrieve failed");
      throw new ServiceUnavailableException(
        "We couldn't verify your payment with our provider. Please try again in a moment.",
      );
    }

    // Stripe authoritative state. We require `payment_status === "paid"`
    // — `complete` alone isn't enough since complete + unpaid means the
    // session expired before the customer finished checkout.
    if (session.payment_status !== "paid") {
      return { status: order.status, reconciled: false };
    }

    // Reuse the webhook handler. It's idempotent — if the webhook
    // lands in parallel it'll early-return on the PAID check.
    await this.onCheckoutCompleted({
      id: `recon_${sessionId}`,
      type: "checkout.session.completed",
      data: { object: session },
    } as unknown as Stripe.Event);

    return { status: PastryOrderStatus.PAID, reconciled: true };
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

    // In-app notification for the customer mirroring the status email.
    // We only notify on the customer-visible transitions; PENDING_PAYMENT
    // and PAID are handled elsewhere (PAID has its own paid-flow
    // notification with both customer + admin recipients).
    const customerTitle = (() => {
      switch (updated.status) {
        case "PREPARING":
          return `Order ${updated.reference} — we're preparing it now`;
        case "READY":
          return `Order ${updated.reference} is ready`;
        case "SHIPPED":
          return `Order ${updated.reference} is on its way`;
        case "DELIVERED":
          return `Order ${updated.reference} delivered — enjoy!`;
        case "CANCELLED":
          return `Order ${updated.reference} has been cancelled`;
        default:
          return null;
      }
    })();
    if (customerTitle) {
      const kindMap = {
        PREPARING: "pastry.order.preparing",
        READY: "pastry.order.ready",
        SHIPPED: "pastry.order.shipped",
        DELIVERED: "pastry.order.delivered",
        CANCELLED: "pastry.order.cancelled",
      } as const;
      void this.notifications.notifyUser(updated.userId, {
        kind: kindMap[updated.status as keyof typeof kindMap] ?? "pastry.order.preparing",
        title: customerTitle,
        href: `/account/orders/${updated.reference}`,
      });
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
   * Stripe coupons are simpler than promotion codes for ad-hoc
   * fixed-amount discounts. We create a one-off coupon valid for this
   * session only, named after what's being discounted. The `label`
   * parameter is what shows up on Stripe's hosted Checkout page — keep
   * it human-readable because it's literally what the customer reads
   * next to the line "- £X".
   *
   * Used for both Indulgence Credit (no promo) and the combined
   * Indulgence + promo discount when a customer applies both at once.
   * Stripe enforces a single-discount-per-session limit, so we bundle.
   */
  private async ensureSessionCoupon(
    amountMinor: number,
    currency: string,
    label: string = "Indulgence Credit",
  ): Promise<string> {
    const coupon = await this.stripe.sdk.coupons.create({
      amount_off: amountMinor,
      currency,
      duration: "once",
      name: `${label} (${currency.toUpperCase()} ${(amountMinor / 100).toFixed(2)})`,
    });
    return coupon.id;
  }

  /**
   * Fire-and-forget dispatcher for the two notifications that go out
   * the moment an order moves to PAID:
   *
   *   1. **Customer confirmation** — so they have the reference in
   *      their inbox even if Stripe's receipt lands in spam.
   *   2. **Admin notification** — sent to the support inbox so the
   *      kitchen sees the order without having to keep the admin
   *      dashboard open. Includes the reference, customer details,
   *      itemised totals, shipping address, kitchen notes, and a
   *      one-click link to the admin order detail page.
   *
   * Both emails are non-blocking; failures are logged and swallowed so
   * a transient mail-provider hiccup doesn't reverse a successful
   * payment. Called from BOTH the credits-only path (in `startCheckout`)
   * AND the Stripe webhook handler (`onCheckoutCompleted`).
   *
   * The function refetches the order with its line items + snapshots so
   * the admin email can render the bill of materials without callers
   * having to pre-load that data.
   */
  private async dispatchPaidNotifications(orderId: string): Promise<void> {
    let order;
    try {
      order = await this.db.pastryOrder.findUnique({
        where: { id: orderId },
        include: {
          items: {
            orderBy: { createdAt: "asc" },
            select: {
              quantity: true,
              unitPriceMinor: true,
              totalMinor: true,
              itemSnapshot: true,
            },
          },
        },
      });
    } catch (err) {
      this.logger.error({ err, orderId }, "Failed to load order for paid notifications");
      return;
    }
    if (!order) {
      this.logger.warn({ orderId }, "Order vanished before paid notifications could be sent");
      return;
    }

    void this.sendPaidEmail({
      to: order.email,
      recipientName: order.name,
      reference: order.reference,
      totalMinor: order.totalMinor,
      creditAppliedMinor: order.creditAppliedMinor,
      promoDiscountMinor: order.promoDiscountMinor,
      currency: order.currency,
    });
    void this.sendAdminPaidEmail(order);

    // In-app notifications. Customer sees their own confirmation in the
    // bell dropdown; every staff member (OWNER/EDITOR/SUPPORT) gets a
    // row in their own inbox so the team knows an order has landed
    // without needing to refresh the admin tab. Both calls are
    // fire-and-forget — a notification write failure must not undo
    // a successful payment.
    const formattedTotal = `${order.currency.toUpperCase()} ${(order.totalMinor / 100).toFixed(2)}`;
    void this.notifications.notifyUser(order.userId, {
      kind: "pastry.order.paid",
      title: `Order ${order.reference} confirmed`,
      body: `Total ${formattedTotal}. We'll let you know the moment it leaves the kitchen.`,
      href: `/account/orders/${order.reference}`,
    });
    void this.notifications.notifyStaff({
      kind: "pastry.order.paid",
      title: `New paid order ${order.reference}`,
      body: `${order.name} · ${formattedTotal}`,
      href: `/admin/pastry-orders/${order.reference}`,
    });
  }

  /**
   * Admin-facing notification when a pastry order is paid. Sent to the
   * `SUPPORT_INBOX` configured in env, with `Reply-To` set to the
   * customer's email so a one-tap reply opens a real conversation.
   * Includes the deep-link to the admin order page so the kitchen
   * doesn't have to navigate the dashboard from scratch.
   */
  private async sendAdminPaidEmail(order: {
    reference: string;
    email: string;
    name: string;
    phone: string | null;
    totalMinor: number;
    subtotalMinor: number;
    creditAppliedMinor: number;
    promoDiscountMinor: number;
    promoCodeId: string | null;
    currency: string;
    shippingLine1: string;
    shippingLine2: string | null;
    shippingCity: string;
    shippingPostcode: string;
    shippingCountry: string;
    notes: string | null;
    items: Array<{
      quantity: number;
      unitPriceMinor: number;
      totalMinor: number;
      itemSnapshot: Prisma.JsonValue;
    }>;
  }): Promise<void> {
    try {
      const env = getEnv();

      // Resolve display names off the snapshot (so renamed items still
      // show what was actually ordered).
      const items = order.items.map((line) => {
        const snap = (line.itemSnapshot ?? {}) as { name?: string; slug?: string };
        return {
          name: snap.name ?? snap.slug ?? "(unknown item)",
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          totalMinor: line.totalMinor,
        };
      });

      // Resolve the promo code string (if any) so the admin email
      // can show the human code rather than just an opaque id. We
      // look it up here rather than including a relation in the
      // earlier `findUnique` because the join is only useful for
      // this one email send.
      let promoCode: string | null = null;
      if (order.promoCodeId) {
        const row = await this.db.promoCode.findUnique({
          where: { id: order.promoCodeId },
          select: { code: true },
        });
        promoCode = row?.code ?? null;
      }

      const tpl = pastryOrderAdminNotifyTemplate({
        reference: order.reference,
        customerName: order.name,
        customerEmail: order.email,
        customerPhone: order.phone,
        totalMinor: order.totalMinor,
        subtotalMinor: order.subtotalMinor,
        creditAppliedMinor: order.creditAppliedMinor,
        promoDiscountMinor: order.promoDiscountMinor,
        promoCode,
        currency: order.currency,
        shippingLine1: order.shippingLine1,
        shippingLine2: order.shippingLine2,
        shippingCity: order.shippingCity,
        shippingPostcode: order.shippingPostcode,
        shippingCountry: order.shippingCountry,
        notes: order.notes,
        items,
        adminUrl: `${publicWebUrl()}/admin/pastry-orders/${encodeURIComponent(order.reference)}`,
      });

      await this.mailer.send({
        to: env.SUPPORT_INBOX,
        replyTo: order.email,
        ...tpl,
        tag: "pastry-order-admin-notify",
      });
    } catch (err) {
      this.logger.error(
        { err, reference: order.reference },
        "Admin pastry-order notification failed",
      );
    }
  }

  /**
   * Branded customer paid-confirmation email. Rendered via the shared
   * email shell (cream-50 paper, maroon brand band, italic-serif CTA)
   * so the inbox experience matches the on-site design language.
   * Stripe sends its own receipt; this complements it with a brand
   * touchpoint and the reference number front-and-centre.
   */
  private async sendPaidEmail(opts: {
    to: string;
    recipientName: string;
    reference: string;
    totalMinor: number;
    creditAppliedMinor: number;
    promoDiscountMinor: number;
    currency: string;
  }): Promise<void> {
    try {
      const tpl = pastryOrderConfirmedTemplate({
        recipientName: opts.recipientName,
        reference: opts.reference,
        totalMinor: opts.totalMinor,
        creditAppliedMinor: opts.creditAppliedMinor,
        promoDiscountMinor: opts.promoDiscountMinor,
        currency: opts.currency,
        orderUrl: `${publicWebUrl()}/account/orders/${encodeURIComponent(opts.reference)}`,
      });
      await this.mailer.send({
        to: opts.to,
        ...tpl,
        tag: "pastry-order-confirmed",
      });
    } catch (err) {
      this.logger.error(
        { err, reference: opts.reference },
        "Pastry order confirmation email failed",
      );
    }
  }

  /**
   * Customer-facing email for status transitions that materially change
   * what the customer is waiting for. Branded via the shared email
   * shell. PAID is handled separately via the payment-confirmed mail;
   * PENDING_PAYMENT, PAID, and REFUNDED are silent (no transition email
   * makes sense for these states).
   */
  private async dispatchStatusEmail(order: PastryOrder): Promise<void> {
    // Map the Prisma enum value to the template's expected union. The
    // template enforces the brand voice + design for each status; we
    // skip any state that doesn't have a customer-facing email.
    const STATUS_MAP: Partial<Record<PastryOrderStatus, PastryOrderStatusForEmail>> = {
      [PastryOrderStatus.PREPARING]: "PREPARING",
      [PastryOrderStatus.READY]: "READY",
      [PastryOrderStatus.SHIPPED]: "SHIPPED",
      [PastryOrderStatus.DELIVERED]: "DELIVERED",
      [PastryOrderStatus.CANCELLED]: "CANCELLED",
    };
    const mappedStatus = STATUS_MAP[order.status];
    if (!mappedStatus) return;

    const tpl = pastryOrderStatusTemplate({
      recipientName: order.name,
      reference: order.reference,
      status: mappedStatus,
      orderUrl: `${publicWebUrl()}/account/orders/${encodeURIComponent(order.reference)}`,
    });

    await this.mailer.send({
      to: order.email,
      ...tpl,
      tag: `pastry-order-${order.status.toLowerCase()}`,
    });
  }
}
