import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import { type PastryItem, Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import {
  type CreatePastryDto,
  type UpdatePastryDto,
} from "./dto/pastries.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * One-shot seed list. Used by `onModuleInit` only when the table is empty
 * — not a recurring sync, so editing or deleting these in admin sticks.
 *
 * Prices are placeholders the founder is expected to overwrite with the
 * real menu cost. They're set high enough that nothing under £25 (the
 * club minimum) is forced as a single-unit purchase.
 */
const SEED_PASTRIES: ReadonlyArray<{
  slug: string;
  name: string;
  description: string;
  priceMinor: number;
  tags: string[];
  imageKey: string;
}> = [
  { slug: "meat-pie", name: "Meat Pie", description: "Buttery shortcrust, peppered beef.", priceMinor: 500, tags: ["savoury", "beef"], imageKey: "meatPie" },
  { slug: "chicken-pie", name: "Chicken Pie", description: "Soft pastry, herbed chicken.", priceMinor: 500, tags: ["savoury", "chicken"], imageKey: "chickenPie" },
  { slug: "egg-roll", name: "Egg Rolls", description: "Boiled egg, sausage-style dough.", priceMinor: 400, tags: ["savoury", "egg"], imageKey: "eggRoll" },
  { slug: "fish-pie", name: "Fish Pie", description: "Smoked fish, scotch-bonnet warmth.", priceMinor: 550, tags: ["savoury", "fish", "spicy"], imageKey: "fishPie" },
  { slug: "puff-puff", name: "Puff Puff", description: "Pillowy fried dough, glossy with sugar.", priceMinor: 350, tags: ["sweet"], imageKey: "puffPuff" },
  { slug: "zobo", name: "Zobo", description: "Hibiscus, ginger, citrus — chilled.", priceMinor: 400, tags: ["drink", "vegan"], imageKey: "zobo" },
  { slug: "chicken-shawarma", name: "Chicken Shawarma", description: "Spiced chicken, garlic sauce, pickles.", priceMinor: 1200, tags: ["savoury", "chicken"], imageKey: "chickenShawarma" },
  { slug: "asun-shawarma", name: "Asun Shawarma", description: "Smoked goat asun, peppered hot.", priceMinor: 1400, tags: ["savoury", "goat", "spicy", "limited"], imageKey: "asunShawarma" },
  { slug: "combo-shawarma", name: "Combo Shawarma", description: "Asun and chicken in one wrap.", priceMinor: 1500, tags: ["savoury", "chicken", "goat", "spicy"], imageKey: "comboShawarma" },
];

interface PublicPastry {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  imageUrl: string | null;
  imageAlt: string | null;
  tags: string[];
  leadTimeDays: number;
  /** Per-item minimum order quantity (1 = no minimum). */
  minQuantity: number;
  /** Daily kitchen cap (null = no cap). Display-only on the public menu. */
  batchLimit: number | null;
}

/**
 * PastriesService — public read of the available menu + admin CRUD.
 *
 * Tags are stored as a JSON array in Postgres (Prisma `Json`). We accept
 * `string[]` from DTOs and pass through to Prisma; reading back, we coerce
 * defensively because legacy rows could in theory hold any JSON shape.
 *
 * Slug uniqueness is enforced by the schema (`@unique`) — Prisma's P2002
 * is mapped to a 409 ConflictException so the admin form can surface a
 * useful error.
 */
@Injectable()
export class PastriesService implements OnModuleInit {
  private readonly logger = new Logger(PastriesService.name);

  constructor(private readonly db: PrismaService) {}

