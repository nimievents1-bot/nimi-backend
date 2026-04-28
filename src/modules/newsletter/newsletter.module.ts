import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { ContactModule } from "../contact/contact.module";
import { TurnstileService } from "../contact/turnstile.service";

import { NewsletterController } from "./newsletter.controller";
import { NewsletterService } from "./newsletter.service";

/**
 * NewsletterModule — depends on JwtModule for signed opt-in tokens
 * and the Turnstile service from the contact module.
 */
@Module({
  imports: [JwtModule.register({}), ContactModule],
  controllers: [NewsletterController],
  providers: [NewsletterService, TurnstileService],
})
export class NewsletterModule {}
