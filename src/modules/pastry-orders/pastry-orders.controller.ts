import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { type AuthenticatedUser } from "../auth/types";

import { StartPastryCheckoutDto } from "./dto/checkout.dto";
import { PastryOrdersService } from "./pastry-orders.service";

/**
 * Customer-facing pastry order endpoints. All require authentication —
 * pastry orders aren't anonymous in v1 (Indulgence Credits + order
 * history both require an account).
 */
@Controller({ path: "pastry-orders", version: "1" })
@UseGuards(JwtAuthGuard)
export class PastryOrdersController {
  constructor(private readonly orders: PastryOrdersService) {}

  /**
   * Build the order, create a Stripe Checkout session if needed, return
   * the URL the client should redirect to. Tight throttle — checkout is
   * expensive and shouldn't be hit faster than a human can click.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("checkout")
  @HttpCode(200)
  async checkout(
    @Body() dto: StartPastryCheckoutDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.startCheckout(dto, {
      id: user.id,
      email: user.email,
      // We don't pull `name` onto AuthenticatedUser today — the recipient
      // name in the dto is what we use on the order, so falling back to
      // empty here is safe.
      name: "",
    });
  }

  @Get("mine")
  async listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.listMyOrders(user.id);
  }

  @Get("mine/:reference")
  async getMine(
    @Param("reference") reference: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.getMyOrderByReference(user.id, reference);
  }

  /**
   * Reconcile a PENDING_PAYMENT order against Stripe. Called by the
   * success page after a redirect from Stripe Checkout — the page has
   * the `session_id` Stripe stamped into the success_url, and we use
   * it to verify the payment directly with Stripe.
   *
   * Why this exists: webhooks are best-effort. If the
   * `checkout.session.completed` event is slow, retried, or misrouted
   * (wrong endpoint in Stripe Dashboard, wrong signing secret, transient
   * network issue), the order would sit in PENDING_PAYMENT and the
   * customer would land on the "Thank you" page seeing a stale state.
   * This endpoint asks Stripe directly and force-completes the order
   * when Stripe confirms the session is paid. It calls the same
   * idempotent `onCheckoutCompleted` handler the webhook uses, so the
   * downstream flows (email, in-app, admin notify, credit deduction)
   * fire normally — never twice, even if the webhook lands later.
   *
   * Tight throttle: 10/min per session. This isn't a polling endpoint.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("mine/:reference/reconcile")
  @HttpCode(200)
  async reconcile(
    @Param("reference") reference: string,
    @Body() body: { sessionId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.reconcileFromSession(user.id, reference, body.sessionId);
  }

  /**
   * Validate a promo code against the customer's current cart and
   * return the resolved discount. Drives the "Apply code" affordance
   * on the cart page so the customer sees the saving before they
   * commit at checkout. Throttle is generous on purpose — a customer
   * trying a few codes from emails shouldn't get rate-limited — but
   * tight enough to short-circuit any brute-force probe of the
   * unguessable-code space.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("promo/preview")
  @HttpCode(200)
  async previewPromo(
    @Body() body: { code?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.previewPromoCode(user.id, body?.code ?? "");
  }
}
