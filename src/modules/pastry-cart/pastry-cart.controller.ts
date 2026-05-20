import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { type AuthenticatedUser } from "../auth/types";

import { AddToCartDto, BulkAddDto, UpdateCartItemDto } from "./dto/cart.dto";
import { PastryCartService } from "./pastry-cart.service";

/**
 * Cart endpoints.
 *
 * All routes require authentication (JwtAuthGuard) — there's no guest
 * cart in v1. Throttle at 60/min/IP which is generous for legitimate
 * cart twiddling but blocks rapid abuse.
 */
@Controller({ path: "pastry-cart", version: "1" })
@UseGuards(JwtAuthGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PastryCartController {
  constructor(private readonly cart: PastryCartService) {}

  @Get()
  async view(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.view(user.id);
  }

  @Post("items")
  @HttpCode(200)
  async add(
    @Body() dto: AddToCartDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cart.addItem(user.id, dto);
  }

  /**
   * Bulk-add the contents of an anonymous visitor's guest cart into
   * the now-signed-in user's server cart. Called by the web `/cart`
   * page right after sign-in/sign-up when it detects a non-empty
   * localStorage guest cart. The response is the merged cart view
   * (same shape as `GET /pastry-cart`) plus counters the client can
   * use to confirm the sync result to the customer.
   */
  @Post("items/bulk")
  @HttpCode(200)
  async bulk(
    @Body() dto: BulkAddDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cart.bulkAdd(user.id, dto.items ?? []);
  }

  @Patch("items/:cartItemId")
  async update(
    @Param("cartItemId") cartItemId: string,
    @Body() dto: UpdateCartItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cart.updateItem(user.id, cartItemId, dto);
  }

  @Delete("items/:cartItemId")
  @HttpCode(200)
  async remove(
    @Param("cartItemId") cartItemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cart.removeItem(user.id, cartItemId);
  }

  @Delete()
  @HttpCode(200)
  async clear(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.clear(user.id);
  }
}
