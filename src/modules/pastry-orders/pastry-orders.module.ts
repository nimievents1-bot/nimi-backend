import { Module } from "@nestjs/common";

import { NotificationsModule } from "../notifications/notifications.module";
import { PastryCartModule } from "../pastry-cart/pastry-cart.module";
import { PromoCodesModule } from "../promo-codes/promo-codes.module";

import { AdminPastryOrdersController } from "./admin-pastry-orders.controller";
import { PastryOrdersController } from "./pastry-orders.controller";
import { PastryOrdersService } from "./pastry-orders.service";

@Module({
  imports: [PastryCartModule, NotificationsModule, PromoCodesModule],
  controllers: [PastryOrdersController, AdminPastryOrdersController],
  providers: [PastryOrdersService],
  exports: [PastryOrdersService],
})
export class PastryOrdersModule {}
