import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import Stripe from "stripe";

import { getEnv } from "../../config/env";

/**
 * Thin Stripe client wrapper.
 *
 * - Single Stripe instance shared by the app.
 * - If STRIPE_SECRET_KEY is missing the app still boots — checkout/subscription
 *   endpoints will return 503 via `isAvailable()`. In production we log at
 *   error level so this is loud in the dashboard, but we don't refuse to
 *   start: the marketing site, blog, and enquiry flows must remain available
 *   even if payments are temporarily unconfigured.
 * - Webhook signature verification is exposed via `verifyWebhook`, used by
 *   the StripeWebhookController.
 *
 * The client is configured with `apiVersion` from env so we can pin a
 * version per deploy and never get surprised by Stripe's defaults.
 */
@Injectable()
export class StripeService implements OnModuleInit {
  private readonly logger = new Logger(StripeService.name);
  private client: Stripe | null = null;

  onModuleInit(): void {
    const env = getEnv();
    if (!env.STRIPE_SECRET_KEY) {
      const msg =
        "STRIPE_SECRET_KEY not set — Stripe disabled. Checkout and subscription endpoints will return 503 until configured.";
      if (env.NODE_ENV === "production") {
        this.logger.error(msg);
      } else {
        this.logger.warn(msg);
      }
      return;
    }

    this.client = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
      typescript: true,
      maxNetworkRetries: 2,
      timeout: 15_000,
      appInfo: { name: "nimi-api", version: "0.1.0" },
    });
    this.logger.log("Stripe client initialised");
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  /** Get the underlying Stripe client. Throws if not configured. */
  get sdk(): Stripe {
    if (!this.client) {
      throw new Error("Stripe is not configured — set STRIPE_SECRET_KEY.");
    }
    return this.client;
  }

  /**
   * Verify a webhook payload and return the parsed event.
   * Throws on bad signature; let the caller turn that into a 400.
   */
  verifyWebhook(rawBody: Buffer | string, signature: string): Stripe.Event {
    const env = getEnv();
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error("STRIPE_WEBHOOK_SECRET is not set");
    }
    return this.sdk.webhooks.constructEvent(rawBody, signature, secret);
  }
}
