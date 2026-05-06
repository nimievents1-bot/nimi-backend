import { Module } from "@nestjs/common";

import { CravingsModule } from "../cravings/cravings.module";
import { GiftingModule } from "../gifting/gifting.module";
import { PastryOrdersModule } from "../pastry-orders/pastry-orders.module";

import { StripeWebhookController } from "./stripe-webhook.controller";

@Module({
  imports: [GiftingModule, CravingsModule, PastryOrdersModule],
  controllers: [StripeWebhookController],
})
export class WebhooksModule {}
