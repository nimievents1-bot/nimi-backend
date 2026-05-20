import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import { type AddToCartDto, type UpdateCartItemDto } from "./dto/cart.dto";

interface CartLine {
  itemId: string;
  cartItemId: string;
  slug: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  unitPriceMinor: number;
  currency: string;
  quantity: number;
  lineTotalMinor: number;
  available: boolean;
}

interface CartView {
  lines: CartLine[];
  subtotalMinor: number;
  currency: string;
  creditBalanceMinor: number;
  /** Credit Indulgence members will use against this cart at checkout. */
  applicableCreditMinor: number;
  /** Final amount Stripe will charge after credits applied. */
  payableMinor: number;
  meetsMinimum: boolean;
}

/**
 * Minimum cart subtotal in minor units (£25). Enforced at checkout — the
 * cart can hold less while the customer is still building it, but the
 * checkout endpoint refuses to issue a Stripe session below this floor.
 *
 * Matches the customer-facing rule on `/cravings` ("Minimum order £25"),
 * which the operator committed to in the Indulgence Club rebrand.
 */
export const PASTRY_CART_MIN_MINOR = 2500;

/**
 * PastryCartService — backs the customer cart UI and feeds checkout.
 *
 * Each user has at most one open cart (1:1 by `userId`). We don't
 * persist prices on cart rows because we want the post-edit price to
 * apply automatically; instead we re-resolve the live PastryItem on
 * every read and surface the current line total.
 *
 * Auto-applied credit is computed (not stored) at read time — the
 * customer doesn't toggle "use credits" in v1. The operator decided
 * this in the chat: "auto-apply is fine".
 */
@Injectable()
export class PastryCartService {
  private readonly logger = new Logger(PastryCartService.name);

  constructor(private readonly db: PrismaService) {}

  // ---------- read ----------

  async getOrCreateCart(userId: string): Promise<{ id: string }> {
    const existing = await this.db.pastryCart.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (existing) return existing;
    return this.db.pastryCart.create({
      data: { userId },
      select: { id: true },
    });
  }

  /**
   * Build the customer-facing cart view. Joins line items against the
   * live PastryItem table to get current price + availability, sums
   * lines, and computes credit auto-application + Stripe payable amount.
   */
  async view(userId: string): Promise<CartView> {
    const cart = await this.db.pastryCart.findUnique({
      where: { userId },
      include: {
        items: { include: { pastryItem: true } },
      },
    });

    const balance = await this.creditBalance(userId);

    if (!cart) {
      return {
        lines: [],
        subtotalMinor: 0,
        currency: "gbp",
        creditBalanceMinor: balance,
        applicableCreditMinor: 0,
        payableMinor: 0,
        meetsMinimum: false,
      };
    }

    const lines: CartLine[] = cart.items.map((row) => {
      const item = row.pastryItem;
      return {
        itemId: item.id,
        cartItemId: row.id,
        slug: item.slug,
        name: item.name,
        description: item.description,
        imageUrl: item.imageUrl,
        unitPriceMinor: item.priceMinor,
        currency: item.currency,
        quantity: row.quantity,
        lineTotalMinor: item.priceMinor * row.quantity,
        available: item.available,
      };
    });

    const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    const applicableCreditMinor = Math.max(0, Math.min(balance, subtotalMinor));
    const payableMinor = Math.max(0, subtotalMinor - applicableCreditMinor);

    const currency = lines[0]?.currency ?? "gbp";

    return {
      lines,
      subtotalMinor,
      currency,
      creditBalanceMinor: balance,
      applicableCreditMinor,
      payableMinor,
      meetsMinimum: subtotalMinor >= PASTRY_CART_MIN_MINOR,
    };
  }

  // ---------- mutations ----------

  async addItem(userId: string, dto: AddToCartDto): Promise<CartView> {
    // Refuse if the item is hidden — admin removed it from sale and the
    // cart shouldn't be a back-door to keep it.
    const item = await this.db.pastryItem.findUnique({
      where: { id: dto.pastryItemId },
      select: { id: true, available: true },
    });
    if (!item) throw new NotFoundException("Pastry not found.");
    if (!item.available) {
      throw new BadRequestException("This item isn't currently available.");
    }

    const cart = await this.getOrCreateCart(userId);

    // Upsert by (cart, item). Quantity is added to existing if present.
    await this.db.pastryCartItem.upsert({
      where: {
        cartId_pastryItemId: { cartId: cart.id, pastryItemId: item.id },
      },
      create: {
        cartId: cart.id,
        pastryItemId: item.id,
        quantity: dto.quantity,
      },
      update: {
        quantity: { increment: dto.quantity },
      },
    });

    return this.view(userId);
  }

