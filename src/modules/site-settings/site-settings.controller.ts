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

import { isValidSiteSettingKey, UpsertSiteSettingDto } from "./dto/site-settings.dto";
import { SiteSettingsService } from "./site-settings.service";

/**
 * Public read — one bulk endpoint returning every override. The
 * marketing site uses this through `lib/siteSettings.ts` which
 * caches the response for 60 seconds. Anonymous access is fine:
 * these strings are already public the moment they render.
 */
@Controller({ path: "site-settings", version: "1" })
export class PublicSiteSettingsController {
  constructor(private readonly siteSettings: SiteSettingsService) {}

  @Public()
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Get()
  async list() {
    return this.siteSettings.listPublic();
  }
}

/**
 * Admin CRUD. Mirrors `AdminSiteImagesController` exactly.
 *
 * Roles:
 *   - OWNER + EDITOR: read, upsert.
 *   - OWNER only: delete (resets the setting to its code-level
 *     fallback).
 */
@Controller({ path: "admin/site-settings", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminSiteSettingsController {
  constructor(private readonly siteSettings: SiteSettingsService) {}

  @Get()
  async list() {
    return this.siteSettings.listAll();
  }

  @Put(":key")
  async upsert(
    @Param("key") key: string,
    @Body() dto: UpsertSiteSettingDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!isValidSiteSettingKey(key)) {
      throw new BadRequestException(
        "Key must be lowercase letters/numbers, optionally dot- or hyphen-segmented (e.g. `gifting.production-timeline.pill`).",
      );
    }
    return this.siteSettings.upsert(key, dto, user.id, {
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
    if (!isValidSiteSettingKey(key)) {
      throw new BadRequestException(
        "Key must be lowercase letters/numbers, optionally dot- or hyphen-segmented.",
      );
    }
    return this.siteSettings.remove(key, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
