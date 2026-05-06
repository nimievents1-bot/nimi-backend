import { Type } from "class-transformer";
import { IsInt, IsString, Max, Min } from "class-validator";

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
