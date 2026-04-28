import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { getEnv } from "./config/env";

async function bootstrap(): Promise<void> {
  const env = getEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: 5 * 1024 * 1024, // 5MB
      genReqId: () =>
        // Lightweight request id — pino logger picks it up via the http hook.
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    }),
    {
      bufferLogs: true,
      // Required for Stripe webhook signature verification — keeps the raw
      // request body available on `req.rawBody` for routes that need it.
      rawBody: true,
    },
  );

  // Pino-based structured logging.
  app.useLogger(app.get(Logger));

  // ---- Security middleware ----
  await app.register(helmet, {
    // CSP for the API itself is minimal; the browser CSP is set by the web app.
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  // Cookie support — required for JWT access + refresh cookie flow.
  await app.register(cookie, { secret: env.JWT_SECRET });

  app.enableCors({
    origin: env.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
    exposedHeaders: ["X-Request-Id"],
    maxAge: 86400,
  });

  // ---- Global behaviour ----
  app.setGlobalPrefix("api", {
    exclude: ["healthz", "readyz", "webhooks/stripe"],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Graceful shutdown — flush logs, close DB, finish in-flight requests.
  app.enableShutdownHooks();

  // ---- OpenAPI (dev / staging only) ----
  if (env.NODE_ENV !== "production") {
    const swagger = new DocumentBuilder()
      .setTitle("Nimi Events API")
      .setDescription("Backend API for Nimi Events — catering, events, gifting, cravings.")
      .setVersion("1.0")
      .addCookieAuth("nimi_at")
      .build();
    const doc = SwaggerModule.createDocument(app, swagger);
    SwaggerModule.setup("api/docs", app, doc, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(env.PORT, "0.0.0.0");

  // eslint-disable-next-line no-console
  console.log(`[nimi-api] listening on :${env.PORT.toString()} (${env.NODE_ENV})`);
}

void bootstrap();
