import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";

import {
  AdminListCollectionsDto,
  CreateGiftCollectionDto,
  UpdateGiftCollectionDto,
} from "./dto/gifting.dto";
import { GiftingService } from "./gifting.service";

/**
 * Admin CRUD for `GiftCollection`. Mirrors the shape of
 * `AdminPastriesController` so the admin UI patterns stay
 * consistent across catalogue surfaces.
 *
 * Role gates:
 *   - OWNER + EDITOR can list / read / create / update.
 *   - DELETE is restricted to OWNER because removing a row that
 *     has historical orders attached would surface a friendlier
 *     400 (see `deleteCollection`), but the action itself is
 *     destructive enough that we keep the trigger on the highest
 *     role only. EDITOR can always unpublish (`published = false`)
 *     to take a row off the public site without touching history.
 *
 * Path: `/v1/admin/gifting/collections`. The `gifting/` segment
 * mirrors the public `/v1/gifting/collections` namespace so an
 * operator reading the URL bar can tell at a glance which surface
 * they're on.
 */
@Controller({ path: "admin/gifting/collections", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminCollectionsController {
  constructor(private readonly gifting: GiftingService) {}

  @Get()
  async list(@Query() query: AdminListCollectionsDto) {
    return this.gifting.adminListCollections({
      limit: query.limit,
      offset: query.offset,
      published: query.published,
      category: query.category,
    });
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    if (!id) throw new NotFoundException();
    return this.gifting.adminGetCollection(id);
  }

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateGiftCollectionDto) {
    return this.gifting.createCollection(dto);
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateGiftCollectionDto,
  ) {
    return this.gifting.updateCollection(id, dto);
  }

  @Roles("OWNER")
  @Delete(":id")
  @HttpCode(200)
  async delete(@Param("id") id: string) {
    return this.gifting.deleteCollection(id);
  }
}
