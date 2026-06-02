import { Module } from "@nestjs/common";

import {
  AdminSiteImagesController,
  PublicSiteImagesController,
} from "./site-images.controller";
import { SiteImagesService } from "./site-images.service";

/**
 * SiteImagesModule — admin-editable overrides for marketing-site
 * imagery. Sits alongside the CMS / content surfaces but stays
 * deliberately narrow in scope: one row = one editable image slot
 * keyed by stable string. See `SiteImagesService` for the design
 * rationale.
 */
@Module({
  controllers: [PublicSiteImagesController, AdminSiteImagesController],
  providers: [SiteImagesService],
  exports: [SiteImagesService],
})
export class SiteImagesModule {}
