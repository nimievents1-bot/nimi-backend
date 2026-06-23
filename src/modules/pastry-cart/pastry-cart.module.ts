import { Module } from "@nestjs/common";

import { SiteSettingsModule } from "../site-settings/site-settings.module";

import { PastryCartController } from "./pastry-cart.controller";
import { PastryCartService } from "./pastry-cart.service";

@Module({
  imports: [SiteSettingsModule],
  controllers: [PastryCartController],
  providers: [PastryCartService],
  exports: [PastryCartService],
})
export class PastryCartModule {}
