import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { type ContentBlock } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import { type AllowedPage, BlockPayload } from "./blocks";
import { type UpsertContentBlockDto } from "./dto/content.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

interface PublishedSnapshot {
  type: string;
  payload: unknown;
  version: number;
  publishedAt: string;
}

/**
 * ContentService — owns the editorial lifecycle of every front-of-house
 * surface. Public reads only ever see published versions; admin writes
 * always go to a *new draft version*, leaving the previously-published
 * block untouched until the new one is published.
 *
 * Versioning model:
 *   - Each (page, key, locale) tuple is a "block".
 *   - Saving creates a new row with version = max(version) + 1, publishedAt = null.
 *   - Publishing sets publishedAt on a draft (version > current published).
 *   - Public reads pick the row with the highest version where publishedAt is set.
 */
@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(private readonly db: PrismaService) {}

  /**
   * Public read — returns the published payload for a single block,
   * or null if the page+key has no published version.
   */
  async publicRead(
    page: AllowedPage,
    key: string,
    locale = "en",
  ): Promise<PublishedSnapshot | null> {
    const row = await this.db.contentBlock.findFirst({
      where: { page, key, locale, publishedAt: { not: null } },
      orderBy: { version: "desc" },
      select: { type: true, payload: true, version: true, publishedAt: true },
    });
    if (!row || !row.publishedAt) return null;
    return {
      type: row.type,
      payload: row.payload as unknown,
      version: row.version,
      publishedAt: row.publishedAt.toISOString(),
    };
  }

  /**
   * Admin read — returns the latest version for a (page, key, locale),
   * regardless of publish state.
   */
  async adminLatest(page: string, key: string, locale = "en"): Promise<ContentBlock | null> {
    return this.db.contentBlock.findFirst({
      where: { page, key, locale },
      orderBy: { version: "desc" },
    });
  }

  /** Admin list — used to populate the admin index of editable surfaces. */
  async adminListByPage(page?: string): Promise<ContentBlock[]> {
    return this.db.contentBlock.findMany({
      where: page ? { page } : {},
      orderBy: [{ page: "asc" }, { key: "asc" }, { version: "desc" }],
    });
  }

  /**
   * Admin upsert — creates a new draft version for the given (page, key, locale).
   * Validates the payload against the discriminated Zod union.
   */
  async upsertDraft(
    dto: UpsertContentBlockDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<ContentBlock> {
    // Validate the payload shape matches the declared type.
    const candidate = { type: dto.type, ...dto.payload };
    const result = BlockPayload.safeParse(candidate);
    if (!result.success) {
      throw new BadRequestException({
        message: "Block payload failed validation.",
        errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }

    const locale = dto.locale ?? "en";
    const latest = await this.db.contentBlock.findFirst({
      where: { page: dto.page, key: dto.key, locale },
      orderBy: { version: "desc" },
    });

    const version = latest ? latest.version + 1 : 1;

    const created = await this.db.contentBlock.create({
      data: {
        page: dto.page,
        key: dto.key,
        locale,
        type: dto.type,
        payload: result.data as object,
        version,
        publishedAt: null,
        updatedBy: actorId,
      },
    });

    await this.audit("content.draft", "ContentBlock", created.id, actorId, meta, {
      page: dto.page,
      key: dto.key,
      version,
    });

    return created;
  }

  /** Publish a draft. Refuses to "republish" an already-published row. */
  async publish(blockId: string, actorId: string, meta: RequestMeta): Promise<ContentBlock> {
    const row = await this.db.contentBlock.findUnique({ where: { id: blockId } });
    if (!row) throw new NotFoundException();

    if (row.publishedAt) {
      // Idempotent: if it's already published, just return it.
      return row;
    }

    const updated = await this.db.contentBlock.update({
      where: { id: blockId },
      data: { publishedAt: new Date() },
    });

    await this.audit("content.publish", "ContentBlock", blockId, actorId, meta, {
      page: row.page,
      key: row.key,
      version: row.version,
    });

    return updated;
  }

  /** Roll back to a previous version by re-publishing it. */
  async rollback(
    page: string,
    key: string,
    locale: string,
    targetVersion: number,
    actorId: string,
    meta: RequestMeta,
  ): Promise<ContentBlock> {
    const target = await this.db.contentBlock.findUnique({
      where: { page_key_locale_version: { page, key, locale, version: targetVersion } },
    });
    if (!target) throw new NotFoundException();

    // Create a *new* version copying the target's payload — we never mutate
    // history; rolling back is a forward-only action.
    const latest = await this.db.contentBlock.findFirst({
      where: { page, key, locale },
      orderBy: { version: "desc" },
    });
    const version = (latest?.version ?? 0) + 1;

    const created = await this.db.contentBlock.create({
      data: {
        page,
        key,
        locale,
        type: target.type,
        payload: target.payload as object,
        version,
        publishedAt: new Date(),
        updatedBy: actorId,
      },
    });

    await this.audit("content.rollback", "ContentBlock", created.id, actorId, meta, {
      page,
      key,
      from: latest?.version,
      to: targetVersion,
      newVersion: version,
    });

    return created;
  }

  // ---- helpers ----

  private async audit(
    action: string,
    entity: string,
    entityId: string,
    actorId: string,
    meta: RequestMeta,
    after?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          action,
          entity,
          entityId,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          after: (after ?? undefined) as never,
        },
      });
    } catch (err) {
      this.logger.error({ err, action }, "Failed to write content audit log");
    }
  }
}
