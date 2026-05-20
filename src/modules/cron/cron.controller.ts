import { Controller, ForbiddenException, Headers, HttpCode, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { getEnv } from "../../config/env";
import { Public } from "../../common/decorators/public.decorator";

import { CronService } from "./cron.service";

/**
 * Cron-triggered endpoints.
 *
 * Authentication: a single shared secret (`CRON_SECRET`) is presented in
 * the `x-cron-secret` HTTP header. We compare in constant time and refuse
 * any call (with a 403) if the secret is unset OR doesn't match — this
 * prevents accidental triggering before the operator has configured a
 * scheduler, and stops drive-by callers from running marketing jobs.
 *
 * Rate limit: 30/min per IP, well above any legitimate scheduler rate
 * but enough to short-circuit a brute-force probe of the secret.
 */
@Controller({ path: "cron", version: "1" })
@Public() // bypass JWT — cron is auth'd by header secret, not user session
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class CronController {
  constructor(private readonly cron: CronService) {}

  @Post("birthday-emails")
  @HttpCode(200)
  async birthdayEmails(@Headers("x-cron-secret") secret?: string) {
    this.assertAuthorised(secret);
    const result = await this.cron.runBirthdayJob();
    return { ok: true, ...result };
  }

  @Post("credits-reminder")
  @HttpCode(200)
  async creditsReminder(@Headers("x-cron-secret") secret?: string) {
    this.assertAuthorised(secret);
    const result = await this.cron.runCreditsReminderJob();
    return { ok: true, ...result };
  }

  /**
   * Daily credit-maintenance sweep. Two responsibilities, one walk:
   *   - Forfeit any portion of ACCRUAL rows whose 3-month validity
   *     has elapsed and which redemptions haven't already covered.
   *   - Send a "credits expiring soon" heads-up email for accruals
   *     whose deadline is inside the next CREDIT_EXPIRING_NOTICE_DAYS.
   * Recommended schedule: 03:00 UTC daily (before customers wake up
   * so the forfeit is settled before they next check their balance).
   */
  @Post("credits-maintenance")
  @HttpCode(200)
  async creditsMaintenance(@Headers("x-cron-secret") secret?: string) {
    this.assertAuthorised(secret);
    const result = await this.cron.runCreditMaintenanceJob();
    return { ok: true, ...result };
  }

  /** Constant-time comparison so secret-length isn't leaked via timing. */
  private assertAuthorised(presented: string | undefined): void {
    const env = getEnv();
    const expected = env.CRON_SECRET;
    if (!expected || !presented) {
      throw new ForbiddenException("Cron secret not configured.");
    }
    if (!constantTimeEqual(presented, expected)) {
      throw new ForbiddenException("Invalid cron secret.");
    }
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
