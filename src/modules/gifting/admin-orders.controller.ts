import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { type FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { type AuthenticatedUser } from "../auth/types";

import {
  ListAdminOrdersDto,
  UpdateAdminOrderDto,
} from "./dto/gifting.dto";
import { GiftingService } from "./gifting.service";

/**
 * Admin orders pipeline — list, detail, status changes, internal notes.
 * Role: OWNER, EDITOR, SUPPORT (SUPPORT cannot CANCEL or REFUND — checked
 * server-side in `update`).
 */
@Controller({ path: "admin/gifting/orders", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR", "SUPPORT")
export class AdminGiftOrdersController {
  constructor(private readonly gifting: GiftingService) {}

  @Get()
  async list(@Query() query: ListAdminOrdersDto) {
    return this.gifting.adminListOrders({
      status: query.status as never,
      q: query.q,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return this.gifting.adminGetOrder(id);
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateAdminOrderDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (
      (dto.status === "CANCELLED" || dto.status === "REFUNDED") &&
      user.role !== "OWNER" &&
      user.role !== "EDITOR"
    ) {
      // SUPPORT not allowed.
      throw new (await import("@nestjs/common")).ForbiddenException();
    }
    return this.gifting.adminUpdateOrder(id, dto as never, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
