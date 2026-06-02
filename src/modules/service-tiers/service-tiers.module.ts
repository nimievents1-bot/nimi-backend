import { Module } from "@nestjs/common";

import {
  AdminServiceTiersController,
  PublicServiceTiersController,
} from "./service-tiers.controller";
import { ServiceTiersService } from "./service-tiers.service";

/**
 * ServiceTiersModule — the three-card tier blocks shown on the
 * `/catering` and `/events` marketing pages, admin-editable. Sister
 * module to `SiteImagesModule` / `SiteSettingsModule` — same registry-
 * driven feel from the admin side, but with structured data
 * (eyebrow/title/description/bullets/image) instead of one URL or
 * one string per key.
 */
@Module({
  controllers: [PublicServiceTiersController, AdminServiceTiersController],
  providers: [ServiceTiersService],
  exports: [ServiceTiersService],
})
export class ServiceTiersModule {}
