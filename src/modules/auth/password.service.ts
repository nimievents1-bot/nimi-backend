import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";

/**
 * Argon2id password hashing.
 *
 * Parameters chosen to be slow on a single CPU core (~250-500ms per hash on
 * a modern x86), which keeps brute force expensive without making logins
 * unbearable. They can be tuned per-environment if needed.
 *
 * Argon2id is the OWASP-recommended algorithm as of 2024.
 */
@Injectable()
export class PasswordService {
  private readonly options: argon2.Options & { raw?: false } = {
    type: argon2.argon2id,
    memoryCost: 2 ** 16, // 64 MiB
    timeCost: 3,
    parallelism: 1,
  };

  hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, this.options);
  }

  /**
   * Constant-time compare — returns false on bad hashes rather than throwing,
   * because user-presented "is this string the password?" calls should never
   * leak whether the stored hash is malformed.
   */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext, this.options);
    } catch {
      return false;
    }
  }

  /**
   * Returns true if the existing hash uses parameters weaker than current.
   * Call after successful login to opportunistically upgrade.
   */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return true;
    }
  }
}
