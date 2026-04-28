import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { getEnv } from "../../config/env";

/**
 * Symmetric encryption helper for MFA secrets at rest.
 *
 * Strategy:
 *   - Key = SHA-256 of `JWT_SECRET || "mfa-key-v1"` (domain-separated so a
 *     compromised JWT secret doesn't immediately leak MFA secrets).
 *   - AES-256-GCM with a fresh 12-byte IV per record.
 *   - Stored format: base64( iv || authTag || ciphertext ).
 *
 * The user.totpSecret column stores the base64 ciphertext; encrypting at
 * the application layer means a DB dump alone doesn't yield TOTP secrets.
 */
const ALGORITHM = "aes-256-gcm";
const KEY_PURPOSE = "mfa-key-v1";

function key(): Buffer {
  return createHash("sha256")
    .update(getEnv().JWT_SECRET)
    .update(KEY_PURPOSE)
    .digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(packed: string): string {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
