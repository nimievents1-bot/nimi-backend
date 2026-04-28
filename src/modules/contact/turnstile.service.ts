import { Injectable, Logger } from "@nestjs/common";

import { getEnv } from "../../config/env";

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
  hostname?: string;
}

/**
 * Cloudflare Turnstile server-side verification.
 *
 * Pattern: client widget produces a one-time token; we POST it to the
 * Cloudflare endpoint along with our secret and the user's IP. Successful
 * tokens are single-use — a stolen token can't be replayed.
 *
 * In development without TURNSTILE_SECRET_KEY, verification is skipped
 * (returns true). This means production MUST configure the secret —
 * `getEnv()` doesn't make it required because the value is optional in
 * dev/test, but the deploy runbook should require it.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly endpoint = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

  async verify(token: string, ip?: string): Promise<boolean> {
    const secret = getEnv().TURNSTILE_SECRET_KEY;

    if (!secret) {
      if (getEnv().NODE_ENV === "production") {
        this.logger.error("TURNSTILE_SECRET_KEY is not set in production — failing closed");
        return false;
      }
      this.logger.warn("TURNSTILE_SECRET_KEY not set — skipping verification (development only)");
      return true;
    }

    try {
      const params = new URLSearchParams();
      params.set("secret", secret);
      params.set("response", token);
      if (ip) params.set("remoteip", ip);

      const res = await fetch(this.endpoint, { method: "POST", body: params });
      const body = (await res.json()) as TurnstileResponse;
      if (!body.success) {
        this.logger.warn({ codes: body["error-codes"], ip }, "Turnstile verification failed");
      }
      return body.success;
    } catch (err) {
      this.logger.error({ err, ip }, "Turnstile verification error");
      return false;
    }
  }
}
