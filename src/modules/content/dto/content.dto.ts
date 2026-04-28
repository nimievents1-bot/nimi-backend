import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from "class-validator";

import { ALLOWED_PAGES } from "../blocks";

/**
 * UpsertContentBlockDto — create-or-update a draft block.
 *
 * The `payload` is validated separately by the controller against the
 * Zod discriminated union from `blocks.ts`. We keep `payload` as
 * `Record<string, unknown>` here so class-validator doesn't try to
 * recurse into it — Zod is the right tool for the discriminated union.
 */
export class UpsertContentBlockDto {
  @IsString() @IsIn(ALLOWED_PAGES as readonly string[])
  page!: string;

  @IsString() @MaxLength(80)
  key!: string;

  @IsOptional() @IsString() @Length(2, 12)
  locale?: string;

  @IsString() @MaxLength(40)
  type!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class PublishContentBlockDto {
  @IsString() @MaxLength(50)
  blockId!: string;
}
