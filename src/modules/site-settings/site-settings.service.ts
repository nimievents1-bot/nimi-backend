import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { type SiteSetting } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import {
  type PublicSiteSettingDto,
  type UpsertSiteSettingDto,
} from "./dto/site-settings.dto";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * SiteSettingsService — admin-editable plain-text snippets for the
 * marketing site. Direct sibling of `SiteImagesService`; same
 * lifecycle methods, same audit-trail behaviour, just with `value`
 * instead of `url`/`alt`.
 *
 * Why we don't reuse `ContentBlock`: see the doc comment on the
 * `SiteSetting` model. Short version: ContentBlock requires every
 * payload shape to be pre-registered in the Zod discriminated union
 * in `content/blocks.ts`. SiteSetting is open-set — operators can
 * add new keys via the registry on the web side without touching
 * API schemas.
 */
@Injectable()
export class SiteSettingsService {
  private readonly logger = new Logger(SiteSettingsService.name);

  constructor(private readonly db: PrismaService) {}

  async listAll(): Promise<SiteSetting[]> {
    return this.db.siteSetting.findMany();
  }

  async listPublic(): Promise<PublicSiteSettingDto[]> {
    const rows = await this.listAll();
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }

  async getByKey(key: string): Promise<SiteSetting | null> {
    return this.db.siteSetting.findUnique({ where: { key } });
  }

  async upsert(
    key: string,
    dto: UpsertSiteSettingDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<SiteSetting> {
    const before = await this.getByKey(key);

    const row = await this.db.siteSetting.upsert({
      where: { key },
      create: {
        key,
        value: dto.value,
        updatedBy: actorId,
      },
      update: {
        value: dto.value,
        updatedBy: actorId,
      },
    });

    await this.audit("site_setting.upsert", key, actorId, meta, {
      before: before ? { value: before.value } : null,
      after: { value: row.value },
    });

    return row;
  }

  async remove(
    key: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const before = await this.getByKey(key);
    if (!before) throw new NotFoundException();

    await this.db.siteSetting.delete({ where: { key } });

    await this.audit("site_setting.delete", key, actorId, meta, {
      before: { value: before.value },
    });

    return { ok: true };
  }

  /** Best-effort audit trail — never blocks a successful mutation. */
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
          entity: "SiteSetting",
          entityId: key,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          after: details as object,
        },
      });
    } catch (err) {
      this.logger.warn({ err, key, action }, "Audit write failed for SiteSetting");
    }
  }
}
