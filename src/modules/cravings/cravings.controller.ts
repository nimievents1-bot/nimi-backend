import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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

import { CravingsService } from "./cravings.service";
import {
  AdjustCreditDto,
  SubscribeDto,
  UpsertCravingsPlanDto,
} from "./dto/cravings.dto";

@Controller({ path: "cravings", version: "1" })
export class CravingsController {
  constructor(private readonly cravings: CravingsService) {}

  // ---------- public ----------

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get("plans")
  async listPlans() {
    const rows = await this.cravings.listActivePlans();
    return rows.map((p) => ({
      slug: p.slug,
      name: p.name,
      description: p.description,
      monthlyAmountMinor: p.monthlyAmountMinor,
      currency: p.currency,
      position: p.position,
      // True only when the plan has a live Stripe Price ID. The web UI
      // uses this to render a disabled "Coming soon" state instead of
      // a "Join the club" button that would 503. We expose just the
      // boolean — never the Price ID itself — so the public response
      // doesn't leak Stripe internals.
      stripeReady: Boolean(p.stripePriceId),
      // Optional admin-uploaded hero image. The PlanGrid uses this in
      // preference to its position-based placeholder photography. We
      // surface `null` (not omit) so the web client can rely on the
      // field being present and treat missing/cleared values the same.
      imageUrl: p.imageUrl ?? null,
    }));
  }

  // ---------- subscribe ----------

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("subscribe")
  @HttpCode(201)
  async subscribe(@Body() dto: SubscribeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cravings.createSubscriptionCheckout(dto, { id: user.id, email: user.email });
  }

  @UseGuards(JwtAuthGuard)
  @Post("portal")
  @HttpCode(201)
  async portal(@CurrentUser() user: AuthenticatedUser) {
    return this.cravings.createPortalSession(user.id);
  }

  // ---------- customer reads ----------

  @UseGuards(JwtAuthGuard)
  @Get("me")
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.cravings.getMySubscription(user.id);
  }
}

@Controller({ path: "admin/cravings", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OWNER", "EDITOR")
export class AdminCravingsController {
  constructor(private readonly cravings: CravingsService) {}

  @Get("plans")
  async listAllPlans() {
    // Returns every CravingsPlan row — active and inactive — so the admin
    // can see which tiers are seeded, which are wired to Stripe, and
    // which still need publishing. Mirrors the schema fields exposed to
    // the upsert DTO so the "Publish to Stripe" button can echo them
    // straight back without a lookup.
    return this.cravings.listAllPlansForAdmin();
  }

  @Get("plans/:slug")
  async getPlan(@Param("slug") slug: string) {
    // Single-plan getter for the admin tier editor. Returns hidden
    // plans too so the operator can re-activate them. The response
    // includes `stripePriceId` / `stripeProductId` so the editor can
    // flag a re-publish when the operator changes the price.
    const plan = await this.cravings.getPlanBySlugForAdmin(slug);
    return {
      slug: plan.slug,
      name: plan.name,
      description: plan.description,
      monthlyAmountMinor: plan.monthlyAmountMinor,
      currency: plan.currency,
      position: plan.position,
      active: plan.active,
      stripeReady: Boolean(plan.stripePriceId),
      // Surface the optional hero image so the admin editor can
      // pre-populate the URL field and the live preview tile.
      imageUrl: plan.imageUrl,
    };
  }

  @Post("plans")
  async upsertPlan(@Body() dto: UpsertCravingsPlanDto) {
    return this.cravings.upsertPlan(dto);
  }

  @Get("subscribers")
  async list(
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("status") status?: string,
  ) {
    return this.cravings.listAdminSubscribers({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      status: status as never,
    });
  }

  @Roles("OWNER")
  @Post("credit/adjust")
  @HttpCode(200)
  async adjust(
    @Body() dto: AdjustCreditDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
  ) {
    return this.cravings.adminAdjustCredit(dto.userId, dto.amountMinor, dto.reason, user.id, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
}
