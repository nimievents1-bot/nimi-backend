# nimi-api

Backend API for **Nimi Events** — catering, event planning, gifting, and the Pastry Cravings subscription.

Built with **NestJS 10**, **Fastify**, **Prisma + PostgreSQL**, **Redis**, and **TypeScript strict**. Self-contained — no monorepo, no shared workspace.

---

## Quickstart

```bash
# Prerequisites: Node 20+, pnpm 9+, Docker (for Postgres + Redis)
nvm use
cp .env.example .env

# Bring up Postgres + Redis (use docker compose if you have one;
# otherwise spin them up however you like)
docker run -d --name nimi-pg \
  -e POSTGRES_USER=nimi -e POSTGRES_PASSWORD=nimi -e POSTGRES_DB=nimi \
  -p 5432:5432 postgres:15
docker run -d --name nimi-redis -p 6379:6379 redis:7

pnpm install
pnpm db:generate                  # generate Prisma client
pnpm db:migrate                   # apply migrations to dev DB
pnpm dev                          # http://localhost:3001
```

Health check:

```bash
curl http://localhost:3001/healthz
curl http://localhost:3001/readyz   # checks DB connectivity
```

OpenAPI docs (development only): `http://localhost:3001/api/docs`

---

## Scripts

| Command              | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `pnpm dev`           | NestJS in watch mode on `:3001`                       |
| `pnpm build`         | Compile to `dist/`                                    |
| `pnpm start:prod`    | Run the built API                                     |
| `pnpm lint`          | ESLint, fail on warnings                              |
| `pnpm typecheck`     | `tsc --noEmit`                                        |
| `pnpm test`          | Vitest unit tests                                     |
| `pnpm test:cov`      | Coverage report (V8)                                  |
| `pnpm test:e2e`      | Integration tests (separate Vitest config)            |
| `pnpm db:generate`   | Generate Prisma client                                |
| `pnpm db:migrate`    | Run a dev migration                                   |
| `pnpm db:deploy`     | Apply migrations (CI / production)                    |
| `pnpm db:studio`     | Open Prisma Studio                                    |

---

## Project structure

```
nimi-api/
├── src/
│   ├── main.ts                       Bootstrap (Fastify + helmet + CORS + Swagger)
│   ├── app.module.ts                 Root module — Config, Logger, Throttler, Prisma, Health
│   ├── config/env.ts                 Zod-validated environment
│   ├── common/
│   │   └── filters/
│   │       └── all-exceptions.filter.ts   RFC 7807 error responses + audit logging
│   └── modules/
│       ├── prisma/                   Global Prisma client
│       └── health/                   /healthz · /readyz
├── prisma/
│   └── schema.prisma                 Foundation models (User, RefreshToken, AuditLog,
│                                     ContentBlock, Faq, Testimonial, GalleryImage,
│                                     NewsletterSubscriber)
├── test/
│   └── health.spec.ts                Smoke test
├── nest-cli.json
├── tsconfig.json / tsconfig.build.json
├── vitest.config.ts
└── .eslintrc.cjs
```

Modules added in subsequent phases per the implementation plan: `auth`, `content`, `catering`, `events`, `gifting`, `cravings`, `newsletter`, `blog`, `uploads`, `admin`, `webhooks`.

---

## Security defaults

The bootstrap is opinionated about safety. None of these should be removed without an architectural conversation.

- **Helmet** — sensible HTTP header defaults, including `cross-origin-resource-policy: cross-origin`.
- **CORS** — locked to `WEB_ORIGIN` (comma-separated allowlist), credentials enabled, no wildcards.
- **Global ValidationPipe** — `whitelist`, `forbidNonWhitelisted`, `transform`. Rejects unknown fields by default.
- **Global ThrottlerGuard** — three buckets out of the box (`default` 60/min, `auth` 5/min, `contact` 3/min). Per-route override via `@Throttle()`.
- **Global AllExceptionsFilter** — sanitised RFC 7807 responses, never leaks stack traces, logs with `requestId`.
- **Pino redaction** — passwords, tokens, cookies and authorization headers are stripped before any log line is written.
- **Versioned routes** — `/api/v1/...` by default, so breaking changes can ship as `/api/v2`.
- **Graceful shutdown** — `enableShutdownHooks()` ensures Prisma closes its pool on `SIGTERM`.

Auth (Argon2id, JWT cookies, refresh-token rotation, MFA) lands in **Phase 1** of the implementation plan.

---

## Environment variables

Validated at boot in `src/config/env.ts`. Missing or malformed values **crash the process** — preferable to silent defaults. See `.env.example` for the complete list.

Critical to set correctly before deploy:

- `JWT_SECRET` and `JWT_REFRESH_SECRET` — at least 32 bytes each, generated via `openssl rand -base64 32`.
- `WEB_ORIGIN` — comma-separated list of allowed origins. **Never** include `*`.
- `COOKIE_DOMAIN` — must match the host the cookie is set on.

---

## Logging and observability

- Pino structured logs to stdout. Pretty in development, JSON in production.
- Each request gets an id (Fastify `genReqId`) which is included in every log line and propagated as `X-Request-Id`.
- Health probes (`/healthz`, `/readyz`) bypass the rate limiter and the global API prefix so load balancers can hit them freely.

Sentry, Stripe webhook handlers and the audit log middleware are wired up in subsequent phases.

---

## Companion web app

The public web app lives in **`nimi-web/`** (separate folder, separate Git repo). It calls this API at `NEXT_PUBLIC_API_URL` from the browser and `INTERNAL_API_URL` from Server Components.

---

## Licence

Proprietary — © Nimi Events.
