import { createHash, randomBytes } from "node:crypto";

/**
 * Token utilities — used for refresh tokens, email verification tokens
 * and password reset tokens. The plaintext is sent to the user (in a
 * cookie or email URL); only the SHA-256 hash is persisted to the DB.
 *
 * This way: a database leak doesn't grant the attacker any usable tokens.
 */

/** 32 bytes of cryptographic randomness encoded as URL-safe base64. */
export function newSecureToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
