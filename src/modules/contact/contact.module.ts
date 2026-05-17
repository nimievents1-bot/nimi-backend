import { Module } from "@nestjs/common";

import { NotificationsModule } from "../notifications/notifications.module";

import { AdminEnquiriesController } from "./admin-enquiries.controller";
import { ContactController } from "./contact.controller";
import { ContactService } from "./contact.service";
import { TurnstileService } from "./turnstile.service";

@Module({
  imports: [NotificationsModule],
  controllers: [ContactController, AdminEnquiriesController],
  providers: [ContactService, TurnstileService],
  exports: [TurnstileService],
})
export class ContactModule {}
