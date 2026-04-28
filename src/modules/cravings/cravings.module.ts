import { Module } from "@nestjs/common";

import { AdminCravingsController, CravingsController } from "./cravings.controller";
import { CravingsService } from "./cravings.service";

@Module({
  controllers: [CravingsController, AdminCravingsController],
  providers: [CravingsService],
  exports: [CravingsService],
})
export class CravingsModule {}
