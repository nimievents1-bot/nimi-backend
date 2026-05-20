import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

/**
 * `pastryItemId` is the database id (uuid) — not the slug. The cart
 * never trusts client-supplied prices; it always recomputes from the
 * latest PastryItem row at read/checkout time, so price drift between
 * "added to cart" and "checked out" is the customer's benefit if the
 * price went up, and we never overcharge if it went down.
 */
export class AddToCartDto {
  @IsString()
  pastryItemId!: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(50)
  quantity!: number;
}

export class UpdateCartItemDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(50)
  quantity!: number;
}

/**
 * One line in a bulk-sync payload coming from the localStorage guest
 * cart. The shape intentionally mirrors `AddToCartDto` so the client
 * can build the payload by copying the same line objects the rest of
 * the codebase already understands.
 */
export class BulkCartLineDto {
  @IsString()
  pastryItemId!: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(99)
  quantity!: number;
}

/**
 * Payload for `POST /pastry-cart/items/bulk` — sync the contents of
 * an anonymous visitor's guest cart into their newly-authenticated
 * server cart. The 50-line cap is a defensive sanity bound; a real
 * cart never approaches it.
 */
export class BulkAddDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkCartLineDto)
  items!: BulkCartLineDto[];
}
