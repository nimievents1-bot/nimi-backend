import { IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

/**
 * Key format: letters (either case) and digits, optionally
 * dot- or hyphen-segmented. E.g. `hero.home`, `services.catering`,
 * `gifting.softLuxe`, `catering.family-style`.
 *
 * Why case-insensitive: the web registry mixes lowercase (most
 * keys) with camelCase for legacy compatibility with the existing
 * `images.ts` library (`gifting.softLuxe`, `catering.familyStyle`,
 * etc.). Forcing strict lowercase would break those entries.
 * The dot/hyphen segmentation is a soft convention that lets the
 * admin UI group keys by their leading segment — it shapes
 * presentation, not validation.
 */
const KEY_REGEX = /^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*$/;

/**
 * Body for `PUT /v1/admin/site-images/:key`. Upsert semantics:
 *   - First call for a key → INSERT
 *   - Subsequent calls    → UPDATE
 * No `key` field on the DTO itself — it comes from the URL.
 */
export class UpsertSiteImageDto {
  /**
   * Absolute https URL of the override image. We accept any
   * remote URL (not just R2) so the operator can paste a Cloudinary,
   * Imgix or even Unsplash URL if they prefer. The standard path is
   * a fresh upload to R2 via the existing `/api/upload/image`
   * pipeline — the admin UI does that automatically.
   */
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  url!: string;

  /**
   * Optional alt text. Null means "fall back to the code-level alt
   * for this slot". Bounded at 240 chars — alt text should be a
   * short description, not a paragraph.
   */
  @IsOptional()
  @IsString()
  @MaxLength(240)
  alt?: string | null;
}

/**
 * Validates a key passed as a URL parameter. We don't want the
 * controller to accept arbitrary strings — a malformed key could
 * pollute the table and frustrate the admin UI's grouping logic.
 */
export function isValidSiteImageKey(key: string): boolean {
  return (
    typeof key === "string" &&
    key.length >= 2 &&
    key.length <= 120 &&
    KEY_REGEX.test(key)
  );
}

/**
 * Helper type matching the row shape we return on reads. Public
 * controller serialises rows to this exact shape; admin controller
 * adds `updatedAt` / `updatedBy` for the audit column.
 */
export interface PublicSiteImageDto {
  key: string;
  url: string;
  alt: string | null;
}

