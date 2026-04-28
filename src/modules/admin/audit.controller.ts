import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PrismaService } from "../prisma/prisma.service";

export class ListAuditLogsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;

  @IsOptional() @IsString() @MaxLength(80)
  action?: string;

  @IsOptional() @IsString() @MaxLength(80)
  entity?: string;

  @IsOptional() @IsString() @MaxLength(80)
  actorId?: string;
}

/**
 * Audit log viewer — read-only, role-gated to OWNER/EDITOR.
 *
 * The audit log is append-only at the database level; this endpoint just
 * exposes a filterable view. Sensitive fields (`before`/`after`) are
 * returned as-is — they were sanitised at write time by the producing service.
 */
@Controller({ path: "admin/audit", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AuditController {
  constructor(private readonly db: PrismaService) {}

  @Get("logs")
  async list(@Query() query: ListAuditLogsDto) {
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;

    const where: {
      action?: { startsWith: string };
      entity?: string;
      actorId?: string;
    } = {};
    if (query.action) where.action = { startsWith: query.action };
    if (query.entity) where.entity = query.entity;
    if (query.actorId) where.actorId = query.actorId;

    const [rows, total] = await this.db.$transaction([
      this.db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: { actor: { select: { email: true, name: true, role: true } } },
      }),
      this.db.auditLog.count({ where }),
    ]);

    return { rows, total, limit, offset };
  }
}
