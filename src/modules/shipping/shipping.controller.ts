import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { type FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { type AuthenticatedUser } from "../auth/types";

import {
  CreateShippingZoneDto,
  UpdateShippingZoneDto,
} from "./dto/shipping.dto";
import { ShippingService } from "./shipping.service";

/**
 * Public — quote a delivery fee for a postcode + subtotal. Used by
 * the marketing site when the customer enters their address on the
 * cart page, so they see the resolved fee before committing.
 *
 * Anonymous access is fine — the data exposed (zone name, fee) is
 * already public the moment we'd render it on the cart anyway.
 *
 * Throttled because this is the kind of endpoint a curious script
 * might scrape to map our pricing — 240/min is comfortable for
 * legitimate use, well above any single customer's input rate.
 */
@Controller({ path: "shipping", version: "1" })
export class PublicShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Public()
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Get("quote")
  async quote(
    @Query("postcode") postcode: string,
    @Query("subtotalMinor") subtotalRaw: string,
  ) {
    if (!postcode) {
      throw new BadRequestException("postcode is required");
    }
    const subtotalMinor = Number(subtotalRaw);
    if (!Number.isFinite(subtotalMinor) || subtotalMinor < 0) {
      throw new BadRequestException("subtotalMinor must be a non-negative integer");
    }
    const result = await this.shipping.resolveFee(postcode, subtotalMinor);
    if (!result) {
      return {
        ok: false as const,
        message:
          "Sorry — we don't ship to that postcode yet. Get in touch if you'd like to discuss a custom arrangement.",
      };
    }
    return { ok: true as const, ...result };
  }
}

/**
 * Admin CRUD. Same shape as `AdminSiteImagesController` and
 * friends. OWNER + EDITOR can read / create / update. DELETE
 * restricted to OWNER — deleting a zone could leave customers in
 * its postcode range with no resolvable fee until the operator
 * adds a replacement, so we keep it on the highest role.
 */
@Controller({ path: "admin/shipping/zones", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Get()
  async list() {
    return this.shipping.listAll();
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return this.shipping.getById(id);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() dto: CreateShippingZoneDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.shipping.create(dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateShippingZoneDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.shipping.update(id, dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Roles("OWNER")
  @Delete(":id")
  @HttpCode(200)
  async remove(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.shipping.remove(id, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
