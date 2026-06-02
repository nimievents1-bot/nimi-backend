import { Module } from "@nestjs/common";

import {
  AdminShippingController,
  PublicShippingController,
} from "./shipping.controller";
import { ShippingService } from "./shipping.service";

/**
 * ShippingModule — postcode-zone-based delivery fee resolution and
 * admin CRUD. `ShippingService` is exported so the cart and order
 * modules can compute fees at checkout time without a network hop.
 */
@Module({
  controllers: [PublicShippingController, AdminShippingController],
  providers: [ShippingService],
  exports: [ShippingService],
})
export class ShippingModule {}
