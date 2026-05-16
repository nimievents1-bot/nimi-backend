import { type Role } from "@prisma/client";

/**
 * Shape of the user object hung off the request after JWT validation.
 * Kept narrow on purpose: never expose passwordHash, token state, etc.
 *
 * `name` is included because the web app's session-aware UI renders the
 * user's first name on /account and the full name on admin panels. We
 * fetch it on every validate() rather than baking it into the JWT so a
 * profile-name change shows up immediately without re-issuing tokens.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  emailVerifiedAt: Date | null;
}

/**
 * Cookie names. Centralised so we never typo them between
 * the controller, the strategy and the logout handler.
 */
export const ACCESS_COOKIE = "nimi_at";
export const REFRESH_COOKIE = "nimi_rt";

/** Authorisation events — used in audit log entries. */
export const AUTH_EVENTS = {
  REGISTER: "auth.register",
  LOGIN_OK: "auth.login.success",
  LOGIN_FAIL: "auth.login.failure",
  LOGIN_LOCKED: "auth.login.locked",
  LOGOUT: "auth.logout",
  REFRESH_OK: "auth.refresh.success",
  REFRESH_REUSE: "auth.refresh.reuse-detected",
  VERIFY_REQUEST: "auth.verify-email.request",
  VERIFY_OK: "auth.verify-email.success",
  RESET_REQUEST: "auth.password-reset.request",
  RESET_OK: "auth.password-reset.success",
} as const;
