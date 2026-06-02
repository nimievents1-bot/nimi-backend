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
  CreateServiceTierDto,
  TIER_CATEGORIES,
  UpdateServiceTierDto,
} from "./dto/service-tiers.dto";
import { ServiceTiersService } from "./service-tiers.service";

/**
 * Public read of active tiers by category. The marketing site hits
 * this once per page render — `/catering` queries with
 * `?category=CATERING`, `/events` with `?category=EVENTS`.
 */
@Controller({ path: "service-tiers", version: "1" })
export class PublicServiceTiersController {
  constructor(private readonly tiers: ServiceTiersService) {}

  @Public()
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Get()
  async list(@Query("category") category?: string) {
    if (!category || !(TIER_CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequestException(
        `category must be one of: ${TIER_CATEGORIES.join(", ")}`,
      );
    }
    return this.tiers.listPublic(category);
  }
}

/**
 * Admin CRUD. OWNER + EDITOR for read/create/update; OWNER only
 * for delete (destructive — soft-delete by toggling `active` off
 * is the recommended path for taking a tier offline).
 */
@Controller({ path: "admin/service-tiers", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminServiceTiersController {
  constructor(private readonly tiers: ServiceTiersService) {}

  @Get()
  async list() {
    return this.tiers.adminListAll();
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return this.tiers.adminGet(id);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() dto: CreateServiceTierDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tiers.create(dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateServiceTierDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tiers.update(id, dto, user.id, {
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
    return this.tiers.remove(id, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
