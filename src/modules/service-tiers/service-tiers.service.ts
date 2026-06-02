import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import { Prisma, type ServiceTier } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import {
  CreateServiceTierDto,
  UpdateServiceTierDto,
} from "./dto/service-tiers.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * Seed used on first boot — exactly mirrors the hardcoded tiers that
 * previously lived in `nimi-web/src/app/(marketing)/{catering,events}/page.tsx`.
 * Lets the operator open `/admin/tiers` on day one and find the
 * existing six tiers ready to edit, rather than an empty table they
 * have to retype from memory. We deliberately don't track which
 * rows are "seeded" vs "operator-added" — once they're in the DB
 * they're all equal first-class records.
 */
const SEED_TIERS: ReadonlyArray<{
  category: "CATERING" | "EVENTS";
  slug: string;
  eyebrow: string;
  title: string;
  description: string;
  bullets: readonly string[];
  flagship?: boolean;
  position: number;
}> = [
  // -------- Catering --------
  {
    category: "CATERING",
    slug: "buffet",
    eyebrow: "Tier 1",
    title: "Buffet Service",
    description:
      "Self-serve, relaxed — perfect for casual events and gatherings where guests serve themselves at their own pace.",
    bullets: [
      "Buffet-style catering with chafer-warmed mains",
      "Relaxed, self-serve setup and presentation",
      "Ideal for casual events and gatherings",
    ],
    position: 0,
  },
  {
    category: "CATERING",
    slug: "family-style",
    eyebrow: "Tier 2",
    title: "Family Style Service",
    description:
      "Shared platters served to each table for a warm, communal dining experience with elevated presentation.",
    bullets: [
      "Shared platters served to tables",
      "Warm, communal dining experience",
      "Slightly more elevated presentation than buffet",
    ],
    position: 10,
  },
  {
    category: "CATERING",
    slug: "plated",
    eyebrow: "Tier 3",
    title: "Plated Service",
    description:
      "Fully plated meals delivered to each guest — a formal dining experience with full service staff and considered presentation.",
    bullets: [
      "Fully plated meals to every guest",
      "Formal dining experience",
      "Full service staff and presentation",
    ],
    flagship: true,
    position: 20,
  },

  // -------- Events --------
  {
    category: "EVENTS",
    slug: "coordination",
    eyebrow: "Tier 1",
    title: "Event Coordination",
    description:
      "On-the-day coordination — we hold the timeline and the suppliers, and quietly solve the small things so you don't have to.",
    bullets: [
      "On-the-day coordination only",
      "Timeline management",
      "Supplier coordination",
      "Problem solving during the event",
    ],
    position: 0,
  },
  {
    category: "EVENTS",
    slug: "design",
    eyebrow: "Tier 2",
    title: "Event Design & Coordination",
    description:
      "Everything in Tier 1, plus styling direction — florals, signage, layout, and lighting designed to your vision and made coherent.",
    bullets: [
      "Everything in Tier 1",
      "Styling direction",
      "Floral concepts",
      "Signage and layout guidance",
      "Lighting and aesthetic design input",
    ],
    position: 10,
  },
  {
    category: "EVENTS",
    slug: "production",
    eyebrow: "Tier 3",
    title: "Full Event Production",
    description:
      "End-to-end planning. From concept to last guest, we source, style, and run every moving part of the day.",
    bullets: [
      "Full end-to-end planning",
      "Concept creation",
      "Supplier sourcing and management",
      "Styling + execution",
      "Full day management",
    ],
    flagship: true,
    position: 20,
  },
];

/**
 * Admin CRUD plus public read for `ServiceTier`. Same shape as the
 * other admin-managed catalogue services (`GiftingService`,
 * `PastriesService`).
 *
 * Public read returns only active tiers ordered by position; admin
 * read returns everything for management. Both views are cheap
 * (handful of rows per category) so no caching is needed beyond the
 * Next.js fetch cache on the web side.
 */
@Injectable()
export class ServiceTiersService implements OnModuleInit {
  private readonly logger = new Logger(ServiceTiersService.name);

  constructor(private readonly db: PrismaService) {}

