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
}
