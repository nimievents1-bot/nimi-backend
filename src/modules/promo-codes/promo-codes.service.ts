import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, PromoCodeKind, type PromoCode } from "@prisma/client";
import { randomBytes } from "node:crypto";

import { PrismaService } from "../prisma/prisma.service";

/**
 * PromoCodesService — issue, validate, and atomically redeem one-shot
 * discount codes (birthday treats, welcome codes, hand-issued generic
 * codes, etc.).
 *
 * Design choices worth flagging up-front:
 *
 *   1. **Discount stacking semantics.** When a customer applies a promo
 *      AND has Indulgence credits AND the cart subtotal is paid via
 *      Stripe, the order of operations is:
 *
 *         payable = max(0, subtotal − promo − credit)
 *
 *      Promo is computed off the gross subtotal (so the customer always
 *      gets the full advertised percent off, even if credits would have
 *      covered most of the order). This is the friendlier reading and
 *      matches how customers expect "10% off" to behave.
 *
 *   2. **Atomic single-use.** Redemption uses an `updateMany` filtered
 *      on the current `redemptionsUsed` so two concurrent checkouts of
 *      the same code can never both succeed. If the matched-rows count
 *      is 0 after the update, we treat the redemption as failed and
 *      surface a friendly "already used" error instead of silently
 *      applying nothing.
 *
 *   3. **Code shape.** Birthday codes look like `BDAY-<firstname>-<rand5>`
 *      (uppercased, alnum). The firstname segment is purely cosmetic
 *      and the cryptographic entropy lives in the suffix — five base32
 *      characters = ~25 bits, more than enough for a 7-day single-use
 *      code with rate-limited validation. We strip vowels from the
 *      random segment so accidental dictionary words don't appear.
 */
@Injectable()
export class PromoCodesService {
  private readonly logger = new Logger(PromoCodesService.name);

  /**
   * Random alphabet for the unguessable code suffix. Vowels removed to
   * avoid accidental real words; 0/O and 1/I removed to avoid
   * customers mistyping `O`/`0` or `I`/`1` on small print.
   */
  private static readonly CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";

  /** Length of the random suffix on a generated code. */
  private static readonly CODE_SUFFIX_LENGTH = 5;

  constructor(private readonly db: PrismaService) {}

  // ---------- issuance ----------