  /**
   * First-boot seed. Runs once at module init: if the table is
   * empty, the hardcoded `SEED_TIERS` set is inserted so the admin
   * lands on a populated `/admin/tiers` page instead of having to
   * recreate the existing six tiers from memory. After the first
   * boot the table is non-empty and this is a no-op.
   *
   * We seed only when zero rows exist — this is intentionally
   * conservative. If the operator deletes every row themselves, the
   * next deploy would re-seed; if that surprises them it's still a
   * safe outcome (they can disable any unwanted tier with the
   * Active toggle). Tracking "have we seeded before" via a marker
   * row would be more correct but adds complexity for an unlikely
   * edge case.
   */
  async onModuleInit(): Promise<void> {
    try {
      const count = await this.db.serviceTier.count();
      if (count > 0) return;

      this.logger.log(`Seeding ${SEED_TIERS.length} service tiers (first-time bootstrap)`);
      await this.db.serviceTier.createMany({
        data: SEED_TIERS.map((t) => ({
          category: t.category,
          slug: t.slug,
          eyebrow: t.eyebrow,
          title: t.title,
          description: t.description,
          bullets: t.bullets as unknown as Prisma.InputJsonValue,
          flagship: t.flagship ?? false,
          position: t.position,
          active: true,
          updatedBy: "system",
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      // Non-fatal — admin can add manually if seeding fails for any reason.
      this.logger.error({ err }, "Service-tier seed failed");
    }
  }

  // ---------- public ----------

  async listPublic(category: string): Promise<ServiceTier[]> {
    return this.db.serviceTier.findMany({
      where: { category, active: true },
      orderBy: [{ position: "asc" }, { title: "asc" }],
    });
  }

  // ---------- admin ----------

  async adminListAll(): Promise<ServiceTier[]> {
    return this.db.serviceTier.findMany({
      orderBy: [{ category: "asc" }, { position: "asc" }, { title: "asc" }],
    });
  }

  async adminGet(id: string): Promise<ServiceTier> {
    const row = await this.db.serviceTier.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  async create(
    dto: CreateServiceTierDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<ServiceTier> {
    try {
      const row = await this.db.serviceTier.create({
        data: {
          category: dto.category,
          slug: dto.slug,
          eyebrow: dto.eyebrow,
          title: dto.title,
          description: dto.description,
          bullets: dto.bullets as Prisma.InputJsonValue,
          imageUrl: dto.imageUrl ?? null,
          flagship: dto.flagship ?? false,
          position: dto.position ?? 0,
          active: dto.active ?? true,
          updatedBy: actorId,
        },
      });
      await this.audit("service_tier.create", row.id, actorId, meta, {
        after: { category: row.category, slug: row.slug, title: row.title },
      });
      return row;
    } catch (err) {
      throw this.mapPrismaError(err, "Couldn't create tier.");
    }
  }

  async update(
    id: string,
    dto: UpdateServiceTierDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<ServiceTier> {
    const before = await this.db.serviceTier.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    const data: Prisma.ServiceTierUpdateInput = { updatedBy: actorId };
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.eyebrow !== undefined) data.eyebrow = dto.eyebrow;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.bullets !== undefined) {
      data.bullets = dto.bullets as Prisma.InputJsonValue;
    }
    if (dto.imageUrl !== undefined) {
      // Tri-state: undefined = don't touch; null = clear; string = set.
      data.imageUrl = dto.imageUrl === null ? null : dto.imageUrl;
    }
    if (dto.flagship !== undefined) data.flagship = dto.flagship;
    if (dto.position !== undefined) data.position = dto.position;
    if (dto.active !== undefined) data.active = dto.active;

    try {
      const row = await this.db.serviceTier.update({ where: { id }, data });
      await this.audit("service_tier.update", id, actorId, meta, {
        changedKeys: Object.keys(dto),
      });
      return row;
    } catch (err) {
      throw this.mapPrismaError(err, "Couldn't update tier.");
    }
  }

  async remove(
    id: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const before = await this.db.serviceTier.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    await this.db.serviceTier.delete({ where: { id } });
    await this.audit("service_tier.delete", id, actorId, meta, {
      before: { slug: before.slug, category: before.category },
    });
    return { ok: true };
  }

  // ---------- helpers ----------

  private mapPrismaError(err: unknown, fallback: string): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        return new BadRequestException(
          "That slug is already used in this category. Pick a different one.",
        );
      }
      if (err.code === "P2025") {
        return new NotFoundException();
      }
    }
    this.logger.error({ err }, fallback);
    return new BadRequestException(fallback);
  }

  private async audit(
    action: string,
    entityId: string,
    actorId: string,
    meta: RequestMeta,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          action,
          entity: "ServiceTier",
          entityId,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          after: details as object,
        },
      });
    } catch (err) {
      this.logger.warn({ err, entityId, action }, "Audit write failed");
    }
  }
}
