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
import { GiftingModule } from "./modules/gifting/gifting.module";
import { HealthModule } from "./modules/health/health.module";
import { MailerModule } from "./modules/mailer/mailer.module";
import { NewsletterModule } from "./modules/newsletter/newsletter.module";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { StripeModule } from "./modules/stripe/stripe.module";
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
    ThrottlerModule.forRoot([
      { name: "default", ttl: 60_000, limit: 60 },
      { name: "auth", ttl: 60_000, limit: 5 },
      { name: "contact", ttl: 60_000, limit: 3 },
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
    AdminModule,
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
