import { z } from "zod";

/**
 * Environment configuration — validated at boot.
 *
 * Any missing or malformed value crashes the process before
 * a single request is served. This is deliberate: failing fast
 * on misconfiguration is far safer than silently defaulting.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().url(),
  SHADOW_DATABASE_URL: z.string().url().optional(),

  // Redis is reserved for distributed rate limiting and BullMQ queues. Until
  // those are wired up, the throttler runs in-memory and the API can boot
  // without a Redis service attached. Set it once you spin up Redis.
  REDIS_URL: z.string().url().optional(),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 chars"),

  /**
   * Access token TTL in seconds. Default 24 hours.
   * The proxy in the web app silently refreshes the access token using
   * the refresh cookie when it expires, so this value mostly governs
   * how often that refresh dance happens during continuous use — not
   * how long a user can stay signed in.
   */
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(86_400),

  /**
   * Refresh token TTL in seconds. Default 10 years.
   * The operator explicitly wants sessions that never time out: a
   * customer who doesn't sign out should not be logged out. Every
   * refresh rotates the token forward, so as long as the user comes
   * back inside this window (10 years is effectively forever for a
   * small business app), they stay signed in indefinitely. Sign-out
   * is the only path that ends a session.
   *
   * Trade-off: a stolen refresh cookie remains valid until the user
   * signs out or you rotate JWT_REFRESH_SECRET. Refresh-token-reuse
   * detection (in refresh.service.ts) still bumps the entire family
   * if the same token is presented twice, which is the actual
   * defence against theft.
   */
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(315_360_000),

  COOKIE_DOMAIN: z.string().min(1).default("localhost"),

  /**
   * Comma-separated list of allowed CORS origins. This list answers the
   * question "who is allowed to call the API from the browser?" — it may
   * legitimately contain preview deploys, staging, www-prefixed and bare
   * variants, etc. Order is NOT meaningful and MUST NOT be used to build
   * user-facing URLs (use WEB_PUBLIC_URL for that — see below).
   */
  WEB_ORIGIN: z
    .string()
    .min(1)
    .transform((s) => s.split(",").map((origin) => origin.trim()).filter(Boolean)),

  /**
   * The canonical, customer-facing public URL of the web app. Used to
   * build absolute links inside transactional emails (verify, reset,
   * receipts, admin notifications, etc.). MUST be a single URL — never
   * a Vercel preview, never with a trailing slash.
   *
   * Falls back to `WEB_ORIGIN[0]` only for backwards-compat with older
   * deploys that haven't set this yet; new environments should always
   * set WEB_PUBLIC_URL explicitly to avoid the "first CORS origin
   * accidentally became the public URL" footgun.
   */
  WEB_PUBLIC_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, ""))
    .optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_VERSION: z.string().default("2024-09-30.acacia"),

  RESEND_API_KEY: z.string().optional(),
  RESEND_AUDIENCE_ID: z.string().optional(),

  // Shared secret presented in the `x-cron-secret` header by the scheduler
  // that triggers daily flows (birthday emails, unused-credit reminders).
  // 32+ chars recommended. If unset, the cron endpoints refuse all calls
  // — preventing accidental triggering before the operator has wired up a
  // scheduler. Generate with `openssl rand -hex 32`.
  CRON_SECRET: z.string().min(16).optional(),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_URL: z.string().url().optional(),

  TURNSTILE_SECRET_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),

  SUPPORT_INBOX: z.string().email().default("hello@nimievents.co.uk"),
  NOREPLY_INBOX: z.string().email().default("noreply@nimievents.co.uk"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    /* eslint-disable no-console */
    console.error("\n[nimi-api] Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    console.error("");
    /* eslint-enable no-console */
    throw new Error("Refusing to boot with invalid environment.");
  }

  cached = parsed.data;
  return cached;
}

/**
 * The canonical public URL of the customer-facing web app. Use this —
 * never `WEB_ORIGIN[0]` — when building user-facing links inside emails,
 * webhooks, redirect Locations, or anything a real human will click.
 *
 *   - Preferred source: WEB_PUBLIC_URL (a single canonical URL)
 *   - Backwards-compatible fallback: the first entry of WEB_ORIGIN.
 *     This is fragile (CORS lists are reorderable and may include
 *     preview URLs) — kept only so existing deploys don't 500 before
 *     the operator can set WEB_PUBLIC_URL.
 *   - Dev fallback: http://localhost:3000 keeps the boot path quiet
 *     when nothing has been configured yet.
 *
 * Never returns a trailing slash. Safe to concatenate with paths
 * starting in `/`.
 */
export function publicWebUrl(): string {
  const env = getEnv();
  const raw = env.WEB_PUBLIC_URL ?? env.WEB_ORIGIN[0] ?? "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}
