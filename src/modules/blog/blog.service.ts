import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  type BlogPost,
  BlogPostStatus,
  Prisma,
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import { type CreateBlogPostDto, type UpdateBlogPostDto } from "./dto/blog.dto";
import { estimateWordCount, sanitiseHtml } from "./sanitise";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

interface PublicPost {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  coverUrl: string | null;
  coverAlt: string | null;
  authorName: string;
  category: string | null;
  tags: string[];
  publishedAt: string;
  wordCount: number;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImageUrl: string | null;
}

interface PublicListItem {
  slug: string;
  title: string;
  excerpt: string;
  coverUrl: string | null;
  coverAlt: string | null;
  authorName: string;
  category: string | null;
  publishedAt: string;
  wordCount: number;
}

@Injectable()
export class BlogService {
  private readonly logger = new Logger(BlogService.name);

  constructor(private readonly db: PrismaService) {}

  // ---------- public ----------

  async listPublished(opts: { limit?: number; offset?: number; category?: string } = {}): Promise<{
    rows: PublicListItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(opts.limit ?? 12, 50);
    const offset = opts.offset ?? 0;
    const now = new Date();

    const where: Prisma.BlogPostWhereInput = {
      status: BlogPostStatus.PUBLISHED,
      publishedAt: { lte: now, not: null },
      ...(opts.category ? { category: opts.category } : {}),
    };

    const [rows, total] = await this.db.$transaction([
      this.db.blogPost.findMany({
        where,
        orderBy: { publishedAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          slug: true,
          title: true,
          excerpt: true,
          coverUrl: true,
          coverAlt: true,
          authorName: true,
          category: true,
          publishedAt: true,
          wordCount: true,
        },
      }),
      this.db.blogPost.count({ where }),
    ]);

    return {
      rows: rows.map((r) => ({
        ...r,
        publishedAt: r.publishedAt!.toISOString(),
      })),
      total,
      limit,
      offset,
    };
  }

  async getPublishedBySlug(slug: string): Promise<PublicPost> {
    const now = new Date();
    const row = await this.db.blogPost.findFirst({
      where: {
        slug,
        status: BlogPostStatus.PUBLISHED,
        publishedAt: { lte: now, not: null },
      },
    });
    if (!row) throw new NotFoundException();
    return {
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      body: row.body,
      coverUrl: row.coverUrl,
      coverAlt: row.coverAlt,
      authorName: row.authorName,
      category: row.category,
      tags: (row.tags as string[]) ?? [],
      publishedAt: row.publishedAt!.toISOString(),
      wordCount: row.wordCount,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      ogImageUrl: row.ogImageUrl,
    };
  }

  // ---------- admin ----------

