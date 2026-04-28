import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { type FastifyRequest } from "fastify";

import { Public } from "../../common/decorators/public.decorator";

import { ContactService } from "./contact.service";
import { CreateContactEnquiryDto } from "./dto/contact.dto";

/**
 * Public contact / enquiry endpoint.
 * Versioned + rate-limited. Anyone with internet access can reach it,
 * but bot protection (Turnstile + honeypot + Throttler) keeps it sane.
 */
@Controller({ path: "contact", version: "1" })
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Public()
  @Throttle({ contact: { limit: 3, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateContactEnquiryDto, @Req() req: FastifyRequest) {
    return this.contact.create(dto, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
