import { Module } from "@nestjs/common";

import { NotificationsModule } from "../notifications/notifications.module";

import { AdminCravingsController, CravingsController } from "./cravings.controller";
import { CravingsService } from "./cravings.service";

@Module({
  imports: [NotificationsModule],
  controllers: [CravingsController, AdminCravingsController],
  providers: [CravingsService],
  exports: [CravingsService],
})
export class CravingsModule {}
