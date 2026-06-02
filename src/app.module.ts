import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";

import { getEnv } from "./config/env";
import { AdminModule } from "./modules/admin/admin.module";
import { AuthModule } from "./modules/auth/auth.module";
import { JwtAuthGuard } from "./modules/auth/jwt-auth.guard";
import { RolesGuard } from "./modules/auth/roles.guard";
import { BlogModule } from "./modules/blog/blog.module";
import { ContactModule } from "./modules/contact/contact.module";
import { ContentModule } from "./modules/content/content.module";
import { CravingsModule } from "./modules/cravings/cravings.module";
import { CronModule } from "./modules/cron/cron.module";
import { GiftingModule } from "./modules/gifting/gifting.module";
import { HealthModule } from "./modules/health/health.module";
import { MailerModule } from "./modules/mailer/mailer.module";
import { NewsletterModule } from "./modules/newsletter/newsletter.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { PastriesModule } from "./modules/pastries/pastries.module";
import { ProfileModule } from "./modules/profile/profile.module";
import { PastryCartModule } from "./modules/pastry-cart/pastry-cart.module";
import { PastryOrdersModule } from "./modules/pastry-orders/pastry-orders.module";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { PromoCodesModule } from "./modules/promo-codes/promo-codes.module";
import { ServiceTiersModule } from "./modules/service-tiers/service-tiers.module";
import { ShippingModule } from "./modules/shipping/shipping.module";
import { SiteImagesModule } from "./modules/site-images/site-images.module";
import { SiteSettingsModule } from "./modules/site-settings/site-settings.module";
import { StripeModule } from "./modules/stripe/stripe.module";
import { TestimonialsModule } from "./modules/testimonials/testimonials.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";

/**
 * Root application module.
 *
 * Order of guards matters at the app level:
 *   1. ThrottlerGuard — enforces request rate limits.
 *   2. JwtAuthGuard   — extracts the user from the cookie (skipped on @Public()).
 *   3. RolesGuard     — enforces @Roles() metadata.
 *
 * NestJS runs APP_GUARD providers in the order they are registered, top-to-bottom.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: () => getEnv(),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: getEnv().LOG_LEVEL,
        transport:
          getEnv().NODE_ENV === "development"
            ? {
                target: "pino-pretty",
                options: { singleLine: true, colorize: true, translateTime: "SYS:HH:MM:ss" },
              }
            : undefined,
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "*.password",
            "*.passwordHash",
            "*.token",
            "*.refreshToken",
            "*.secret",
            "req.body.password",
            "req.body.token",
            "req.body.turnstileToken",
          ],
          censor: "[REDACTED]",
        },
        autoLogging: { ignore: (req) => req.url === "/healthz" || req.url === "/readyz" },
        customProps: () => ({ service: "nimi-api" }),
      },
    }),
    /**
     * Single global throttler. Earlier we layered three buckets ("default",
     * "auth", "contact") thinking each route would opt-in via @Throttle —
     * but @nestjs/throttler v6 actually applies *all* configured buckets to
     * every route by default unless explicitly skipped. That meant /auth/me
     * (no decorator) silently inherited the strictest bucket (contact: 3/min),
     * which broke session checks on every page navigation in production
     * because the account layout + page each call requireSessionUser → 2
     * /auth/me hits per render → 3-bucket exhausted after one navigation.
     *
     * The right model: one generous global default, and tighter per-route
     * limits via @Throttle on the few endpoints that actually need them
     * (login = 20/min, register/forgot/reset = 5/min, contact-form = 3/min).
     * Each per-route @Throttle REPLACES the default for that route, so
     * there's no cross-bucket interference.
     */
    ThrottlerModule.forRoot([
      { name: "default", ttl: 60_000, limit: 120 },
    ]),
    PrismaModule,
    StripeModule,
    MailerModule,
    HealthModule,
    AuthModule,
    ContactModule,
    NewsletterModule,
    ContentModule,
    GiftingModule,
    CravingsModule,
    BlogModule,
    TestimonialsModule,
    NotificationsModule,
    ProfileModule,
    PastriesModule,
    PastryCartModule,
    PastryOrdersModule,
    PromoCodesModule,
    ServiceTiersModule,
    ShippingModule,
    SiteImagesModule,
    SiteSettingsModule,
    AdminModule,
    CronModule,
    WebhooksModule,
    // Domain modules — added phase by phase:
    // UploadsModule.
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
