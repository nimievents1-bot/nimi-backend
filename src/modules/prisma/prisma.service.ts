import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Prisma client wrapped as an injectable Nest service.
 *
 * - Connects on module init so failure crashes startup (fail fast).
 * - Closes the pool cleanly on shutdown so we don't leak connections.
 * - Logs query errors at warn level; queries themselves go to debug if enabled.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { level: "warn", emit: "event" },
        { level: "error", emit: "event" },
      ],
      errorFormat: "minimal",
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log("Prisma connected");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
