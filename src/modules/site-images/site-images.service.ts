import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { type SiteImage } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import { type PublicSiteImageDto, type UpsertSiteImageDto } from "./dto/site-images.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * SiteImagesService — admin CRUD + public read for the
 * `SiteImage` overlay table.
 *
 * Read path used by both the public marketing site and the admin
 * surface. The marketing site reads ALL rows in one round trip per
 * render — there are only ~25 keys and the table never holds more
 * than that, so a single `findMany` is cheaper than per-key
 * lookups.
 *
 * Audit trail is written through the existing `AuditLog` model so
 * any image swap is traceable: who, when, which key, before/after
 * URL. We don't try to keep an old-revisions table; the previous
 * URL is preserved in the audit row's `before` payload and that's
 * enough for "undo accidentally swapped" use cases.
 */
@Injectable()
export class SiteImagesService {
  private readonly logger = new Logger(SiteImagesService.name);

  constructor(private readonly db: PrismaService) {}

  /**
   * Return every override in the table. Order doesn't matter for
   * the consuming clients (web does its own keyed lookup), so we
   * keep the query as cheap as possible — no filter, no orderBy.
   */
  async listAll(): Promise<SiteImage[]> {
    return this.db.siteImage.findMany();
  }

  /**
   * Same as `listAll` but reshaped to the public DTO so the
   * controller can dump it straight through without leaking
   * timestamps or actor IDs to anonymous clients. Used for the
   * cacheable public read.
   */
  async listPublic(): Promise<PublicSiteImageDto[]> {
    const rows = await this.listAll();
    return rows.map((r) => ({ key: r.key, url: r.url, alt: r.alt }));
  }

  /**
   * Look up a single override by key. Returns null when there's no
   * row — every caller already has a fallback URL ready, so 404 is
   * not appropriate here.
   */
  async getByKey(key: string): Promise<SiteImage | null> {
    return this.db.siteImage.findUnique({ where: { key } });
  }

  /**
   * Insert-or-update by key. We deliberately don't validate that
   * the key is in the web's registry — the registry lives in
   * `nimi-web` and changes with every deploy; making the API
   * enforce it would couple the two repos in a way the operator
   * doesn't want. Garbage keys are inert anyway: the public site
   * only looks up keys it knows about, so an orphan row in the
   * table does nothing.
   */
  async upsert(
    key: string,
    dto: UpsertSiteImageDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<SiteImage> {
    const before = await this.getByKey(key);

    const row = await this.db.siteImage.upsert({
      where: { key },
      create: {
        key,
        url: dto.url,
        alt: dto.alt ?? null,
        updatedBy: actorId,
      },
      update: {
        url: dto.url,
        alt: dto.alt === undefined ? before?.alt ?? null : dto.alt,
        updatedBy: actorId,
      },
    });

    await this.audit("site_image.upsert", key, actorId, meta, {
      before: before
        ? { url: before.url, alt: before.alt }
        : null,
      after: { url: row.url, alt: row.alt },
    });

    return row;
  }

  /**
   * Remove an override → public site falls back to the code-level
   * default. Returns 404 if the key has no override (so an admin
   * accidentally clicking "Reset to default" twice gets a clear
   * "nothing to do here" signal).
   */
  async remove(key: string, actorId: string, meta: RequestMeta): Promise<{ ok: true }> {
    const before = await this.getByKey(key);
    if (!before) throw new NotFoundException();

    await this.db.siteImage.delete({ where: { key } });

    await this.audit("site_image.delete", key, actorId, meta, {
      before: { url: before.url, alt: before.alt },
    });

    return { ok: true };
  }

  /**
   * Append an audit row. Best-effort — we never let an audit
   * write failure block a successful image change.
   */
  private async audit(
    action: string,
    key: string,
    actorId: string,
    meta: RequestMeta,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          action,
          entity: "SiteImage",
          entityId: key,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          after: details as object,
        },
      });
    } catch (err) {
      this.logger.warn({ err, key, action }, "Audit write failed for SiteImage");
    }
  }
}
