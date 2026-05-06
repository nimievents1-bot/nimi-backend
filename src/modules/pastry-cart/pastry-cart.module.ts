import { Module } from "@nestjs/common";

import { PastryCartController } from "./pastry-cart.controller";
import { PastryCartService } from "./pastry-cart.service";

@Module({
  controllers: [PastryCartController],
  providers: [PastryCartService],
  exports: [PastryCartService],
})
export class PastryCartModule {}
