import { Module } from "@nestjs/common";

import { CravingsModule } from "../cravings/cravings.module";
import { GiftingModule } from "../gifting/gifting.module";

import { StripeWebhookController } from "./stripe-webhook.controller";

@Module({
  imports: [GiftingModule, CravingsModule],
  controllers: [StripeWebhookController],
})
export class WebhooksModule {}
