import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { IsOptional, IsString, Length } from "class-validator";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { type AuthenticatedUser } from "../auth/types";

import { GiftingService } from "./gifting.service";

/**
 * Body for the post-checkout reconcile call from the public success page.
 * `sessionId` is the Stripe `cs_…` returned in the success URL — we use it
 * to verify the caller is the customer who just paid (anyone else doesn't
 * know that id).
 */
class ReconcileGiftOrderDto {
  @IsOptional()
  @IsString()
  @Length(10, 200)
  sessionId?: string;
}

/**
 * Customer-facing order endpoints.
 *
 * - GET /me — list this customer's gift orders.
 * - GET /by-reference/:ref — single order, used on the post-checkout success
 *   page. The order id is non-secret (it's in the URL after Stripe redirects),
 *   so we allow lookup-by-reference without auth, but we never expose
 *   `internalNotes` or `paymentIntentId` to the client.
 */
@Controller({ path: "gifting/orders", version: "1" })
export class CustomerOrdersController {
  constructor(private readonly gifting: GiftingService) {}

  @UseGuards(JwtAuthGuard)
  @Get("me")
  async list(@CurrentUser() user: AuthenticatedUser) {
    const rows = await this.gifting.getCustomerOrders(user.id);
    return rows.map(this.public);
  }

  /**
   * Auth-gated single-order lookup. Drives `/account/orders/gift/[ref]`.
   * Ownership-checked server-side: the service refuses to return an
   * order whose `userId` doesn't match the signed-in caller, even if
   * the reference is correct. This is the path we want customers to
   * use once they have an account — the public `by-reference` form
   * below only exists for the post-checkout success page where the
   * customer hasn't signed in yet.
   */
  @UseGuards(JwtAuthGuard)
  @Get("me/:reference")
  async byReferenceAuthed(
    @Param("reference") reference: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!/^NIMI-\d{4}-\d{4,8}$/.test(reference)) throw new NotFoundException();
    const row = await this.gifting.getCustomerOrderByReference(reference, user.id, null);
    return this.public(row);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("by-reference/:reference")
  async byReference(
    @Param("reference") reference: string,
    @Query("email") email?: string,
  ) {
    if (!/^NIMI-\d{4}-\d{4,8}$/.test(reference)) throw new NotFoundException();
    const row = await this.gifting.getCustomerOrderByReference(reference, null, email ?? null);
    return this.public(row);
  }

  /**
   * Post-checkout webhook safety net.
   *
   * Stripe sends `checkout.session.completed` via webhook, but delivery
   * is best-effort. If the webhook is slow, blocked by a misconfigured
   * signing secret, or pointed at the wrong URL, the order would still
   * read PENDING_PAYMENT in our DB and the customer would never get
   * their receipt, the admin would never get the alert, and the order
   * would sit in limbo forever.
   *
   * The gifting success page calls this endpoint as a fire-and-forget
   * side effect, passing the `session_id` Stripe stamped into the
   * success URL. We ask Stripe directly whether the session is paid,
   * and if it is, we run the same idempotent paid handler the webhook
   * would have run. So the customer-facing flow (the success page,
   * the receipt email, the admin notification, the staff bell) all
   * fire even when the webhook itself never lands.
   *
   * Public — the success page is anonymous post-redirect. Authorisation
   * is via the session id: only someone who has the Stripe-stamped URL
   * has the id, so this is the same level of trust as the rest of the
   * post-redirect surface.
   *
   * Idempotent — the underlying service no-ops when the order is already
   * past PENDING_PAYMENT, and the paid handler itself is idempotent on
   * the same condition. Webhook + reconcile race is safe.
   *
   * Throttled — we don't want a script hammering this with random
   * references; 30 requests per minute is plenty for the success page
   * but kills brute force.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("by-reference/:reference/reconcile")
  async reconcile(
    @Param("reference") reference: string,
    @Body() body: ReconcileGiftOrderDto,
  ) {
    if (!/^NIMI-\d{4}-\d{4,8}$/.test(reference)) throw new NotFoundException();
    return this.gifting.reconcileFromSession(reference, body.sessionId);
  }

  private public<T extends { items?: unknown[] }>(row: T) {
    // Strip internal fields before returning to the client.
    const r = row as unknown as Record<string, unknown>;
    const { internalNotes: _i, stripePaymentIntentId: _p, ...rest } = r;
    void _i;
    void _p;
    return rest;
  }
}
