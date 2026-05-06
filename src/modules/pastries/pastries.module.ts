import { Module } from "@nestjs/common";

import {
  AdminPastriesController,
  PastriesController,
} from "./pastries.controller";
import { PastriesService } from "./pastries.service";

@Module({
  controllers: [PastriesController, AdminPastriesController],
  providers: [PastriesService],
  exports: [PastriesService],
})
export class PastriesModule {}
