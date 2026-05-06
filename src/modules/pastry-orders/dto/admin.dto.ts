import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

import { PastryOrderStatus } from "@prisma/client";

/**
 * Admin list filter — status + free-text search across reference, name,
 * email. Pagination uses the same shape we use elsewhere in admin lists.
 */
export class AdminListPastryOrdersQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  offset?: number;

  @IsOptional() @IsEnum(PastryOrderStatus)
  status?: PastryOrderStatus;

  @IsOptional() @IsString() @MaxLength(120)
  q?: string;
}

/**
 * Admin status transition. The service refuses backwards transitions
 * (e.g. DELIVERED → PREPARING) so this DTO doesn't need a `from` field —
 * we trust the current row state in the DB.
 */
export class UpdatePastryOrderStatusDto {
  @IsEnum(PastryOrderStatus)
  status!: PastryOrderStatus;

  /** Optional admin note attached to the audit log entry. */
  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

/** Admin notes are kept separate from the customer-visible `notes` field. */
export class UpdatePastryOrderNotesDto {
  @IsOptional() @IsString() @MaxLength(2_000)
  internalNotes?: string;
}