  async adminList(opts: { limit?: number; offset?: number; status?: BlogPostStatus; q?: string }) {
    const limit = Math.min(opts.limit ?? 25, 100);
    const offset = opts.offset ?? 0;

    const where: Prisma.BlogPostWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.q) {
      const term = opts.q.trim();
      where.OR = [
        { title: { contains: term, mode: "insensitive" } },
        { excerpt: { contains: term, mode: "insensitive" } },
        { slug: { contains: term, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await this.db.$transaction([
      this.db.blogPost.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.db.blogPost.count({ where }),
    ]);

    return { rows, total, limit, offset };
  }

  async adminGet(id: string): Promise<BlogPost> {
    const row = await this.db.blogPost.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  async create(dto: CreateBlogPostDto, actorId: string, meta: RequestMeta): Promise<BlogPost> {
    const existing = await this.db.blogPost.findUnique({ where: { slug: dto.slug } });
    if (existing) throw new ConflictException("A post with this slug already exists.");

    const sanitised = sanitiseHtml(dto.body);
    const post = await this.db.blogPost.create({
      data: {
        slug: dto.slug,
        title: dto.title,
        excerpt: dto.excerpt,
        body: sanitised,
        coverUrl: dto.coverUrl ?? null,
        coverAlt: dto.coverAlt ?? null,
        authorName: dto.authorName,
        category: dto.category ?? null,
        tags: (dto.tags ?? []) as Prisma.InputJsonValue,
        seoTitle: dto.seoTitle ?? null,
        seoDescription: dto.seoDescription ?? null,
        ogImageUrl: dto.ogImageUrl ?? null,
        wordCount: estimateWordCount(sanitised),
        status: BlogPostStatus.DRAFT,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
    await this.audit("blog.create", post.id, actorId, meta, { slug: post.slug });
    return post;
  }

  async update(
    id: string,
    dto: UpdateBlogPostDto,
    actorId: string,
    meta: RequestMeta,
  ): Promise<BlogPost> {
    const before = await this.db.blogPost.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    const data: Prisma.BlogPostUpdateInput = { updatedBy: actorId };
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.excerpt !== undefined) data.excerpt = dto.excerpt;
    if (dto.body !== undefined) {
      const sanitised = sanitiseHtml(dto.body);
      data.body = sanitised;
      data.wordCount = estimateWordCount(sanitised);
    }
    if (dto.authorName !== undefined) data.authorName = dto.authorName;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.tags !== undefined) data.tags = (dto.tags as Prisma.InputJsonValue);
    if (dto.coverUrl !== undefined) data.coverUrl = dto.coverUrl;
    if (dto.coverAlt !== undefined) data.coverAlt = dto.coverAlt;
    if (dto.seoTitle !== undefined) data.seoTitle = dto.seoTitle;
    if (dto.seoDescription !== undefined) data.seoDescription = dto.seoDescription;
    if (dto.ogImageUrl !== undefined) data.ogImageUrl = dto.ogImageUrl;

    const updated = await this.db.blogPost.update({ where: { id }, data });
    await this.audit("blog.update", id, actorId, meta, { changedKeys: Object.keys(dto) });
    return updated;
  }

  async publish(id: string, scheduledFor: Date | undefined, actorId: string, meta: RequestMeta) {
    const before = await this.db.blogPost.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    if (!before.body || before.wordCount < 5) {
      throw new BadRequestException("Post body is empty — write something before publishing.");
    }
    if (!before.coverUrl) {
      // Optional: require a cover image. Soft warning for now — uncomment to enforce.
      // throw new BadRequestException("Add a cover image before publishing.");
    }

    const now = new Date();
    const scheduled = scheduledFor && scheduledFor.getTime() > now.getTime();

    const updated = await this.db.blogPost.update({
      where: { id },
      data: {
        status: scheduled ? BlogPostStatus.SCHEDULED : BlogPostStatus.PUBLISHED,
        publishedAt: scheduled ? scheduledFor : now,
        updatedBy: actorId,
      },
    });

    await this.audit(scheduled ? "blog.schedule" : "blog.publish", id, actorId, meta, {
      slug: before.slug,
      publishedAt: updated.publishedAt?.toISOString() ?? null,
    });

    return updated;
  }

  async unpublish(id: string, actorId: string, meta: RequestMeta) {
    const before = await this.db.blogPost.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    const updated = await this.db.blogPost.update({
      where: { id },
      data: { status: BlogPostStatus.DRAFT, publishedAt: null, updatedBy: actorId },
    });
    await this.audit("blog.unpublish", id, actorId, meta, { slug: before.slug });
    return updated;
  }

  async delete(id: string, actorId: string, meta: RequestMeta): Promise<{ ok: true }> {
    const before = await this.db.blogPost.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    await this.db.blogPost.delete({ where: { id } });
    await this.audit("blog.delete", id, actorId, meta, { slug: before.slug });
    return { ok: true };
  }

  /** Promote SCHEDULED posts whose `publishedAt` has passed. Called by cron / on read. */
  async promoteScheduled(): Promise<number> {
    const now = new Date();
    const result = await this.db.blogPost.updateMany({
      where: { status: BlogPostStatus.SCHEDULED, publishedAt: { lte: now, not: null } },
      data: { status: BlogPostStatus.PUBLISHED },
    });
    if (result.count > 0) {
      this.logger.log({ count: result.count }, "Promoted scheduled posts to published");
    }
    return result.count;
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
          entity: "BlogPost",
          entityId,
          actorId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          after: after ?? undefined,
        },
      });
    } catch (err) {
      this.logger.error({ err, action }, "Failed to write blog audit log");
    }
  }
}
