import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { type AuthenticatedUser } from "../auth/types";

import { GiftingService } from "./gifting.service";

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

  private public<T extends { items?: unknown[] }>(row: T) {
    // Strip internal fields before returning to the client.
    const r = row as unknown as Record<string, unknown>;
    const { internalNotes: _i, stripePaymentIntentId: _p, ...rest } = r;
    void _i;
    void _p;
    return rest;
  }
}
