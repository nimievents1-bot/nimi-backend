import { Module } from "@nestjs/common";

import { PromoCodesService } from "./promo-codes.service";

/**
 * PromoCodesModule — exports the PromoCodesService for any caller that
 * needs to issue, validate, or atomically redeem a promotional code.
 * No HTTP controllers live here; the customer-facing surface is the
 * pastry cart preview + checkout endpoints, which inject this service
 * directly. Birthday issuance is driven from the cron module.
 */
@Module({
  providers: [PromoCodesService],
  exports: [PromoCodesService],
})
export class PromoCodesModule {}
