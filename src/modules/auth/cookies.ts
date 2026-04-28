import { type CookieSerializeOptions } from "@fastify/cookie";

import { getEnv } from "../../config/env";

import { ACCESS_COOKIE, REFRESH_COOKIE } from "./types";

/**
 * Cookie helpers — single place to set or clear access + refresh cookies.
 *
 * Defaults are paranoid: httpOnly + Secure + SameSite=Strict, path=/, domain
 * locked to the configured COOKIE_DOMAIN. Refresh cookie is restricted to the
 * /auth path so it's not sent on every request.
 */

const isProd = (): boolean => getEnv().NODE_ENV === "production";

const baseCookie = (): CookieSerializeOptions => ({
  httpOnly: true,
  secure: isProd(),
  sameSite: "strict",
  domain: getEnv().COOKIE_DOMAIN,
  path: "/",
});

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
