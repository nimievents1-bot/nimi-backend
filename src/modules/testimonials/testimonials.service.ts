import {
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type Testimonial } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import {
  type CreateTestimonialDto,
  type UpdateTestimonialDto,
} from "./dto/testimonials.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

interface PublicTestimonial {
  id: string;
  authorName: string;
  role: string | null;
  body: string;
  rating: number | null;
  eventType: string | null;
}

/**
 * TestimonialsService — public reads + admin CRUD for customer reviews.
 *
 * Display order: rows are sorted by `displayOrder` ascending then `createdAt`
 * descending, so a hand-curated lead testimonial wins the top slot, with
 * unsorted (displayOrder=0) rows falling back to recency.
 *
 * Audit: every mutation writes a row to the AuditLog so admin actions are
 * traceable end-to-end. We swallow audit-write failures to keep the user
 * action successful even if logging breaks (rare, but it's happened).
 */
@Injectable()
export class TestimonialsService {
  private readonly logger = new Logger(TestimonialsService.name);

  constructor(private readonly db: PrismaService) {}

  // ---------- public ----------

  async listPublished(opts: { limit?: number; offset?: number } = {}): Promise<{
    rows: PublicTestimonial[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(opts.limit ?? 12, 50);
    const offset = opts.offset ?? 0;

    const where: Prisma.TestimonialWhereInput = { isPublished: true };

    const [rows, total] = await this.db.$transaction([
      this.db.testimonial.findMany({
        where,
        orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
        take: limit,
        skip: offset,
        select: {
          id: true,
          authorName: true,
          role: true,
          body: true,
          rating: true,
          eventType: true,
        },
      }),
      this.db.testimonial.count({ where }),
    ]);

    return { rows, total, limit, offset };
  }

  // ---------- admin ----------

  async adminList(opts: {
    limit?: number;
    offset?: number;
    isPublished?: boolean;
    q?: string;
  }): Promise<{ rows: Testimonial[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const where: Prisma.TestimonialWhereInput = {};
    if (opts.isPublished !== undefined) where.isPublished = opts.isPublished;
    if (opts.q) {
      const term = opts.q.trim();
      where.OR = [
        { authorName: { contains: term, mode: "insensitive" } },
        { body: { contains: term, mode: "insensitive" } },
        { role: { contains: term, mode: "insensitive" } },
        { eventType: { contains: term, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await this.db.$transaction([
      this.db.testimonial.findMany({
        where,
        orderBy: [{ displayOrder: "asc" }, { updatedAt: "desc" }],
        take: limit,
        skip: offset,
      }),
      this.db.testimonial.count({ where }),
    ]);

    return { rows, total, limit, offset };
  }

  async adminGet(id: string): Promise<Testimonial> {
    const row = await this.db.testimonial.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  async create(
    dto: CreateTestimonialDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<Testimonial> {
    const row = await this.db.testimonial.create({
      data: {
        authorName: dto.authorName,
        role: dto.role ?? null,
        body: dto.body,
        rating: dto.rating ?? null,
        eventType: dto.eventType ?? null,
        isPublished: dto.isPublished ?? false,
        displayOrder: dto.displayOrder ?? 0,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
    await this.audit("testimonial.create", row.id, actorId, meta, {
      authorName: row.authorName,
    });
    return row;
  }

  async update(
    id: string,
    dto: UpdateTestimonialDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<Testimonial> {
    const before = await this.db.testimonial.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    const data: Prisma.TestimonialUpdateInput = { updatedBy: actorId };
    if (dto.authorName !== undefined) data.authorName = dto.authorName;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.body !== undefined) data.body = dto.body;
    if (dto.rating !== undefined) data.rating = dto.rating;
    if (dto.eventType !== undefined) data.eventType = dto.eventType;
    if (dto.isPublished !== undefined) data.isPublished = dto.isPublished;
    if (dto.displayOrder !== undefined) data.displayOrder = dto.displayOrder;

    const row = await this.db.testimonial.update({ where: { id }, data });
    await this.audit("testimonial.update", id, actorId, meta, {
      changedKeys: Object.keys(dto),
    });
    return row;
  }

  async delete(id: string, actorId: string, meta: RequestMeta): Promise<{ ok: true }> {
    const before = await this.db.testimonial.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    await this.db.testimonial.delete({ where: { id } });
    await this.audit("testimonial.delete", id, actorId, meta, {
      authorName: before.authorName,
    });
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
          entity: "Testimonial",
          entityId,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          after: (after ?? undefined) as never,
        },
      });
    } catch (err) {
      this.logger.error({ err, action }, "Failed to write testimonial audit log");
    }
  }
}
