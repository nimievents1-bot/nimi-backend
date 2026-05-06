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
  AdminListPastryOrdersQueryDto,
  UpdatePastryOrderNotesDto,
  UpdatePastryOrderStatusDto,
} from "./dto/admin.dto";
import { PastryOrdersService } from "./pastry-orders.service";

/**
 * Admin pastry-orders surface. OWNER + EDITOR can read and transition
 * status; SUPPORT can read only (no mutating routes here today, so role
 * gates on the controller class itself).
 */
@Controller({ path: "admin/pastry-orders", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminPastryOrdersController {
  constructor(private readonly orders: PastryOrdersService) {}

  @Get()
  async list(@Query() query: AdminListPastryOrdersQueryDto) {
    return this.orders.adminList({
      limit: query.limit,
      offset: query.offset,
      status: query.status,
      q: query.q,
    });
  }

  @Get(":reference")
  async get(@Param("reference") reference: string) {
    return this.orders.adminGetByReference(reference);
  }

  @Patch(":reference/status")
  async updateStatus(
    @Param("reference") reference: string,
    @Body() dto: UpdatePastryOrderStatusDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.adminUpdateStatus(reference, dto.status, dto.note, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Patch(":reference/notes")
  async updateNotes(
    @Param("reference") reference: string,
    @Body() dto: UpdatePastryOrderNotesDto,
  ) {
    return this.orders.adminUpdateNotes(reference, dto.internalNotes);
  }
}
