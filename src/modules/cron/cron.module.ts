import { Module } from "@nestjs/common";

import { PromoCodesModule } from "../promo-codes/promo-codes.module";

import { CronController } from "./cron.controller";
import { CronService } from "./cron.service";

@Module({
  imports: [PromoCodesModule],
  controllers: [CronController],
  providers: [CronService],
})
export class CronModule {}