  /**
   * Idempotent seed: on first boot (when the table is empty) populate the
   * nine known pastries from the brand brief so admin doesn't start with
   * a blank menu. Subsequent boots skip — the founder's edits stick.
   *
   * We tolerate failure here (logged, not thrown) because the API must
   * boot even if the seed fails (e.g. transient DB unavailability during
   * cold start).
   */
  async onModuleInit(): Promise<void> {
    try {
      const count = await this.db.pastryItem.count();
      if (count > 0) return;

      this.logger.log(`Seeding ${SEED_PASTRIES.length} pastries (first-time bootstrap)`);
      await this.db.pastryItem.createMany({
        data: SEED_PASTRIES.map((p, idx) => ({
          slug: p.slug,
          name: p.name,
          description: p.description,
          priceMinor: p.priceMinor,
          currency: "gbp",
          imageUrl: null,
          imageAlt: `${p.name} — placeholder, replace with real product photography`,
          tags: p.tags as Prisma.InputJsonValue,
          batchLimit: null,
          leadTimeDays: 0,
          displayOrder: idx,
          available: false, // founder must explicitly publish each item
          createdBy: "system",
          updatedBy: "system",
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      this.logger.error({ err }, "Pastry seed failed (non-fatal — admin can add manually)");
    }
  }

  // ---------- public ----------

  async listAvailable(opts: { limit?: number; offset?: number } = {}): Promise<{
    rows: PublicPastry[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(opts.limit ?? 50, 100);
    const offset = opts.offset ?? 0;

    const where: Prisma.PastryItemWhereInput = { available: true };

    const [rows, total] = await this.db.$transaction([
      this.db.pastryItem.findMany({
        where,
        orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
        take: limit,
        skip: offset,
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          priceMinor: true,
          currency: true,
          imageUrl: true,
          imageAlt: true,
          tags: true,
          leadTimeDays: true,
          // Per-item rules surfaced to the public menu so the cravings
          // page can render hints ("Minimum 6 per order") before the
          // customer adds to cart. Enforcement still happens server-side
          // in the cart and checkout — these are display-only here.
          minQuantity: true,
          batchLimit: true,
        },
      }),
      this.db.pastryItem.count({ where }),
    ]);

    return {
      rows: rows.map((r) => ({
        ...r,
        tags: coerceTags(r.tags),
      })),
      total,
      limit,
      offset,
    };
  }

  async getPublicBySlug(slug: string): Promise<PublicPastry> {
    const row = await this.db.pastryItem.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        priceMinor: true,
        currency: true,
        imageUrl: true,
        imageAlt: true,
        tags: true,
        leadTimeDays: true,
        minQuantity: true,
        batchLimit: true,
        available: true,
      },
    });
    if (!row || !row.available) throw new NotFoundException();
    return { ...row, tags: coerceTags(row.tags) };
  }

  // ---------- admin ----------

  async adminList(opts: {
    limit?: number;
    offset?: number;
    available?: boolean;
    q?: string;
  }): Promise<{ rows: PastryItem[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const where: Prisma.PastryItemWhereInput = {};
    if (opts.available !== undefined) where.available = opts.available;
    if (opts.q) {
      const term = opts.q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { slug: { contains: term, mode: "insensitive" } },
        { description: { contains: term, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await this.db.$transaction([
      this.db.pastryItem.findMany({
        where,
        orderBy: [{ displayOrder: "asc" }, { updatedAt: "desc" }],
        take: limit,
        skip: offset,
      }),
      this.db.pastryItem.count({ where }),
    ]);

    return { rows, total, limit, offset };
  }

  async adminGet(id: string): Promise<PastryItem> {
    const row = await this.db.pastryItem.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  async create(
    dto: CreatePastryDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<PastryItem> {
    try {
      const row = await this.db.pastryItem.create({
        data: {
          slug: dto.slug,
          name: dto.name,
          description: dto.description ?? null,
          priceMinor: dto.priceMinor,
          currency: dto.currency ?? "gbp",
          imageUrl: dto.imageUrl ?? null,
          imageAlt: dto.imageAlt ?? null,
          tags: (dto.tags ?? []) as Prisma.InputJsonValue,
          // `??` already maps both `undefined` (field missing) AND
          // `null` (operator submitted blank) to `null`, which is
          // the "no cap" sentinel — so this branch needs no change
          // for the tri-state fix; recording the equivalence here so
          // future readers don't try to "harden" it the way the
          // update path needed.
          batchLimit: dto.batchLimit ?? null,
          // `?? 1` mirrors the schema default — a missing/zero value
          // means "no minimum", and accepting it here keeps the admin
          // form simple (leaving the field blank works as expected
          // without forcing the operator to type "1" everywhere).
          minQuantity: dto.minQuantity && dto.minQuantity > 0 ? dto.minQuantity : 1,
          leadTimeDays: dto.leadTimeDays ?? 0,
          displayOrder: dto.displayOrder ?? 0,
          available: dto.available ?? false,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
      await this.audit("pastry.create", row.id, actorId, meta, { slug: row.slug });
      return row;
    } catch (err) {
      throw this.mapPrismaError(err, "Couldn't create pastry.");
    }
  }

  async update(
    id: string,
    dto: UpdatePastryDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<PastryItem> {
    const before = await this.db.pastryItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    const data: Prisma.PastryItemUpdateInput = { updatedBy: actorId };
    if (dto.slug !== undefined) data.slug = dto.slug;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.priceMinor !== undefined) data.priceMinor = dto.priceMinor;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl;
    if (dto.imageAlt !== undefined) data.imageAlt = dto.imageAlt;
    if (dto.tags !== undefined) data.tags = dto.tags as Prisma.InputJsonValue;
    // Tri-state semantics:
    //   - undefined → field absent from payload → leave untouched
    //   - null      → operator explicitly cleared the input → wipe the cap
    //   - integer   → operator set a new cap
    // Without the explicit `null` branch the previous code couldn't
    // distinguish "blank" from "missing" — every blank submission
    // looked like "don't change" and the prior cap stayed in place,
    // which was the regression operators kept hitting on the admin
    // editor.
    if (dto.batchLimit !== undefined) {
      data.batchLimit = dto.batchLimit === null ? null : dto.batchLimit;
    }
    // Same blank-or-zero handling as on create. The DTO already
    // enforces Min(1)/Max(999) at validation time, so we just need
    // to coerce a missing value to "no minimum" rather than nullify.
    if (dto.minQuantity !== undefined) {
      data.minQuantity = dto.minQuantity && dto.minQuantity > 0 ? dto.minQuantity : 1;
    }
    if (dto.leadTimeDays !== undefined) data.leadTimeDays = dto.leadTimeDays;
    if (dto.displayOrder !== undefined) data.displayOrder = dto.displayOrder;
    if (dto.available !== undefined) data.available = dto.available;

    try {
      const row = await this.db.pastryItem.update({ where: { id }, data });
      await this.audit("pastry.update", id, actorId, meta, {
        changedKeys: Object.keys(dto),
      });
      return row;
    } catch (err) {
      throw this.mapPrismaError(err, "Couldn't update pastry.");
    }
  }

  async delete(id: string, actorId: string, meta: RequestMeta): Promise<{ ok: true }> {
    const before = await this.db.pastryItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    // Soft-delete by toggling `available` would be safer for historical
    // orders, but we already snapshot items into PastryOrderItem on order
    // creation (Phase B), so a true delete here doesn't corrupt history.
    await this.db.pastryItem.delete({ where: { id } });
    await this.audit("pastry.delete", id, actorId, meta, { slug: before.slug });
    return { ok: true };
  }

  // ---------- helpers ----------

  private async audit(
    action: string,
    entityId: string,
    actorId: string,
    meta: RequestMeta,
    after?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          action,
          entity: "PastryItem",
          entityId,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          after: (after ?? undefined) as never,
        },
      });
    } catch (err) {
      this.logger.error({ err, action }, "Failed to write pastry audit log");
    }
  }

  /**
   * Convert Prisma's known error codes into HTTP exceptions with helpful
   * detail. P2002 = unique constraint violation, almost always the slug.
   */
  private mapPrismaError(err: unknown, fallback: string): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return new ConflictException("A pastry with this slug already exists.");
    }
    this.logger.error({ err }, fallback);
    return err instanceof Error ? err : new Error(fallback);
  }
}

/**
 * Tags column is `Json` in Prisma. Defensive coerce so admin UI never
 * crashes if an old row holds a non-array value (which shouldn't happen
 * but the cost of guarding is one if-check).
 */
function coerceTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
