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
import { type FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { type AuthenticatedUser } from "../auth/types";

import {
  AdminListTestimonialsQueryDto,
  CreateTestimonialDto,
  ListTestimonialsQueryDto,
  UpdateTestimonialDto,
} from "./dto/testimonials.dto";
import { TestimonialsService } from "./testimonials.service";

@Controller({ path: "testimonials", version: "1" })
export class TestimonialsController {
  constructor(private readonly testimonials: TestimonialsService) {}

  @Public()
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Get("published")
  async list(@Query() query: ListTestimonialsQueryDto) {
    return this.testimonials.listPublished({
      limit: query.limit,
      offset: query.offset,
    });
  }
}

@Controller({ path: "admin/testimonials", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminTestimonialsController {
  constructor(private readonly testimonials: TestimonialsService) {}

  @Get()
  async list(@Query() query: AdminListTestimonialsQueryDto) {
    return this.testimonials.adminList({
      limit: query.limit,
      offset: query.offset,
      isPublished: query.isPublished,
      q: query.q,
    });
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return this.testimonials.adminGet(id);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() dto: CreateTestimonialDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.testimonials.create(dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateTestimonialDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.testimonials.update(id, dto, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Roles("OWNER")
  @Delete(":id")
  @HttpCode(200)
  async delete(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.testimonials.delete(id, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