  /**
   * Issue a single-use birthday code for the given user. The code is
   * persisted (caller must email it out) and returned. Idempotent on
   * (`userId`, kind=BIRTHDAY, `validUntil >= validFrom of new code`):
   * if the user already has an un-redeemed birthday code that's still
   * valid for at least 24 more hours, we return the existing one
   * rather than minting a duplicate. This makes the daily cron safe
   * to fire twice on the same UTC day without spamming.
   */
  async issueBirthdayCode(opts: {
    userId: string;
    firstName: string | null;
    percentOff: number;
    validDays: number;
    minSpendMinor?: number | null;
  }): Promise<PromoCode> {
    if (opts.percentOff < 1 || opts.percentOff > 100) {
      throw new BadRequestException(
        "Birthday percent-off must be between 1 and 100.",
      );
    }
    if (opts.validDays < 1 || opts.validDays > 60) {
      throw new BadRequestException(
        "Birthday validity window must be between 1 and 60 days.",
      );
    }

    const now = new Date();
    const validUntil = new Date(now.getTime() + opts.validDays * 24 * 60 * 60 * 1000);

    // Idempotency: prefer reusing a still-valid un-redeemed birthday
    // code for this user. We give a 24-hour grace so a code that's
    // about to expire isn't reissued (the customer would still see
    // the old code in their inbox).
    const reuseCutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const existing = await this.db.promoCode.findFirst({
      where: {
        userId: opts.userId,
        kind: PromoCodeKind.BIRTHDAY,
        redeemedAt: null,
        validUntil: { gt: reuseCutoff },
        redemptionsUsed: 0,
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return existing;

    // Try a few candidate codes — collisions are vanishingly unlikely
    // (the alphabet has > 14M permutations of length 5) but the unique
    // constraint will throw on the off-chance, so retry once or twice.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = this.composeBirthdayCode(opts.firstName);
      try {
        const row = await this.db.promoCode.create({
          data: {
            code,
            userId: opts.userId,
            kind: PromoCodeKind.BIRTHDAY,
            percentOff: opts.percentOff,
            minSpendMinor: opts.minSpendMinor ?? null,
            maxRedemptions: 1,
            redemptionsUsed: 0,
            validFrom: now,
            validUntil,
          },
        });
        return row;
      } catch (err) {
        // Unique-violation on `code` — retry. Anything else is fatal.
        if (this.isUniqueViolation(err, "code")) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    this.logger.error(
      { userId: opts.userId, lastError },
      "Failed to allocate birthday code after retries",
    );
    throw new Error("Could not allocate a unique birthday code — please retry.");
  }

  // ---------- validation (read-only preview) ----------

  /**
   * Read-only check used by the cart preview to show "code accepted —
   * £X off" before the customer commits to checkout. Returns the
   * resolved discount in minor units along with the matched PromoCode
   * row, or throws a typed BadRequest/NotFound the controller surfaces
   * directly to the customer. This call NEVER mutates state — that's
   * `redeem` below.
   */
  async preview(opts: {
    code: string;
    userId: string;
    subtotalMinor: number;
    currency: string;
  }): Promise<{ promo: PromoCode; discountMinor: number }> {
    const trimmed = opts.code.trim();
    if (!trimmed) {
      throw new BadRequestException("Please enter a promo code.");
    }
    // Codes are stored uppercase; treat the input as case-insensitive.
    const normalised = trimmed.toUpperCase();
    const promo = await this.db.promoCode.findUnique({ where: { code: normalised } });
    if (!promo) {
      throw new NotFoundException("That promo code wasn't recognised.");
    }

    const now = new Date();
    if (promo.validFrom > now) {
      throw new BadRequestException("That promo code isn't active yet.");
    }
    if (promo.validUntil <= now) {
      throw new BadRequestException("That promo code has expired.");
    }
    if (promo.userId && promo.userId !== opts.userId) {
      // Don't leak "this code belongs to someone else" — give the
      // same message as "not recognised" to avoid letting a customer
      // probe for valid codes belonging to others.
      throw new NotFoundException("That promo code wasn't recognised.");
    }
    if (promo.redemptionsUsed >= promo.maxRedemptions) {
      throw new BadRequestException("That promo code has already been used.");
    }
    if (promo.amountOffMinor != null && promo.currency &&
        promo.currency.toLowerCase() !== opts.currency.toLowerCase()) {
      throw new BadRequestException(
        "That promo code is for a different currency and can't be applied here.",
      );
    }
    if (promo.minSpendMinor && opts.subtotalMinor < promo.minSpendMinor) {
      const minPounds = (promo.minSpendMinor / 100).toFixed(2);
      throw new BadRequestException(
        `That promo code requires a minimum order of £${minPounds}.`,
      );
    }

    const discountMinor = this.computeDiscountMinor(promo, opts.subtotalMinor);
    return { promo, discountMinor };
  }

  // ---------- atomic redemption ----------

  /**
   * Atomically mark the promo as redeemed for this order. Uses an
   * `updateMany` filtered on the current `redemptionsUsed` count so
   * two concurrent checkouts of the same code can never both win
   * — exactly one will see a matched-rows count > 0. The other
   * receives a clean BadRequest the caller can surface to the
   * customer ("that code was just used elsewhere, please refresh").
   *
   * Note: this method MUST be called inside the same DB transaction as
   * the PastryOrder row create/update so a redemption can't outlive
   * its order. The caller passes its current `Prisma.TransactionClient`
   * via `tx`. If `tx` is omitted we use the top-level client —
   * acceptable only for back-office tooling that's not transactional.
   */
  async redeem(opts: {
    promoId: string;
    userId: string;
    orderRef: string;
    tx?: Prisma.TransactionClient;
  }): Promise<void> {
    const client = opts.tx ?? this.db;
    const result = await client.promoCode.updateMany({
      where: {
        id: opts.promoId,
        // Same guards as preview — re-check inside the atomic move so
        // a code that expired between preview and checkout isn't applied.
        validUntil: { gt: new Date() },
        // Single use enforced by counting un-used redemptions. The
        // `lt: maxRedemptions` predicate is the secret sauce: it's
        // evaluated atomically by the database against the row's
        // current state, so two concurrent updates can't both pass.
        redemptionsUsed: { lt: (await this.maxFor(opts.promoId, opts.tx)) ?? 1 },
        // User-bound codes can only be redeemed by their owner.
        OR: [{ userId: null }, { userId: opts.userId }],
        // Don't re-redeem a code already stamped as redeemed.
        redeemedAt: null,
      },
      data: {
        redemptionsUsed: { increment: 1 },
        redeemedAt: new Date(),
        redeemedOrderRef: opts.orderRef,
      },
    });
    if (result.count === 0) {
      // Either the code expired, was redeemed concurrently, or someone
      // else's order claimed the slot. Surface a friendly error.
      throw new BadRequestException(
        "That promo code is no longer available — it may have just been used or expired.",
      );
    }
  }

  /**
   * Compute the actual discount minor for this code at this subtotal.
   * Caps at subtotal so we never produce a negative payable amount.
   */
  computeDiscountMinor(promo: PromoCode, subtotalMinor: number): number {
    if (subtotalMinor <= 0) return 0;
    let raw = 0;
    if (promo.percentOff != null) {
      // Round DOWN so we never over-discount due to .5p edge cases.
      raw = Math.floor((subtotalMinor * promo.percentOff) / 100);
    } else if (promo.amountOffMinor != null) {
      raw = promo.amountOffMinor;
    } else {
      // Malformed row (no discount spec at all). Treat as zero discount
      // rather than throwing — admin can fix the row, the customer
      // shouldn't see a 500.
      return 0;
    }
    return Math.max(0, Math.min(raw, subtotalMinor));
  }

  // ---------- internals ----------

  /** Lookup `maxRedemptions` for the atomic redeem update. */
  private async maxFor(
    promoId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number | null> {
    const client = tx ?? this.db;
    const row = await client.promoCode.findUnique({
      where: { id: promoId },
      select: { maxRedemptions: true },
    });
    return row?.maxRedemptions ?? null;
  }

  /** Build a code like `BDAY-JANE-7Q2X9`. */
  private composeBirthdayCode(firstName: string | null): string {
    const segment = this.sanitiseNameSegment(firstName);
    const suffix = this.randomSuffix(PromoCodesService.CODE_SUFFIX_LENGTH);
    return segment ? `BDAY-${segment}-${suffix}` : `BDAY-${suffix}`;
  }

  /** Uppercase, strip non-A-Z, trim to 6 chars. Empty if not usable. */
  private sanitiseNameSegment(raw: string | null): string {
    if (!raw) return "";
    const cleaned = raw.toUpperCase().replace(/[^A-Z]/g, "");
    return cleaned.slice(0, 6);
  }

  /** Cryptographically random suffix from `CODE_ALPHABET`. */
  private randomSuffix(length: number): string {
    // Use rejection sampling so the alphabet's non-power-of-2 size
    // doesn't bias the output. We oversample then index into the
    // alphabet, retrying any byte that's outside the usable range.
    const alphabet = PromoCodesService.CODE_ALPHABET;
    const mask = nextPow2(alphabet.length) - 1;
    let out = "";
    while (out.length < length) {
      const buf = randomBytes(length * 2);
      for (let i = 0; i < buf.length && out.length < length; i += 1) {
        const idx = buf[i]! & mask;
        if (idx < alphabet.length) out += alphabet[idx];
      }
    }
    return out;
  }

  /**
   * Tolerant detector for "Prisma unique-constraint violation on
   * column X". Avoids importing Prisma's typed error namespace just
   * to do a structural check.
   */
  private isUniqueViolation(err: unknown, field: string): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: string; meta?: { target?: unknown } };
    if (e.code !== "P2002") return false;
    const target = e.meta?.target;
    if (typeof target === "string") return target.includes(field);
    if (Array.isArray(target)) return target.includes(field);
    return true; // unknown shape — assume yes; caller will retry once
  }
}

/** Next power of two ≥ n. Used to size the rejection-sampling mask. */
function nextPow2(n: number): number {
  let v = 1;
  while (v < n) v <<= 1;
  return v;
}
