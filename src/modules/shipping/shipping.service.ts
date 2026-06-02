import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type ShippingZone } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import {
  CreateShippingZoneDto,
  UpdateShippingZoneDto,
} from "./dto/shipping.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * Public-facing shape returned by `resolveFee`. The cart service
 * surfaces this directly in the view so the customer sees the
 * resolved zone name, fee, and whether free-over kicked in.
 */
export interface ResolvedShipping {
  zoneId: string;
  zoneName: string;
  feeMinor: number;
  /** True when the free-over threshold applied and `feeMinor` is 0. */
  freeOverApplied: boolean;
}

/**
 * ShippingService — admin CRUD plus the customer-facing fee
 * resolver. The resolver is the part that gets called on every
 * cart render, so it stays tight: single query for the active
 * zones (limited to 200 by DTO), then in-memory prefix walk.
 *
 * Why we don't try to cache the active-zone list aggressively:
 *   The admin will sometimes flip a zone toggle (regional promo
 *   on/off). A 60-second cache would leave customers seeing the
 *   wrong price for up to a minute. The query is cheap (few rows,
 *   indexed on `active, position`) so we keep it live.
 */
@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  constructor(private readonly db: PrismaService) {}

  // ---------- admin CRUD ----------

  async listAll(): Promise<ShippingZone[]> {
    return this.db.shippingZone.findMany({
      orderBy: [{ position: "asc" }, { name: "asc" }],
    });
  }

  async getById(id: string): Promise<ShippingZone> {
    const row = await this.db.shippingZone.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  async create(
    dto: CreateShippingZoneDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<ShippingZone> {
    try {
      const row = await this.db.shippingZone.create({
        data: {
          name: dto.name,
          description: dto.description ?? null,
          postcodePrefixes: this.normalisePrefixes(
            dto.postcodePrefixes,
          ) as Prisma.InputJsonValue,
          feeMinor: dto.feeMinor,
          freeOverEnabled: dto.freeOverEnabled ?? false,
          freeOverMinor: dto.freeOverMinor ?? null,
          active: dto.active ?? true,
          position: dto.position ?? 0,
          updatedBy: actorId,
        },
      });
      await this.audit("shipping_zone.create", row.id, actorId, meta, {
        after: { name: row.name, feeMinor: row.feeMinor },
      });
      return row;
    } catch (err) {
      this.logger.error({ err }, "Failed to create shipping zone");
      throw new BadRequestException("Couldn't create shipping zone.");
    }
  }

  async update(
    id: string,
    dto: UpdateShippingZoneDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<ShippingZone> {
    const before = await this.db.shippingZone.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    const data: Prisma.ShippingZoneUpdateInput = { updatedBy: actorId };
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.postcodePrefixes !== undefined) {
      data.postcodePrefixes = this.normalisePrefixes(
        dto.postcodePrefixes,
      ) as Prisma.InputJsonValue;
    }
    if (dto.feeMinor !== undefined) data.feeMinor = dto.feeMinor;
    if (dto.freeOverEnabled !== undefined) data.freeOverEnabled = dto.freeOverEnabled;
    if (dto.freeOverMinor !== undefined) {
      data.freeOverMinor = dto.freeOverMinor === null ? null : dto.freeOverMinor;
    }
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.position !== undefined) data.position = dto.position;

    const row = await this.db.shippingZone.update({ where: { id }, data });
    await this.audit("shipping_zone.update", id, actorId, meta, {
      changedKeys: Object.keys(dto),
    });
    return row;
  }

  async remove(
    id: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const before = await this.db.shippingZone.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    await this.db.shippingZone.delete({ where: { id } });
    await this.audit("shipping_zone.delete", id, actorId, meta, {
      before: { name: before.name },
    });
    return { ok: true };
  }

  // ---------- public resolve ----------

  /**
   * Look up the active zone for a given UK postcode and compute the
   * fee against a known order subtotal.
   *
   * Postcode handling: we uppercase, strip whitespace, then walk
   * the active zones in `position` order. The first zone whose
   * `postcodePrefixes` includes a prefix that matches the start of
   * the normalised postcode wins. Catch-all zones (empty prefix
   * array) match every postcode and are checked LAST — they're the
   * fallback when no specific zone matches.
   *
   * Returns `null` when no active zone matches (caller should
   * surface "we don't ship there yet" rather than charge a stale
   * default).
   */
  async resolveFee(
    postcode: string,
    subtotalMinor: number,
  ): Promise<ResolvedShipping | null> {
    const normalised = this.normalisePostcode(postcode);
    if (!normalised) return null;

    const zones = await this.db.shippingZone.findMany({
      where: { active: true },
      orderBy: [{ position: "asc" }, { name: "asc" }],
    });

    // First pass: try specific-prefix matches.
    for (const zone of zones) {
      const prefixes = this.coercePrefixes(zone.postcodePrefixes);
      if (prefixes.length === 0) continue;
      if (prefixes.some((p) => normalised.startsWith(p))) {
        return this.applyFreeOver(zone, subtotalMinor);
      }
    }

    // Second pass: catch-all (empty prefix list).
    for (const zone of zones) {
      const prefixes = this.coercePrefixes(zone.postcodePrefixes);
      if (prefixes.length === 0) {
        return this.applyFreeOver(zone, subtotalMinor);
      }
    }

    return null;
  }

  // ---------- helpers ----------

  /**
   * Apply the zone's `freeOverEnabled` / `freeOverMinor` rule. When
   * the rule triggers, the resolved fee drops to 0 and we tag the
   * result so the UI can render "Free over £X" instead of the
   * silent absence of a charge.
   */
  private applyFreeOver(
    zone: ShippingZone,
    subtotalMinor: number,
  ): ResolvedShipping {
    if (
      zone.freeOverEnabled &&
      typeof zone.freeOverMinor === "number" &&
      subtotalMinor >= zone.freeOverMinor
    ) {
      return {
        zoneId: zone.id,
        zoneName: zone.name,
        feeMinor: 0,
        freeOverApplied: true,
      };
    }
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      feeMinor: zone.feeMinor,
      freeOverApplied: false,
    };
  }

  private normalisePostcode(input: string): string {
    return (input ?? "").toUpperCase().replace(/\s+/g, "");
  }

  /** Stored as JSON; defensively coerce to a clean string array on read. */
  private coercePrefixes(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v): v is string => typeof v === "string")
      .map((p) => p.toUpperCase().trim())
      .filter(Boolean);
  }

  /** Strip/uppercase incoming prefixes from the admin form. */
  private normalisePrefixes(input: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input ?? []) {
      const clean = String(raw ?? "").toUpperCase().trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
    return out;
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
          entity: "ShippingZone",
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
