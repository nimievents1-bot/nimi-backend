import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
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

import { ALLOWED_PAGES, type AllowedPage } from "./blocks";
import { ContentService } from "./content.service";
import { UpsertContentBlockDto } from "./dto/content.dto";

/**
 * Content endpoints.
 *
 * Public reads at /api/v1/content/:page/:key — no auth, throttled at the
 * default bucket. Admin writes at /api/v1/content/admin/* — guarded by
 * @Roles("OWNER", "EDITOR").
 */
@Controller({ path: "content", version: "1" })
export class ContentController {
  constructor(private readonly content: ContentService) {}

  // ---------- public ----------

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get(":page/:key")
  @HttpCode(200)
  async publicRead(@Param("page") page: string, @Param("key") key: string, @Query("locale") locale?: string) {
    if (!ALLOWED_PAGES.includes(page as AllowedPage)) {
      throw new NotFoundException();
    }
    const block = await this.content.publicRead(page as AllowedPage, key, locale ?? "en");
    if (!block) throw new NotFoundException();
    return block;
  }

  // ---------- admin ----------

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("OWNER", "EDITOR")
  @Get("admin/list")
  async adminList(@Query("page") page?: string) {
    return this.content.adminListByPage(page);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("OWNER", "EDITOR")
  @Get("admin/latest/:page/:key")
  async adminLatest(@Param("page") page: string, @Param("key") key: string, @Query("locale") locale?: string) {
    return this.content.adminLatest(page, key, locale ?? "en");
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("OWNER", "EDITOR")
  @Post("admin/draft")
  @HttpCode(201)
  async upsertDraft(
    @Body() dto: UpsertContentBlockDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.content.upsertDraft(dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("OWNER", "EDITOR")
  @Post("admin/publish/:id")
  @HttpCode(200)
  async publish(@Param("id") id: string, @Req() req: FastifyRequest, @CurrentUser() user: AuthenticatedUser) {
    return this.content.publish(id, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("OWNER")
  @Post("admin/rollback/:page/:key/:version")
  @HttpCode(200)
  async rollback(
    @Param("page") page: string,
    @Param("key") key: string,
    @Param("version", ParseIntPipe) version: number,
    @Query("locale") locale: string | undefined,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.content.rollback(page, key, locale ?? "en", version, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
