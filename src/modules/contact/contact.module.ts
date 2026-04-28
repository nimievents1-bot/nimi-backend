import { Module } from "@nestjs/common";

import { AdminEnquiriesController } from "./admin-enquiries.controller";
import { ContactController } from "./contact.controller";
import { ContactService } from "./contact.service";
import { TurnstileService } from "./turnstile.service";

@Module({
  controllers: [ContactController, AdminEnquiriesController],
  providers: [ContactService, TurnstileService],
  exports: [TurnstileService],
})
export class ContactModule {}
