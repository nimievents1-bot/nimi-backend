import { Module } from "@nestjs/common";

import { ProfileController } from "./profile.controller";
import { ProfileService } from "./profile.service";

/**
 * ProfileModule — customer-facing profile read/write. Prisma is global
 * (see prisma/prisma.module.ts), so no explicit imports needed.
 */
@Module({
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
