import { Global, Module } from "@nestjs/common";

import { MailerService } from "./mailer.service";

/**
 * Global mailer module — any feature module that needs to send email
 * just injects MailerService without re-importing this module.
 */
@Global()
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
