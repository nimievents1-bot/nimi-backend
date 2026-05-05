import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { type FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { type AuthenticatedUser } from "../auth/types";

import { CreateCheckoutSessionDto } from "./dto/gifting.dto";
import { GiftingService } from "./gifting.service";

/**
 * Gifting checkout — creates a Stripe Checkout Session and returns the URL.
 * The web redirects the customer to that URL. Stripe handles card collection.
 *
 * Throttled at the same `contact` bucket as enquiry endpoints because it's a
 * public surface and we don't want to be a free-tier abuse vector for testing
 * stolen cards.
 */
@Controller({ path: "gifting/checkout", version: "1" })
export class CheckoutController {
  constructor(private readonly gifting: GiftingService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("session")
  @HttpCode(201)
  async createSession(
    @Body() dto: CreateCheckoutSessionDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.gifting.createCheckoutSession(dto, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      userId: user?.id,
    });
  }
}
