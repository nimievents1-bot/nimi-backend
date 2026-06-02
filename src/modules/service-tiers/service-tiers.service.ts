import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
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
export class ServiceTiersService {
  private readonly logger = new Logger(ServiceTiersService.name);

  constructor(private readonly db: PrismaService) {}

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
