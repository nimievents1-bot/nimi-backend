import { type CookieSerializeOptions } from "@fastify/cookie";

import { getEnv } from "../../config/env";

import { ACCESS_COOKIE, REFRESH_COOKIE } from "./types";

/**
 * Cookie helpers — single place to set or clear access + refresh cookies.
 *
 * Defaults are paranoid (httpOnly always; Secure in production), but the
 * `sameSite` and `domain` fields adapt to the deployment topology:
 *
 *   Production (Vercel frontend ↔ Railway backend, different origins):
 *     sameSite=None + Secure (required for cross-site cookies; without
 *     these the browser silently drops the Set-Cookie header).
 *     `domain` is intentionally omitted so the cookie attaches to the
 *     response host (the API's domain) — setting an explicit domain that
 *     doesn't match the response host causes the browser to reject the
 *     cookie outright.
 *
 *   Development (everything on localhost, same-site):
 *     sameSite=Lax + non-Secure (works over HTTP without browser warnings).
 *
 * The COOKIE_DOMAIN env var is honoured ONLY when explicitly set to a
 * non-`localhost` value AND we're not in production cross-site mode —
 * useful if you ever serve frontend and API from the same parent domain
 * (e.g. `app.nimievents.co.uk` and `api.nimievents.co.uk`), in which case
 * setting COOKIE_DOMAIN=`.nimievents.co.uk` lets cookies be shared.
 *
 * Refresh cookie is restricted to the /auth path so it isn't sent on every
 * request — only on /auth/refresh and /auth/logout.
 */

const isProd = (): boolean => getEnv().NODE_ENV === "production";

/**
 * Resolve a domain value safe to put in the cookie. Returns `undefined`
 * when no domain should be set — that lets the browser default to the
 * response host, which is what we want when the frontend and backend are
 * on unrelated domains.
 */
function resolveDomain(): string | undefined {
  const env = getEnv();
  const raw = env.COOKIE_DOMAIN.trim();
  // The default value (`localhost`) is only meaningful in development.
  // Setting `domain=localhost` in production is a no-op at best and a
  // browser rejection at worst, so we drop it.
  if (!raw || raw === "localhost") return undefined;
  return raw;
}

const baseCookie = (): CookieSerializeOptions => {
  const domain = resolveDomain();
  return {
    httpOnly: true,
    secure: isProd(),
    sameSite: isProd() ? "none" : "lax",
    path: "/",
    ...(domain ? { domain } : {}),
  };
};

export const accessCookieOptions = (): CookieSerializeOptions => ({
  ...baseCookie(),
  maxAge: getEnv().JWT_ACCESS_TTL,
});

export const refreshCookieOptions = (): CookieSerializeOptions => ({
  ...baseCookie(),
  path: "/api/v1/auth",
  maxAge: getEnv().JWT_REFRESH_TTL,
});

export const expiredCookieOptions = (path: string): CookieSerializeOptions => ({
  ...baseCookie(),
  path,
  maxAge: 0,
});

export { ACCESS_COOKIE, REFRESH_COOKIE };
