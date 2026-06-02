import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
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

import { isValidSiteImageKey, UpsertSiteImageDto } from "./dto/site-images.dto";
import { SiteImagesService } from "./site-images.service";

/**
 * Public read of every override row.
 *
 * Why a single bulk endpoint rather than per-key lookups: the
 * marketing site renders many images per page and we want at most
 * one network request to resolve them all. The payload is tiny
 * (~25 rows max) and changes infrequently, so the standard
 * `Cache-Control` ladder applies.
 *
 * Anonymous access is fine — these URLs are already public by the
 * time they're rendered to anonymous visitors. No PII.
 */
@Controller({ path: "site-images", version: "1" })
export class PublicSiteImagesController {
  constructor(private readonly siteImages: SiteImagesService) {}

  @Public()
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Get()
  async list() {
    return this.siteImages.listPublic();
  }
}

/**
 * Admin CRUD. Mirrors `AdminPastriesController` / `AdminCollectionsController`
 * shape so the admin UI patterns stay consistent.
 *
 * Roles:
 *   - OWNER + EDITOR can read, upsert.
 *   - DELETE restricted to OWNER. Deleting an override resets the
 *     slot to its code-level fallback — it's not catastrophic, but
 *     we keep destructive actions on the highest role.
 *
 * Endpoints:
 *   - GET    /v1/admin/site-images        → list all overrides
 *   - PUT    /v1/admin/site-images/:key   → upsert one (create or
 *                                            update)
 *   - DELETE /v1/admin/site-images/:key   → reset to default
 *
 * No POST / PATCH split: upsert-by-key is the natural verb for an
 * idempotent key-addressed resource, and the admin UI maps cleanly
 * to it ("save this image slot").
 */
@Controller({ path: "admin/site-images", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminSiteImagesController {
  constructor(private readonly siteImages: SiteImagesService) {}

  @Get()
  async list() {
    return this.siteImages.listAll();
  }

  @Put(":key")
  async upsert(
    @Param("key") key: string,
    @Body() dto: UpsertSiteImageDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!isValidSiteImageKey(key)) {
      throw new BadRequestException(
        "Key must be letters/numbers (either case), optionally dot- or hyphen-segmented (e.g. `hero.home`, `gifting.softLuxe`).",
      );
    }
    return this.siteImages.upsert(key, dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Roles("OWNER")
  @Delete(":key")
  @HttpCode(200)
  async remove(
    @Param("key") key: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!isValidSiteImageKey(key)) {
      throw new BadRequestException(
        "Key must be letters/numbers (either case), optionally dot- or hyphen-segmented.",
      );
    }
    return this.siteImages.remove(key, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
