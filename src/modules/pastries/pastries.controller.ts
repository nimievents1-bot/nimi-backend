import {
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
  AdminListPastriesQueryDto,
  CreatePastryDto,
  ListPastriesQueryDto,
  UpdatePastryDto,
} from "./dto/pastries.dto";
import { PastriesService } from "./pastries.service";

/**
 * Public catalog. Anonymous read of items where `available = true`.
 * Throttled generously — the menu is rendered on every page that lets
 * customers add to cart, so 240/min is comfortable for legitimate use.
 */
@Controller({ path: "pastries", version: "1" })
export class PastriesController {
  constructor(private readonly pastries: PastriesService) {}

  @Public()
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Get()
  async list(@Query() query: ListPastriesQueryDto) {
    return this.pastries.listAvailable({ limit: query.limit, offset: query.offset });
  }

  @Public()
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Get(":slug")
  async getBySlug(@Param("slug") slug: string) {
    return this.pastries.getPublicBySlug(slug);
  }
}

@Controller({ path: "admin/pastries", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminPastriesController {
  constructor(private readonly pastries: PastriesService) {}

  @Get()
  async list(@Query() query: AdminListPastriesQueryDto) {
    return this.pastries.adminList({
      limit: query.limit,
      offset: query.offset,
      available: query.available,
      q: query.q,
    });
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return this.pastries.adminGet(id);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() dto: CreatePastryDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.pastries.create(dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdatePastryDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.pastries.update(id, dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Roles("OWNER")
  @Delete(":id")
  @HttpCode(200)
  async delete(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.pastries.delete(id, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
