import { Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../common/decorators/public.decorator";

import { GiftingService } from "./gifting.service";

/**
 * Public catalogue. List + detail. No auth required.
 * Tight throttle bucket — generous, but caps abusive scraping.
 */
@Controller({ path: "gifting/collections", version: "1" })
export class CollectionsController {
  constructor(private readonly gifting: GiftingService) {}

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get()
  async list(@Query("category") category?: string) {
    const rows = await this.gifting.listPublishedCollections(category);
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      category: r.category,
      name: r.name,
      description: r.description,
      items: r.items as string[],
      unitPriceMinor: r.unitPriceMinor,
      priceMaxMinor: r.priceMaxMinor,
      currency: r.currency,
      moq: r.moq,
      leadTimeDays: r.leadTimeDays,
      imageUrl: r.imageUrl,
    }));
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get(":slug")
  async get(@Param("slug") slug: string) {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new NotFoundException();
    const r = await this.gifting.getPublishedCollection(slug);
    return {
      id: r.id,
      slug: r.slug,
      category: r.category,
      name: r.name,
      description: r.description,
      items: r.items as string[],
      unitPriceMinor: r.unitPriceMinor,
      priceMaxMinor: r.priceMaxMinor,
      currency: r.currency,
      moq: r.moq,
      leadTimeDays: r.leadTimeDays,
      imageUrl: r.imageUrl,
    };
  }
}
