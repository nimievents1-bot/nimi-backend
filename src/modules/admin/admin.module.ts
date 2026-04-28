import { Module } from "@nestjs/common";

import { AuditController } from "./audit.controller";
import { KpisController } from "./kpis.controller";

/**
 * AdminModule — read-only admin endpoints that don't fit a specific
 * domain module: KPIs dashboard data, audit log viewer.
 *
 * Domain-specific admin endpoints (orders, enquiries, content, blog,
 * cravings) live in their respective feature modules.
 */
@Module({
  controllers: [KpisController, AuditController],
})
export class AdminModule {}
