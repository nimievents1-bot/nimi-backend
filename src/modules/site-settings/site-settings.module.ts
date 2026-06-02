import { Module } from "@nestjs/common";

import {
  AdminSiteSettingsController,
  PublicSiteSettingsController,
} from "./site-settings.controller";
import { SiteSettingsService } from "./site-settings.service";

/**
 * SiteSettingsModule — admin-editable plain-text snippets for the
 * marketing site. See `SiteSettingsService` for the design
 * rationale. Sister module to `SiteImagesModule`; they share the
 * same registry-based approach, just one stores text and the other
 * stores image URLs.
 */
@Module({
  controllers: [PublicSiteSettingsController, AdminSiteSettingsController],
  providers: [SiteSettingsService],
  exports: [SiteSettingsService],
})
export class SiteSettingsModule {}
