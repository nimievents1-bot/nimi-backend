import { Module } from "@nestjs/common";

import { ContactModule } from "../contact/contact.module";
import { NotificationsModule } from "../notifications/notifications.module";

import { AdminGiftOrdersController } from "./admin-orders.controller";
import { CheckoutController } from "./checkout.controller";
import { CollectionsController } from "./collections.controller";
import { CustomerOrdersController } from "./customer-orders.controller";
import { GiftingService } from "./gifting.service";

@Module({
  imports: [ContactModule, NotificationsModule],
  controllers: [
    CollectionsController,
    CheckoutController,
    CustomerOrdersController,
    AdminGiftOrdersController,
  ],
  providers: [GiftingService],
  exports: [GiftingService],
})
export class GiftingModule {}
