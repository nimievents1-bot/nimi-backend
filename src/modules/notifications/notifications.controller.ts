import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { type AuthenticatedUser } from "../auth/types";

import { NotificationsService } from "./notifications.service";

/**
 * Notifications API — drives the bell icon in both the customer header
 * and the admin shell. Every route is JWT-guarded; there is no public
 * surface for this resource.
 *
 * Routes:
 *   GET   /notifications              List recent (newest first, capped)
 *   GET   /notifications/unread-count Lightweight number-only endpoint for polling the badge
 *   POST  /notifications/:id/read     Mark one as read
 *   POST  /notifications/read-all     Mark every unread as read
 *
 * The list endpoint is polled by the bell component every 30 s; the
 * unread-count endpoint is even cheaper (no list payload) and is used
 * by parts of the UI that only need the badge value, not the body.
 */
@Controller({ path: "notifications", version: "1" })
@UseGuards(JwtAuthGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limitRaw?: string,
    @Query("unread") unreadRaw?: string,
  ) {
    const limit = limitRaw ? Math.max(1, Math.min(100, Number(limitRaw) || 30)) : 30;
    const unreadOnly = unreadRaw === "true" || unreadRaw === "1";
    const rows = await this.notifications.listForUser(user.id, { limit, unreadOnly });
    const unreadCount = await this.notifications.unreadCount(user.id);
    return { rows, unreadCount };
  }

  @Get("unread-count")
  async unread(@CurrentUser() user: AuthenticatedUser) {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  @Post(":id/read")
  @HttpCode(200)
  async markRead(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.notifications.markRead(user.id, id);
    return { ok: true };
  }

  @Post("read-all")
  @HttpCode(200)
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }
}
