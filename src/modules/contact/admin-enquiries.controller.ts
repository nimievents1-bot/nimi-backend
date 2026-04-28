import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ContactKind,
  type ContactEnquiry,
  ContactStatus,
  Prisma,
} from "@prisma/client";
import { type FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { type AuthenticatedUser } from "../auth/types";
import { MailerService } from "../mailer/mailer.service";
import { PrismaService } from "../prisma/prisma.service";

import {
  ListEnquiriesQueryDto,
  ReplyEnquiryDto,
  UpdateEnquiryDto,
} from "./dto/admin-enquiries.dto";

interface ListResponse {
  rows: ContactEnquiry[];
  total: number;
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

/**
 * Admin enquiries inbox.
 *
 * Authorisation: every endpoint requires JWT + role ∈ {OWNER, EDITOR, SUPPORT}.
 * SUPPORT can read and reply but not move to CLOSED — enforced by the
 * status-change check in `update`.
 *
 * Every mutation is audited.
 */
@Controller({ path: "admin/enquiries", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR", "SUPPORT")
export class AdminEnquiriesController {
  private readonly logger = new Logger(AdminEnquiriesController.name);

  constructor(
    private readonly db: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  @Get()
  async list(@Query() query: ListEnquiriesQueryDto): Promise<ListResponse> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = query.offset ?? 0;

    const where: Prisma.ContactEnquiryWhereInput = {};
    if (query.status) where.status = query.status as ContactStatus;
    if (query.kind) where.kind = query.kind as ContactKind;
    if (query.q) {
      const term = query.q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { notes: { contains: term, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await this.db.$transaction([
      this.db.contactEnquiry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.db.contactEnquiry.count({ where }),
    ]);

    return { rows, total, limit, offset };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<ContactEnquiry> {
    const row = await this.db.contactEnquiry.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateEnquiryDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ContactEnquiry> {
    const before = await this.db.contactEnquiry.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    // SUPPORT may not close enquiries — only OWNER and EDITOR.
    if (
      dto.status === "CLOSED" &&
      user.role !== "OWNER" &&
      user.role !== "EDITOR"
    ) {
      this.logger.warn(
        { userId: user.id, role: user.role, enquiryId: id },
        "SUPPORT user attempted to CLOSE an enquiry",
      );
      throw new NotFoundException(); // generic — don't leak the policy
    }

    const data: Prisma.ContactEnquiryUpdateInput = {};
    if (dto.status) {
      data.status = dto.status as ContactStatus;
      if (dto.status !== before.status && dto.status !== "NEW") {
        data.handledBy = user.id;
        data.handledAt = new Date();
      }
    }
    if (dto.internalNotes !== undefined) {
      data.internalNotes = dto.internalNotes;
    }

    const updated = await this.db.contactEnquiry.update({ where: { id }, data });

    await this.audit("enquiry.update", "ContactEnquiry", id, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    }, {
      fromStatus: before.status,
      toStatus: updated.status,
      notesChanged: dto.internalNotes !== undefined,
    });

    return updated;
  }

  @Post(":id/reply")
  async reply(
    @Param("id") id: string,
    @Body() dto: ReplyEnquiryDto,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const enquiry = await this.db.contactEnquiry.findUnique({ where: { id } });
    if (!enquiry) throw new NotFoundException();

    const html = `<p>Hi ${escape(enquiry.name)},</p>
<p style="white-space:pre-wrap">${escape(dto.body)}</p>
<p>— ${escape(user.email)}<br>Nimi Events</p>`;

    await this.mailer.send({
      to: enquiry.email,
      subject: dto.subject,
      html,
      text: `Hi ${enquiry.name},\n\n${dto.body}\n\n— ${user.email}\nNimi Events`,
      replyTo: user.email,
      tag: "enquiry-reply",
    });

    // Move to CONTACTED if it was still NEW.
    let updated = enquiry;
    if (enquiry.status === "NEW") {
      updated = await this.db.contactEnquiry.update({
        where: { id },
        data: { status: "CONTACTED", handledBy: user.id, handledAt: new Date() },
      });
    }

    await this.audit("enquiry.reply", "ContactEnquiry", id, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    }, {
      subject: dto.subject,
      replierEmail: user.email,
    });

    return updated;
  }

  // ---- helpers ----

  private async audit(
    action: string,
    entity: string,
    entityId: string,
    actorId: string,
    meta: { ip?: string; userAgent?: string },
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
      this.logger.error({ err, action }, "Failed to write audit log");
    }
  }
}

const escapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};
const escape = (raw: string): string => raw.replace(/[&<>"']/g, (c) => escapeMap[c] ?? c);
