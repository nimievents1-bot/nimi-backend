import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { type FastifyRequest } from "fastify";

import { Public } from "../../common/decorators/public.decorator";

import {
  ConfirmDto,
  SubscribeDto,
  UnsubscribeDto,
} from "./dto/newsletter.dto";
import { NewsletterService } from "./newsletter.service";

/**
 * Public newsletter endpoints.
 * Subscribe is throttled tightly to prevent abuse for spam relay.
 */
@Controller({ path: "newsletter", version: "1" })
export class NewsletterController {
  constructor(private readonly newsletter: NewsletterService) {}

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post("subscribe")
  @HttpCode(202)
  async subscribe(@Body() dto: SubscribeDto, @Req() req: FastifyRequest) {
    return this.newsletter.subscribe(dto, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("confirm")
  @HttpCode(200)
  async confirm(@Body() dto: ConfirmDto) {
    return this.newsletter.confirm(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("unsubscribe")
  @HttpCode(200)
  async unsubscribe(@Body() dto: UnsubscribeDto) {
    return this.newsletter.unsubscribe(dto.token);
  }
}