  /**
   * Bulk-add the contents of a localStorage-backed guest cart onto
   * the authenticated user's server cart. Called from the cart page
   * right after sign-in/sign-up, so the customer doesn't lose the
   * items they picked anonymously.
   *
   * Semantics:
   *   - Each presented line is added with `quantity` clamped to [1, 99].
   *     A line with an unknown or unavailable `pastryItemId` is silently
   *     skipped (we'd rather drop a stale item than 400 the whole sync).
   *   - When a line already exists on the server cart, the presented
   *     quantity is ADDED to the existing quantity — matching how
   *     `addItem` behaves and what most customers expect from "merge
   *     my anonymous cart into my account".
   *   - Idempotent on a per-line basis: re-running the sync with the
   *     same input doubles up the quantities (because we genuinely
   *     don't know whether the caller is retrying or topping up).
   *     Clients should clear localStorage after a successful sync to
   *     prevent re-syncing on the next visit.
   *
   * Returns the merged cart view so the page can render the result
   * without a second round-trip.
   */
  async bulkAdd(
    userId: string,
    lines: Array<{ pastryItemId: string; quantity: number }>,
  ): Promise<{ view: CartView; addedCount: number; skippedCount: number }> {
    if (!Array.isArray(lines) || lines.length === 0) {
      return { view: await this.view(userId), addedCount: 0, skippedCount: 0 };
    }

    // De-dupe by pastryItemId before hitting the DB — a malformed
    // payload with two lines for the same item is summed locally so
    // we issue a single upsert per item rather than racing them.
    const normalised = new Map<string, number>();
    for (const line of lines) {
      if (!line || typeof line.pastryItemId !== "string") continue;
      const qty = Math.max(0, Math.min(99, Math.floor(Number(line.quantity) || 0)));
      if (qty === 0) continue;
      normalised.set(
        line.pastryItemId,
        (normalised.get(line.pastryItemId) ?? 0) + qty,
      );
    }
    if (normalised.size === 0) {
      return { view: await this.view(userId), addedCount: 0, skippedCount: 0 };
    }

    const ids = Array.from(normalised.keys());
    const items = await this.db.pastryItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, available: true },
    });
    const availableIds = new Set(items.filter((i) => i.available).map((i) => i.id));

    const cart = await this.getOrCreateCart(userId);

    let addedCount = 0;
    let skippedCount = 0;
    for (const [pastryItemId, quantity] of normalised) {
      if (!availableIds.has(pastryItemId)) {
        // Stale / removed / hidden — drop the line. The client will
        // see this absence when the response view comes back.
        skippedCount += 1;
        continue;
      }
      await this.db.pastryCartItem.upsert({
        where: {
          cartId_pastryItemId: { cartId: cart.id, pastryItemId },
        },
        create: { cartId: cart.id, pastryItemId, quantity },
        update: { quantity: { increment: quantity } },
      });
      addedCount += 1;
    }

    return {
      view: await this.view(userId),
      addedCount,
      skippedCount,
    };
  }

  async updateItem(
    userId: string,
    cartItemId: string,
    dto: UpdateCartItemDto,
  ): Promise<CartView> {
    const row = await this.db.pastryCartItem.findUnique({
      where: { id: cartItemId },
      include: { cart: true },
    });
    if (!row) throw new NotFoundException();
    if (row.cart.userId !== userId) throw new ForbiddenException();

    await this.db.pastryCartItem.update({
      where: { id: cartItemId },
      data: { quantity: dto.quantity },
    });
    return this.view(userId);
  }

  async removeItem(userId: string, cartItemId: string): Promise<CartView> {
    const row = await this.db.pastryCartItem.findUnique({
      where: { id: cartItemId },
      include: { cart: true },
    });
    if (!row) return this.view(userId); // already removed — no-op
    if (row.cart.userId !== userId) throw new ForbiddenException();

    await this.db.pastryCartItem.delete({ where: { id: cartItemId } });
    return this.view(userId);
  }

  async clear(userId: string): Promise<CartView> {
    const cart = await this.db.pastryCart.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (cart) {
      await this.db.pastryCartItem.deleteMany({ where: { cartId: cart.id } });
    }
    return this.view(userId);
  }

  // ---------- internal ----------

  /**
   * Sum of CreditTransaction rows for the user. Mirrors the formula in
   * CravingsService — single source of truth for credit balance.
   */
  private async creditBalance(userId: string): Promise<number> {
    const result = await this.db.creditTransaction.aggregate({
      where: { userId },
      _sum: { amountMinor: true },
    });
    return result._sum.amountMinor ?? 0;
  }

  /** Used by the checkout service. Cleared on successful payment. */
  async clearForCheckout(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.db;
    const cart = await client.pastryCart.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (cart) {
      await client.pastryCartItem.deleteMany({ where: { cartId: cart.id } });
    }
  }
}
