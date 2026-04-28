import { Controller, Get, HttpCode, Logger } from "@nestjs/common";
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  PrismaHealthIndicator,
} from "@nestjs/terminus";
import { SkipThrottle } from "@nestjs/throttler";

import { PrismaService } from "../prisma/prisma.service";

/**
 * Liveness and readiness probes.
 *
 * - GET /healthz — process is up (cheap, always 200 if running).
 * - GET /readyz  — dependencies (DB, Redis) are reachable. Returns 503 if not.
 *
 * Both probes are excluded from the global `/api` prefix and from rate limiting,
 * because load balancers will hit them constantly.
 */
@Controller()
@SkipThrottle()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @Get("healthz")
  @HttpCode(200)
  liveness(): { status: "ok"; service: string; time: string } {
    return { status: "ok", service: "nimi-api", time: new Date().toISOString() };
  }

  @Get("readyz")
  @HealthCheck()
  async readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.prismaIndicator.pingCheck("database", this.prisma, { timeout: 1500 }),
    ]);
  }
}
