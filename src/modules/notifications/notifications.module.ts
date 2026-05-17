import { Module } from "@nestjs/common";

import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

/**
 * NotificationsModule — wires the in-app notification API and exports
 * `NotificationsService` so other modules can fire notifications from
 * their own service code (pastry orders, contact enquiries, etc.)
 * without re-instantiating it.
 *
 * PrismaService is available globally (see prisma/prisma.module.ts),
 * so no explicit import is needed here. Pure read/write module — no
 * Stripe, no mailer, no external services. Adding it to the app costs
 * one extra Prisma table; everything else is in-memory.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
