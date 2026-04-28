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
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),
  COOKIE_DOMAIN: z.string().min(1).default("localhost"),

  WEB_ORIGIN: z
    .string()
    .min(1)
    .transform((s) => s.split(",").map((origin) => origin.trim())),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_VERSION: z.string().default("2024-09-30.acacia"),

  RESEND_API_KEY: z.string().optional(),
  RESEND_AUDIENCE_ID: z.string().optional(),

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
