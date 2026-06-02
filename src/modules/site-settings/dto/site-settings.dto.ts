import { IsString, MaxLength } from "class-validator";

/**
 * Key format identical to `SiteImage`: letters (either case) and
 * digits, optionally dot- or hyphen-segmented. See the doc comment
 * on `SiteImage`'s regex for why we accept camelCase as well as
 * lowercase — the web registries mix both, and forcing one would
 * break legacy keys.
 */
const KEY_REGEX = /^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*$/;

/**
 * Body for `PUT /v1/admin/site-settings/:key`.
 *
 * Only one field — the value itself. Empty string is allowed and
 * meaningful (e.g. "clear the pill text so it doesn't render"); the
 * admin UI distinguishes "empty value" from "no override" by
 * showing a Reset button on rows where an override exists.
 */
export class UpsertSiteSettingDto {
  /**
   * The editable string. 8000-char cap matches the practical limit
   * for hand-edited copy — long enough for a paragraph, short enough
   * that a misplaced paste of an entire article surfaces as a
   * validation error rather than silently bloating the table.
   */
  @IsString()
  @MaxLength(8000)
  value!: string;
}

export function isValidSiteSettingKey(key: string): boolean {
  return (
    typeof key === "string" &&
    key.length >= 2 &&
    key.length <= 120 &&
    KEY_REGEX.test(key)
  );
}

export interface PublicSiteSettingDto {
  key: string;
  value: string;
}
