import { Controller, Get, UseGuards } from "@nestjs/common";

import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PrismaService } from "../prisma/prisma.service";

interface Kpi {
  label: string;
  value: number;
  /** Pre-formatted display string (e.g. "£1,234") if applicable. */
  display?: string;
  /** Group of related KPIs ("operations", "commerce", "growth"). */
  group: "operations" | "commerce" | "growth";
}

const ONE_DAY = 24 * 60 * 60 * 1000;

/**
 * KPIs for the admin dashboard. Read-only, role-gated.
 * Each query is bounded and indexed; the whole endpoint should return in <300ms.
 */
@Controller({ path: "admin/kpis", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR", "SUPPORT")
export class KpisController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  async snapshot(): Promise<{ kpis: Kpi[]; generatedAt: string }> {
    const now = Date.now();
    const weekAgo = new Date(now - 7 * ONE_DAY);
    const monthAgo = new Date(now - 30 * ONE_DAY);

    const [
      enquiriesThisWeek,
      newEnquiries,
      cateringEnquiriesThisWeek,
      eventsEnquiriesThisWeek,
      giftOrdersThisMonth,
      giftRevenueThisMonth,
      activeSubs,
      pausedSubs,
      newSignupsThisWeek,
      newsletterConfirmedThisWeek,
      totalCreditLiability,
      blogPostsPublished,
    ] = await Promise.all([
      this.db.contactEnquiry.count({ where: { createdAt: { gte: weekAgo } } }),
      this.db.contactEnquiry.count({ where: { status: "NEW" } }),
      this.db.contactEnquiry.count({
        where: { kind: "CATERING", createdAt: { gte: weekAgo } },
      }),
      this.db.contactEnquiry.count({
        where: { kind: "EVENTS", createdAt: { gte: weekAgo } },
      }),
      this.db.giftOrder.count({
        where: {
          createdAt: { gte: monthAgo },
          status: { notIn: ["PENDING_PAYMENT", "CANCELLED"] },
        },
      }),
      this.db.giftOrder.aggregate({
        _sum: { totalMinor: true },
        where: {
          createdAt: { gte: monthAgo },
          status: { notIn: ["PENDING_PAYMENT", "CANCELLED"] },
        },
      }),
      this.db.subscription.count({ where: { status: "ACTIVE" } }),
      this.db.subscription.count({ where: { status: "PAUSED" } }),
      this.db.user.count({ where: { createdAt: { gte: weekAgo } } }),
      this.db.newsletterSubscriber.count({
        where: { status: "CONFIRMED", createdAt: { gte: weekAgo } },
      }),
      this.db.creditTransaction.aggregate({ _sum: { amountMinor: true } }),
      this.db.blogPost.count({ where: { status: "PUBLISHED" } }),
    ]);

    const giftRevenue = giftRevenueThisMonth._sum.totalMinor ?? 0;
    const credit = totalCreditLiability._sum.amountMinor ?? 0;
    const mrrMinor = await this.computeMrrMinor();

    const kpis: Kpi[] = [
      { group: "operations", label: "Enquiries this week", value: enquiriesThisWeek },
      { group: "operations", label: "New (unread) enquiries", value: newEnquiries },
      { group: "operations", label: "Catering enquiries (7d)", value: cateringEnquiriesThisWeek },
      { group: "operations", label: "Event consultations (7d)", value: eventsEnquiriesThisWeek },

      { group: "commerce", label: "Gift orders (30d)", value: giftOrdersThisMonth },
      {
        group: "commerce",
        label: "Gift revenue (30d)",
        value: giftRevenue,
        display: formatGbp(giftRevenue),
      },
      { group: "commerce", label: "Active Cravings subscribers", value: activeSubs },
      { group: "commerce", label: "Paused Cravings", value: pausedSubs },
      {
        group: "commerce",
        label: "Cravings MRR",
        value: mrrMinor,
        display: formatGbp(mrrMinor),
      },
      {
        group: "commerce",
        label: "Outstanding credit liability",
        value: credit,
        display: formatGbp(credit),
      },

      { group: "growth", label: "New customers (7d)", value: newSignupsThisWeek },
      { group: "growth", label: "Newsletter confirmed (7d)", value: newsletterConfirmedThisWeek },
      { group: "growth", label: "Published journal posts", value: blogPostsPublished },
    ];

    return { kpis, generatedAt: new Date().toISOString() };
  }

  private async computeMrrMinor(): Promise<number> {
    const result = await this.db.subscription.aggregate({
      _sum: { monthlyAmountMinor: true },
      where: { status: "ACTIVE" },
    });
    return result._sum.monthlyAmountMinor ?? 0;
  }
}

function formatGbp(minor: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(minor / 100);
}
