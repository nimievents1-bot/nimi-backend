import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ContactKind, ContactStatus } from "@prisma/client";

import { getEnv, publicWebUrl } from "../../config/env";
import { MailerService } from "../mailer/mailer.service";
import {
  contactAckTemplate,
  contactNotifyTemplate,
} from "../mailer/templates";
import { PrismaService } from "../prisma/prisma.service";

import { type CreateContactEnquiryDto } from "./dto/contact.dto";
import { TurnstileService } from "./turnstile.service";

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly mailer: MailerService,
    private readonly turnstile: TurnstileService,
  ) {}

  async create(dto: CreateContactEnquiryDto, meta: RequestMeta) {
    // Honeypot — silently accept-and-discard.
    const isHoneypotted = Boolean(dto.website && dto.website.length > 0);

    if (!isHoneypotted) {
      const ok = await this.turnstile.verify(dto.turnstileToken, meta.ip);
      if (!ok) {
        throw new BadRequestException("Bot protection check failed. Please try again.");
      }
    }

    const enquiry = await this.db.contactEnquiry.create({
      data: {
        kind: dto.kind as ContactKind,
        status: isHoneypotted ? ContactStatus.SPAM : ContactStatus.NEW,
        name: dto.name.trim(),
        email: dto.email.toLowerCase().trim(),
        phone: dto.phone?.trim() ?? null,
        eventDate: dto.eventDate ?? null,
        eventType: dto.eventType?.trim() ?? null,
        guestCount: dto.guestCount ?? null,
        budgetBand: dto.budgetBand?.trim() ?? null,
        dietary: dto.dietary?.trim() ?? null,
        notes: dto.notes.trim(),
        source: dto.source?.trim() ?? null,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    if (!isHoneypotted) {
      // Best-effort emails. If they fail, the enquiry is still safely
      // persisted and surfaced in the admin inbox.
      try {
        const ackTpl = contactAckTemplate({ name: enquiry.name, kind: enquiry.kind });
        await this.mailer.send({
          to: enquiry.email,
          ...ackTpl,
          tag: `contact-ack-${enquiry.kind.toLowerCase()}`,
        });
      } catch (err) {
        this.logger.error({ err, enquiryId: enquiry.id }, "Failed to send acknowledgement");
      }

      const adminUrl = `${publicWebUrl()}/admin/enquiries/${enquiry.id}`;
      try {
        const notifyTpl = contactNotifyTemplate({
          enquiryId: enquiry.id,
          kind: enquiry.kind,
          name: enquiry.name,
          email: enquiry.email,
          phone: enquiry.phone ?? undefined,
          notes: enquiry.notes,
          adminUrl,
        });
        await this.mailer.send({
          to: getEnv().SUPPORT_INBOX,
          ...notifyTpl,
          replyTo: enquiry.email,
          tag: `contact-notify-${enquiry.kind.toLowerCase()}`,
        });
      } catch (err) {
        this.logger.error({ err, enquiryId: enquiry.id }, "Failed to send admin notification");
      }
    }

    if (isHoneypotted) {
      // Reply identically to a real submission so a bot can't tell.
      // (We still persisted with status=SPAM for analysis.)
    }

    return { id: enquiry.id, ok: true };
  }

  /** Used by the admin module (later phase) to expose enquiries. */
  async listForAdmin() {
    if (getEnv().NODE_ENV !== "test") {
      throw new ServiceUnavailableException("Admin enquiry listing is added in a later phase.");
    }
    return this.db.contactEnquiry.findMany({ orderBy: { createdAt: "desc" } });
  }

  /**
   * Customer self-service listing. Returns every non-SPAM enquiry whose
   * `email` matches the signed-in user's account email. We deliberately
   * compare case-insensitively because email addresses are case-folded
   * for routing purposes — a customer who typed "Jane@x.com" on the
   * form and later signed up as "jane@x.com" should see their own
   * submissions. The query is bounded by the existing `@@index([email])`
   * on ContactEnquiry, so it stays fast as the inbox grows.
   *
   * We surface only the fields a customer should see: the kind (catering
   * vs events), the current status, the date, the original notes, and
   * the event metadata they filled in. Admin-only fields (`internalNotes`,
   * `handledBy`, `ip`, `userAgent`) are NEVER returned from this method.
   */
  async listForCustomer(email: string): Promise<
    Array<{
      id: string;
      kind: ContactKind;
      status: ContactStatus;
      notes: string;
      eventDate: string | null;
      eventType: string | null;
      guestCount: number | null;
      budgetBand: string | null;
      createdAt: string;
      updatedAt: string;
    }>
  > {
    const rows = await this.db.contactEnquiry.findMany({
      where: {
        email: { equals: email.toLowerCase().trim(), mode: "insensitive" },
        status: { not: ContactStatus.SPAM },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        kind: true,
        status: true,
        notes: true,
        eventDate: true,
        eventType: true,
        guestCount: true,
        budgetBand: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      notes: row.notes,
      eventDate: row.eventDate ? row.eventDate.toISOString() : null,
      eventType: row.eventType,
      guestCount: row.guestCount,
      budgetBand: row.budgetBand,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
