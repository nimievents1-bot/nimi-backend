import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { type FastifyRequest } from "fastify";
import type Stripe from "stripe";

import { Public } from "../../common/decorators/public.decorator";
import { CravingsService } from "../cravings/cravings.service";
import { GiftingService } from "../gifting/gifting.service";
import { PastryOrdersService } from "../pastry-orders/pastry-orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";

/**
 * Stripe webhook receiver.
 *
 * Path is *deliberately* outside `/api/v1` and `auth/` so it has its own
 * route prefix (`/webhooks/stripe`). The handler:
 *   1. Verifies the `Stripe-Signature` header against the raw body.
 *   2. Records the event in `StripeEvent` for idempotency. If we've seen
 *      this `event.id` before, return 200 immediately (Stripe will keep
 *      retrying until it gets a 2xx).
 *   3. Dispatches to a per-type handler.
 *
 * The route is excluded from the global API prefix in `main.ts` and Fastify
 * is configured with `rawBody` capture for it specifically.
 */
@Controller("webhooks/stripe")
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly gifting: GiftingService,
    private readonly cravings: CravingsService,
    private readonly pastryOrders: PastryOrdersService,
    private readonly db: PrismaService,
  ) {}

  @Public()
  @SkipThrottle()
  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Headers("stripe-signature") signature: string,
  ): Promise<{ received: true }> {
    if (!signature) {
      this.logger.warn("Missing Stripe signature header");
      throw new BadRequestException("Missing Stripe signature");
    }
    if (!req.rawBody) {
      this.logger.error("Webhook handler reached without rawBody — Fastify config error");
      throw new BadRequestException("Missing raw body");
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.verifyWebhook(req.rawBody, signature);
    } catch (err) {
      this.logger.warn({ err }, "Stripe webhook signature verification failed");
      throw new BadRequestException("Invalid signature");
    }

    // Idempotency: only proceed if this event id is new.
    const isNew = await this.recordEvent(event);
    if (!isNew) {
      this.logger.log({ eventId: event.id, type: event.type }, "Duplicate event ignored");
      return { received: true };
    }

    try {
      await this.dispatch(event);
      await this.db.stripeEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      // Don't mark processed — Stripe will retry. Log loudly.
      this.logger.error({ err, eventId: event.id, type: event.type }, "Webhook handler error");
      throw err;
    }

    return { received: true };
  }

  private async recordEvent(event: Stripe.Event): Promise<boolean> {
    try {
      await this.db.stripeEvent.create({
        data: {
          id: event.id,
          type: event.type,
          // Store the entire event for later reconciliation. Cast through unknown
          // because Stripe.Event isn't trivially assignable to Prisma JsonValue.
          payload: event as unknown as object,
        },
      });
      return true;
    } catch (err) {
      // Unique constraint violation → already seen.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("P2002") || message.includes("Unique constraint")) {
        return false;
      }
      throw err;
    }
  }

  private async dispatch(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      // ----- One-off payments (gifting + pastry orders) -----
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription") {
          // Subscriptions are mirrored from customer.subscription.* events.
          break;
        }
        // Route by metadata.kind set on session creation. Gifting sessions
        // omit `kind`, so we fall through to the gifting handler by default.
        if (session.metadata?.kind === "pastry_order") {
          await this.pastryOrders.onCheckoutCompleted(event);
        } else {
          await this.gifting.onCheckoutSessionCompleted(session);
        }
        break;
      }
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await this.gifting.onCheckoutSessionAsyncResult(session, event.type);
        break;
      }

      // ----- Cravings subscriptions -----
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await this.cravings.onSubscriptionEvent(event);
        break;
      }
      case "invoice.paid": {
        await this.cravings.onInvoicePaid(event);
        break;
      }

      // ----- Refunds (route to whichever module owns the charge) -----
      case "charge.refunded":
      case "charge.refund.updated": {
        const charge = event.data.object as Stripe.Charge;
        await this.gifting.onChargeRefunded(charge);
        await this.cravings.onCravingsRefund(charge);
        break;
      }

      default: {
        this.logger.debug({ type: event.type, id: event.id }, "Unhandled Stripe event type");
      }
    }
  }
}
