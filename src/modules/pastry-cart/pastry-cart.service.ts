import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PastryOrderStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

import { type AddToCartDto, type UpdateCartItemDto } from "./dto/cart.dto";

/**
 * Order statuses that still occupy kitchen capacity for the day they
 * were placed. PENDING_PAYMENT is intentionally INCLUDED — once the
 * customer is in Stripe Checkout we treat them as committed; if they
 * drop the session a separate auto-cancel job clears the row. Including
 * PENDING_PAYMENT here prevents two customers from both successfully
 * checking out for the same last unit during the ~15 minutes between
 * "redirected to Stripe" and "webhook confirmed paid".
 */
const BATCH_OCCUPYING_STATUSES: PastryOrderStatus[] = [
  PastryOrderStatus.PENDING_PAYMENT,
  PastryOrderStatus.PAID,
  PastryOrderStatus.PREPARING,
  PastryOrderStatus.READY,
  PastryOrderStatus.SHIPPED,
];

/**
 * Compute the UTC instant for "start of today" in the kitchen's
 * timezone (Europe/London). Handles BST/GMT transitions correctly by
 * sampling the actual London offset at the candidate instant rather
 * than hardcoding +0/+1. Used to bucket orders into a single calendar
 * day for the per-item batch-limit check.
 *
 * Edge cases:
 *   - On DST transition days (last Sunday of March / October) the
 *     bracket is still 24h wide measured as wall-clock; orders placed
 *     during the 01:00 ambiguity collapse onto one side and don't
 *     double-count for capacity.
 */
