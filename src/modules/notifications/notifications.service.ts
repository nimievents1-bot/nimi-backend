import { Injectable, Logger } from "@nestjs/common";
import { Role } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

/**
 * In-app notification service.
 *
 * Two delivery shapes:
 *
 *   `notifyUser`  — creates a single row for one specific recipient
 *                   (the customer whose order moved to PAID, etc.).
 *
 *   `notifyStaff` — fans the same payload out across every active
 *                   OWNER / EDITOR / SUPPORT user, one row each. This
 *                   keeps the unread-count query trivial and means an
 *                   admin who reads a notification doesn't mark it
 *                   read for their team-mates.
 *
 * The service is intentionally side-effect-only at the call site: it
 * never throws on a write failure, just logs. Callers (`pastry-orders`,
 * `contact`, etc.) wrap the call in `void notify*(...)` so a notification
 * failure can never block the business-critical action that triggered it
 * (a paid order must succeed even if our in-app inbox is down).
 */

export type NotificationKind =
  | "pastry.order.paid"
  | "pastry.order.preparing"
  | "pastry.order.ready"
  | "pastry.order.shipped"
  | "pastry.order.delivered"
  | "pastry.order.cancelled"
  | "contact.enquiry.new";

export interface NotificationPayload {
  kind: NotificationKind;
  title: string;
  body?: string;
  /** In-app deep-link the bell UI follows on click. */
  href?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly db: PrismaService) {}

  /**
   * Create a notification addressed to a single user. Used for
   * customer-facing events like "your order is preparing" or
   * subscription state changes.
   */
  async notifyUser(userId: string, payload: NotificationPayload): Promise<void> {
    try {
      await this.db.notification.create({
        data: {
          userId,
          kind: payload.kind,
          title: payload.title,
          body: payload.body ?? null,
          href: payload.href ?? null,
        },
      });
    } catch (err) {
      this.logger.error({ err, userId, kind: payload.kind }, "Failed to create user notification");
    }
  }

  /**
   * Create a notification per staff member (OWNER/EDITOR/SUPPORT).
   *
   * Why fan-out at write time instead of broadcasting at read time:
   *   - Unread counts become a simple per-row query.
   *   - A staff member can mark a notification read without affecting
   *     anyone else's inbox.
   *   - New staff members joining after the event don't suddenly see
   *     historical alerts — which matches the email behaviour we already
   *     have (SUPPORT_INBOX is one address; only people watching it at
   *     the time see it).
   */
  async notifyStaff(payload: NotificationPayload): Promise<void> {
    try {
      const staff = await this.db.user.findMany({
        where: {
          role: { in: [Role.OWNER, Role.EDITOR, Role.SUPPORT] },
          deletedAt: null,
        },
        select: { id: true },
      });
      if (staff.length === 0) return;

      await this.db.notification.createMany({
        data: staff.map((u) => ({
          userId: u.id,
          kind: payload.kind,
          title: payload.title,
          body: payload.body ?? null,
          href: payload.href ?? null,
        })),
      });
    } catch (err) {
      this.logger.error({ err, kind: payload.kind }, "Failed to fan out staff notification");
    }
  }

  /**
   * List the signed-in user's most recent notifications, newest first.
   * `limit` is hard-capped server-side regardless of what the caller
   * requests so a misbehaving client can't pull the whole inbox in
   * one request.
   */
  async listForUser(
    userId: string,
    opts: { limit?: number; unreadOnly?: boolean } = {},
  ) {
    const limit = Math.min(opts.limit ?? 30, 100);
    const rows = await this.db.notification.findMany({
      where: {
        userId,
        ...(opts.unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        href: true,
        readAt: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Unread count for the bell-icon badge. */
  async unreadCount(userId: string): Promise<number> {
    return this.db.notification.count({
      where: { userId, readAt: null },
    });
  }

  /**
   * Mark a single notification as read. Idempotent — calling twice on
   * an already-read row is a no-op. Ownership is enforced server-side:
   * the where-clause requires both id AND userId, so a user can never
   * mark someone else's notification.
   */
  async markRead(userId: string, notificationId: string): Promise<void> {
    await this.db.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /** Mark every unread notification for this user as read. */
  async markAllRead(userId: string): Promise<{ count: number }> {
    const result = await this.db.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { count: result.count };
  }
}
