import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { type FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { type AuthenticatedUser } from "../auth/types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

import { ContactService } from "./contact.service";
import { CreateContactEnquiryDto } from "./dto/contact.dto";

/**
 * Public contact / enquiry endpoint + customer-facing self-service read.
 *
 * - `POST /contact`       Public form submission. Bot-protected via
 *                         Turnstile, honeypot, and rate limiting.
 * - `GET  /contact/mine`  Auth-required. Returns every enquiry the
 *                         signed-in user has previously submitted with
 *                         their account email. Drives /account/bookings
 *                         on the web so customers can see the status
 *                         (NEW / IN_PROGRESS / etc.) of every catering
 *                         and events enquiry they've sent.
 */
@Controller({ path: "contact", version: "1" })
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateContactEnquiryDto, @Req() req: FastifyRequest) {
    return this.contact.create(dto, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  /**
   * Returns the signed-in user's own enquiries, matched by email.
   *
   * Email is the only ID we can match on because the public contact
   * form doesn't require sign-in — many enquiries land before the
   * submitter creates an account. The trade-off: if a customer signs
   * up with a different email than the one they used on the form,
   * those enquiries won't appear here. The admin enquiries inbox
   * remains the authoritative listing across all senders.
   */
  @UseGuards(JwtAuthGuard)
  @Get("mine")
  async listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.contact.listForCustomer(user.email);
  }
}
