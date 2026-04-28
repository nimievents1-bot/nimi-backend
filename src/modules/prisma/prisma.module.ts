import { Global, Module } from "@nestjs/common";

import { PrismaService } from "./prisma.service";

/**
 * Global Prisma module so any module can inject `PrismaService`
 * without re-importing PrismaModule explicitly.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