function londonStartOfTodayUtc(now: Date): Date {
  // "YYYY-MM-DD" representing today in London local time.
  const londonDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
  }).format(now);

  // Treat that date string as a literal UTC instant first — correct
  // in winter (GMT, offset 0), one hour late in summer (BST, offset +1).
  const fakeUtcMidnight = new Date(`${londonDateStr}T00:00:00Z`);

  // Read back the hour as London would render it. That hour value
  // equals the offset between UTC and London at this point in the year.
  const londonHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).format(fakeUtcMidnight),
  );

  // Correct backwards by that offset to get the actual UTC instant of
  // London midnight. In GMT (londonHour=0) this is a no-op; in BST
  // (londonHour=1) we subtract an hour so the bracket starts at the
  // correct moment.
  return new Date(fakeUtcMidnight.getTime() - londonHour * 60 * 60 * 1000);
}

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
  /** Minimum order quantity for this item (1 = no minimum). */
  minQuantity: number;
  /** Kitchen daily cap for this item, NULL if no cap. */
  batchLimit: number | null;
  /**
   * Units of this item already committed for today (sum of quantity
   * across this customer's other open orders + every other customer's
   * orders today). Used by the UI to render "only X left today" hints.
   * Always 0 when `batchLimit` is null because the math is irrelevant.
   */
  bookedToday: number;
  /** `quantity >= minQuantity`. False blocks checkout. */
  meetsMinimum: boolean;
  /**
   * `bookedToday + quantity <= batchLimit` (or true when there's no
   * cap). False blocks checkout AND surfaces a "too many for today"
   * warning in the cart UI.
   */
  withinBatch: boolean;
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
  /** Subtotal meets the £25 floor. */
  meetsMinimum: boolean;
  /**
   * Every line carries at least its item's `minQuantity`. False
   * disables the checkout button — the cart page rendering surfaces
   * which line is short.
   */
  meetsAllItemMinimums: boolean;
  /**
   * Every line fits inside its item's daily batch cap (accounting for
   * orders already on the books for today). False disables checkout
   * — the cart page surfaces the offending line.
   */
  withinAllBatchLimits: boolean;
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
        meetsAllItemMinimums: true,
        withinAllBatchLimits: true,
      };
    }

    // Bulk-fetch booked-today totals for every distinct item in the
    // cart. Single `groupBy` query keeps this O(1) round trips
    // regardless of cart size — important because the cart `view()`
    // is read by every cart-page render, every add/update mutation,
    // and every page-load that mounts the header cart indicator.
    const itemIds = cart.items.map((row) => row.pastryItemId);
    const bookedTodayMap = await this.bookedTodayByItem(itemIds);

    // OPEN orders belonging to THIS user shouldn't double-count when
    // we're checking their own cart's batch headroom — otherwise a
    // customer who has an order in PENDING_PAYMENT and revisits the
    // cart would be told "no capacity" against their own occupied
    // slot. We subtract the user's own current contribution per item.
    const userOwnBooked = await this.bookedTodayByItemForUser(userId, itemIds);

    const lines: CartLine[] = cart.items.map((row) => {
      const item = row.pastryItem;
      const bookedAllUsers = bookedTodayMap.get(item.id) ?? 0;
      const bookedThisUser = userOwnBooked.get(item.id) ?? 0;
      // Headroom = total taken today MINUS what this user already
      // accounts for in committed orders. The cart line "owns" the
      // remaining capacity from its user's perspective.
      const bookedForOthers = Math.max(0, bookedAllUsers - bookedThisUser);
      const meetsMinimum = row.quantity >= item.minQuantity;
      const withinBatch =
        item.batchLimit === null || bookedForOthers + row.quantity <= item.batchLimit;
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
        minQuantity: item.minQuantity,
        batchLimit: item.batchLimit,
        bookedToday: bookedForOthers,
        meetsMinimum,
        withinBatch,
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
      meetsAllItemMinimums: lines.every((l) => l.meetsMinimum),
      withinAllBatchLimits: lines.every((l) => l.withinBatch),
    };
  }

  /**
   * Sum of unit quantities ordered today (Europe/London calendar
   * day) for each of the given pastry items, across all customers,
   * across all batch-occupying statuses. Returns a map keyed by
   * pastryItemId — items with no orders today are absent from the
   * map (caller defaults to 0).
   *
   * Implementation note: we filter on the parent PastryOrder's
   * `createdAt` rather than the child PastryOrderItem's — guests
   * see today's submitted orders, but the kitchen's actual
   * production day for an item equals (orderCreatedAt +
   * leadTimeDays). Since `leadTimeDays` is constant per item, the
   * partition "same kitchen day" simplifies exactly to "same
   * createdAt calendar day".
   */
  private async bookedTodayByItem(
    itemIds: string[],
  ): Promise<Map<string, number>> {
    if (itemIds.length === 0) return new Map();
    const dayStart = londonStartOfTodayUtc(new Date());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const grouped = await this.db.pastryOrderItem.groupBy({
      by: ["pastryItemId"],
      where: {
        pastryItemId: { in: itemIds },
        order: {
          createdAt: { gte: dayStart, lt: dayEnd },
          status: { in: BATCH_OCCUPYING_STATUSES },
        },
      },
      _sum: { quantity: true },
    });

    const out = new Map<string, number>();
    for (const row of grouped) {
      if (row.pastryItemId) out.set(row.pastryItemId, row._sum.quantity ?? 0);
    }
    return out;
  }

  /** Same as `bookedTodayByItem` but filtered to a single user. */
  private async bookedTodayByItemForUser(
    userId: string,
    itemIds: string[],
  ): Promise<Map<string, number>> {
    if (itemIds.length === 0) return new Map();
    const dayStart = londonStartOfTodayUtc(new Date());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const grouped = await this.db.pastryOrderItem.groupBy({
      by: ["pastryItemId"],
      where: {
        pastryItemId: { in: itemIds },
        order: {
          userId,
          createdAt: { gte: dayStart, lt: dayEnd },
          status: { in: BATCH_OCCUPYING_STATUSES },
        },
      },
      _sum: { quantity: true },
    });

    const out = new Map<string, number>();
    for (const row of grouped) {
      if (row.pastryItemId) out.set(row.pastryItemId, row._sum.quantity ?? 0);
    }
    return out;
  }

  // ---------- mutations ----------

  async addItem(userId: string, dto: AddToCartDto): Promise<CartView> {
    // Refuse if the item is hidden — admin removed it from sale and the
    // cart shouldn't be a back-door to keep it.
    const item = await this.db.pastryItem.findUnique({
      where: { id: dto.pastryItemId },
      select: {
        id: true,
        name: true,
        available: true,
        minQuantity: true,
        batchLimit: true,
      },
    });
    if (!item) throw new NotFoundException("Pastry not found.");
    if (!item.available) {
      throw new BadRequestException("This item isn't currently available.");
    }

    const cart = await this.getOrCreateCart(userId);

    // Find any existing cart line for this item so we can compute the
    // final quantity (existing + new) and validate it against the
    // item's rules. The PastryCartItem unique-by-(cartId, itemId)
    // index means at most one row exists per pairing.
    const existing = await this.db.pastryCartItem.findUnique({
      where: { cartId_pastryItemId: { cartId: cart.id, pastryItemId: item.id } },
      select: { quantity: true },
    });
    const finalQty = (existing?.quantity ?? 0) + dto.quantity;

    // ---- Minimum order quantity ----
    // The minimum applies to the LINE total, not the individual add
    // action. So a customer can do "add 4, add 3" to reach a minimum
    // of 6 — only the final state needs to clear the floor. We only
    // enforce here for the "add" path so the cart UI can show the
    // minimum-not-met banner before checkout for partial states.
    // (Server-side checkout guard catches anything that slipped past.)

    // ---- Daily batch cap ----
    if (item.batchLimit !== null) {
      const totalToday = await this.bookedTodayByItem([item.id]);
      const userToday = await this.bookedTodayByItemForUser(userId, [item.id]);
      const bookedForOthers = Math.max(
        0,
        (totalToday.get(item.id) ?? 0) - (userToday.get(item.id) ?? 0),
      );
      const remaining = item.batchLimit - bookedForOthers;
      if (finalQty > remaining) {
        const left = Math.max(0, remaining);
        throw new BadRequestException(
          left === 0
            ? `Sorry — ${item.name} is fully booked for today. Try again tomorrow or pick a different item.`
            : `Only ${left} ${item.name} left for today. Drop the quantity to ${left} or less and try again.`,
        );
      }
    }

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
      select: {
        id: true,
        available: true,
        minQuantity: true,
        batchLimit: true,
      },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Pull today's batch-occupancy in a single round trip for every
    // item being synced. We need this to clamp guest quantities down
    // to whatever is still available so a stale localStorage cart
    // doesn't get sized to over-capacity once the customer signs in.
    const totalToday = await this.bookedTodayByItem(ids);
    const userToday = await this.bookedTodayByItemForUser(userId, ids);

    const cart = await this.getOrCreateCart(userId);

    let addedCount = 0;
    let skippedCount = 0;
    for (const [pastryItemId, quantity] of normalised) {
      const item = itemById.get(pastryItemId);
      if (!item || !item.available) {
        // Stale / removed / hidden — drop the line. The client will
        // see this absence when the response view comes back.
        skippedCount += 1;
        continue;
      }

      // Bump up to the item's minimum if the guest cart was sized
      // below it (most often happens when the admin set a minimum
      // AFTER the customer started shopping anonymously). Better to
      // arrive at the cart with a viable quantity than to silently
      // drop the line.
      let finalQty = Math.max(quantity, item.minQuantity);

      // Clamp down to today's batch headroom. Capped items honour
      // available capacity at sync time — a customer with 50 in their
      // guest cart but only 8 left for today walks away with 8 in
      // their account cart and can pick more another day. If 0 are
      // available, drop the line (better than adding an invalid one
      // that immediately fails the cart view).
      if (item.batchLimit !== null) {
        const bookedForOthers = Math.max(
          0,
          (totalToday.get(item.id) ?? 0) - (userToday.get(item.id) ?? 0),
        );
        const remaining = item.batchLimit - bookedForOthers;
        if (remaining <= 0) {
          skippedCount += 1;
          continue;
        }
        finalQty = Math.min(finalQty, remaining);
      }

      // After clamping we may have undershot the minimum (capacity
      // remaining < minQuantity). In that case there's no valid
      // quantity to add — skip the line and let the customer try
      // again tomorrow.
      if (finalQty < item.minQuantity) {
        skippedCount += 1;
        continue;
      }

      await this.db.pastryCartItem.upsert({
        where: {
          cartId_pastryItemId: { cartId: cart.id, pastryItemId },
        },
        create: { cartId: cart.id, pastryItemId, quantity: finalQty },
        // For existing lines we ADD the synced quantity (matching the
        // pre-existing semantics). We don't re-validate min/batch
        // here against the post-add total because the cart view at
        // the end will surface any violations and the checkout guard
        // catches them server-side. Over-adding here would be
        // user-hostile (their guest cart was lost as a result of
        // signing in, not their goal).
        update: { quantity: { increment: finalQty } },
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
      include: {
        cart: true,
        pastryItem: {
          select: {
            id: true,
            name: true,
            minQuantity: true,
            batchLimit: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException();
    if (row.cart.userId !== userId) throw new ForbiddenException();

    const item = row.pastryItem;

    // ---- Batch cap check ----
    // Only "increase" mutations can violate this; if the customer is
    // dropping their quantity, headroom only grows. We still check on
    // any change because the math is cheap and consistent.
    if (item.batchLimit !== null) {
      const totalToday = await this.bookedTodayByItem([item.id]);
      const userToday = await this.bookedTodayByItemForUser(userId, [item.id]);
      const bookedForOthers = Math.max(
        0,
        (totalToday.get(item.id) ?? 0) - (userToday.get(item.id) ?? 0),
      );
      const remaining = item.batchLimit - bookedForOthers;
      if (dto.quantity > remaining) {
        const left = Math.max(0, remaining);
        throw new BadRequestException(
          left === 0
            ? `Sorry — ${item.name} is fully booked for today.`
            : `Only ${left} ${item.name} left for today. Drop the quantity to ${left} or less.`,
        );
      }
    }

    // Note: we deliberately don't reject `quantity < minQuantity` here
    // — the customer might be on their way to a multi-step adjustment
    // (e.g. lowering one item to free budget for another). The cart
    // page renders the "below minimum" hint, and the server-side
    // checkout guard refuses to issue a Stripe session until every
    // line is at or above its minimum.

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
