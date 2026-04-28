import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { BlogPostStatus } from "@prisma/client";
import { type FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { type AuthenticatedUser } from "../auth/types";

import { BlogService } from "./blog.service";
import {
  CreateBlogPostDto,
  ListPostsQueryDto,
  PublishBlogPostDto,
  UpdateBlogPostDto,
} from "./dto/blog.dto";

@Controller({ path: "blog", version: "1" })
export class BlogController {
  constructor(private readonly blog: BlogService) {}

  // ---------- public ----------

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get("posts")
  async list(@Query() query: ListPostsQueryDto) {
    // On every list-call, also promote any scheduled posts whose time has come.
    // Cheap when nothing is due (single SQL update with no rows affected).
    await this.blog.promoteScheduled();
    return this.blog.listPublished({
      limit: query.limit,
      offset: query.offset,
      category: query.category,
    });
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get("posts/:slug")
  async getBySlug(@Param("slug") slug: string) {
    await this.blog.promoteScheduled();
    return this.blog.getPublishedBySlug(slug);
  }
}

@Controller({ path: "admin/blog", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminBlogController {
  constructor(private readonly blog: BlogService) {}

  @Get("posts")
  async list(@Query() query: ListPostsQueryDto) {
    return this.blog.adminList({
      limit: query.limit,
      offset: query.offset,
      status: query.status as BlogPostStatus | undefined,
      q: query.q,
    });
  }

  @Get("posts/:id")
  async get(@Param("id") id: string) {
    return this.blog.adminGet(id);
  }

  @Post("posts")
  @HttpCode(201)
  async create(
    @Body() dto: CreateBlogPostDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.blog.create(dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Patch("posts/:id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateBlogPostDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.blog.update(id, dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Post("posts/:id/publish")
  @HttpCode(200)
  async publish(
    @Param("id") id: string,
    @Body() dto: PublishBlogPostDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.blog.publish(id, dto.scheduledFor, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Post("posts/:id/unpublish")
  @HttpCode(200)
  async unpublish(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.blog.unpublish(id, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Roles("OWNER")
  @Delete("posts/:id")
  @HttpCode(200)
  async delete(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.blog.delete(id, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
