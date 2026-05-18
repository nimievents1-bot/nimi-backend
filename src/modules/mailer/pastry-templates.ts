import {
  BRAND_COLOURS,
  emailButton,
  emailFact,
  emailHeading,
  emailPanel,
  emailParagraph,
  emailShell,
  escapeHtml,
} from "./email-shell";

const SERIF_STACK = `'Cormorant Garamond', Georgia, 'Times New Roman', serif`;
const SANS_STACK = `'Mulish', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;

/**
 * Pastry-order email templates.
 *
 * Three audiences:
 *   1. Customer — order confirmed (paid)
 *   2. Customer — status update (PREPARING / READY / SHIPPED / DELIVERED / CANCELLED)
 *   3. Admin    — new paid order notification
 *
 * Every template returns `{ subject, html, text }` to match the
 * existing mailer template contract.
 */

const fmtMoney = (minor: number, currency: string): string =>
  `${currency.toUpperCase()} ${(minor / 100).toFixed(2)}`;

const firstName = (full: string): string =>
  (full.trim().split(/\s+/)[0] ?? full).trim() || "there";

// ---------------------------------------------------------------------
// 1. Customer paid confirmation
// ---------------------------------------------------------------------

interface PastryOrderConfirmedProps {
  recipientName: string;
  reference: string;
  totalMinor: number;
  creditAppliedMinor?: number;
  /**
   * Birthday / promo-code discount applied in minor units. Surfaced
   * as a small "you saved X" line below the total so the customer
   * gets the satisfaction-of-discount moment in the inbox, mirroring
   * the breakdown on the order detail page.
   */
  promoDiscountMinor?: number;
  currency: string;
  orderUrl: string;
}

export function pastryOrderConfirmedTemplate(props: PastryOrderConfirmedProps) {
  const greetingName = firstName(props.recipientName);
  const totalDisplay =
    props.totalMinor === 0
      ? "Fully covered by Indulgence Credits"
      : fmtMoney(props.totalMinor, props.currency);
  const subject = `Order ${props.reference} confirmed — Nimi Events`;

  const inner = `
    ${emailHeading(`Thank you, ${greetingName}.`)}
    ${emailParagraph(
      "Your pastry order is in. We'll prepare it freshly and let you know the moment it leaves the kitchen.",
    )}
    ${emailPanel(`
      ${emailFact("Reference", props.reference)}
      <div style="margin-top:10px;">
        ${emailFact("Total", totalDisplay)}
      </div>
      ${
        (props.promoDiscountMinor ?? 0) > 0
          ? `<div style="margin-top:6px;color:${BRAND_COLOURS.orange700};font-size:13px;">Promo discount applied: −${fmtMoney(props.promoDiscountMinor ?? 0, props.currency)}</div>`
          : ""
      }
      ${
        (props.creditAppliedMinor ?? 0) > 0
          ? `<div style="margin-top:6px;color:${BRAND_COLOURS.neutral500};font-size:13px;">Indulgence Credit applied: ${fmtMoney(props.creditAppliedMinor ?? 0, props.currency)}</div>`
          : ""
      }
    `)}
    ${emailButton("View your order", props.orderUrl)}
    ${emailParagraph(
      "You'll get another note from us when the order moves to preparing, ready, or out for delivery. Replies to this email reach our kitchen team directly.",
    )}
    <p style="margin:24px 0 0 0;font-family:${SERIF_STACK};font-style:italic;font-size:16px;color:${BRAND_COLOURS.maroon600};">With care,<br>The Nimi Events team</p>
  `;

  const text = `Hi ${greetingName},

Your pastry order is in. We'll prepare it freshly and let you know the moment it leaves the kitchen.

Reference: ${props.reference}
Total:     ${totalDisplay}${
    (props.promoDiscountMinor ?? 0) > 0
      ? `
Promo discount applied: −${fmtMoney(props.promoDiscountMinor ?? 0, props.currency)}`
      : ""
  }${
    (props.creditAppliedMinor ?? 0) > 0
      ? `
Indulgence Credit applied: ${fmtMoney(props.creditAppliedMinor ?? 0, props.currency)}`
      : ""
  }

View your order: ${props.orderUrl}

You'll get another note from us when the order moves to preparing, ready, or out for delivery.

— The Nimi Events team`;

  return {
    subject,
    html: emailShell(inner, {
      eyebrow: "Order confirmed",
      preheader: `${props.reference} — we'll prepare it freshly and let you know when it's on its way.`,
    }),
    text,
  };
}

// ---------------------------------------------------------------------
// 2. Customer status update
// ---------------------------------------------------------------------

export type PastryOrderStatusForEmail =
  | "PREPARING"
  | "READY"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED";

interface PastryOrderStatusProps {
  recipientName: string;
  reference: string;
  status: PastryOrderStatusForEmail;
  orderUrl: string;
}

const STATUS_COPY: Record<
  PastryOrderStatusForEmail,
  { subject: string; eyebrow: string; heading: string; body: string }
> = {
  PREPARING: {
    subject: "We're preparing your order",
    eyebrow: "Preparing now",
    heading: "On the bench.",
    body: "Your order has moved into the kitchen. Our team is preparing it freshly — you'll hear from us again as soon as it's ready.",
  },
  READY: {
    subject: "Your order is ready",
    eyebrow: "Ready",
    heading: "Ready when you are.",
    body: "Your order is freshly prepared and ready. If we're delivering, the next note will be when it leaves us. If you're collecting, head over whenever it suits you.",
  },
  SHIPPED: {
    subject: "Your order is on its way",
    eyebrow: "On its way",
    heading: "Out for delivery.",
    body: "Your order has just left our kitchen. It'll be with you shortly — keep an eye on the door.",
  },
  DELIVERED: {
    subject: "Your order has arrived — enjoy",
    eyebrow: "Delivered",
    heading: "Enjoy every bite.",
    body: "Your order has been delivered. We hope it's everything you hoped for. Replies to this email reach our team directly — let us know how it landed.",
  },
  CANCELLED: {
    subject: "Your order has been cancelled",
    eyebrow: "Cancelled",
    heading: "Order cancelled.",
    body: "Your order has been cancelled. Any payment will be refunded to your original card within 5–10 business days, and any Indulgence Credits used are back on your balance.",
  },
};

export function pastryOrderStatusTemplate(props: PastryOrderStatusProps) {
  const copy = STATUS_COPY[props.status];
  const greetingName = firstName(props.recipientName);

  const inner = `
    ${emailHeading(copy.heading)}
    ${emailParagraph(`Hi ${greetingName},`)}
    ${emailParagraph(copy.body)}
    ${emailPanel(emailFact("Reference", props.reference))}
    ${emailButton("View your order", props.orderUrl)}
    <p style="margin:24px 0 0 0;font-family:${SERIF_STACK};font-style:italic;font-size:16px;color:${BRAND_COLOURS.maroon600};">With care,<br>The Nimi Events team</p>
  `;

  const text = `Hi ${greetingName},

${copy.body}

Reference: ${props.reference}
View your order: ${props.orderUrl}

— The Nimi Events team`;

  return {
    subject: `${copy.subject} — Nimi Events (${props.reference})`,
    html: emailShell(inner, {
      eyebrow: copy.eyebrow,
      preheader: `${props.reference}: ${copy.body.split(".")[0]}.`,
    }),
    text,
  };
}

// ---------------------------------------------------------------------
// 3. Admin paid-order notification
// ---------------------------------------------------------------------

interface PastryOrderAdminNotifyProps {
  reference: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  totalMinor: number;
  subtotalMinor: number;
  creditAppliedMinor: number;
  /** Birthday / promo-code discount applied in minor units (0 if none). */
  promoDiscountMinor?: number;
  /** Optional promo-code string for the admin to spot-check at a glance. */
  promoCode?: string | null;
  currency: string;
  shippingLine1: string;
  shippingLine2: string | null;
  shippingCity: string;
  shippingPostcode: string;
  shippingCountry: string;
  notes: string | null;
  items: Array<{
    name: string;
    quantity: number;
    unitPriceMinor: number;
    totalMinor: number;
  }>;
  adminUrl: string;
}

export function pastryOrderAdminNotifyTemplate(props: PastryOrderAdminNotifyProps) {
  const fmt = (m: number) => fmtMoney(m, props.currency);

  // Items table — uses inline borders + cell padding for cross-client
  // consistency. Header row picks up the cream-100 surface tone so it
  // visually steps down from the maroon brand band above.
  const itemRows = props.items
    .map(
      (line) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid ${BRAND_COLOURS.cream200};font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral800};">
          <strong style="color:${BRAND_COLOURS.maroon600};">${line.quantity}×</strong> ${escapeHtml(line.name)}
        </td>
        <td align="right" style="padding:8px 10px;border-bottom:1px solid ${BRAND_COLOURS.cream200};font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral500};">
          ${fmt(line.unitPriceMinor)}
        </td>
        <td align="right" style="padding:8px 10px;border-bottom:1px solid ${BRAND_COLOURS.cream200};font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral800};">
          ${fmt(line.totalMinor)}
        </td>
      </tr>`,
    )
    .join("");

  const itemsTable = `
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:8px 0 16px 0;border:1px solid ${BRAND_COLOURS.cream200};">
      <thead>
        <tr style="background:${BRAND_COLOURS.cream100};">
          <th align="left" style="padding:8px 10px;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Item</th>
          <th align="right" style="padding:8px 10px;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Unit</th>
          <th align="right" style="padding:8px 10px;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Line</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
  `;

  // Totals block — right-aligned key/value rows so the eye lands on
  // the bold total at the bottom.
  const totalsBlock = `
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:0 0 18px 0;">
      <tr>
        <td align="right" style="padding:2px 0;font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral500};">Subtotal</td>
        <td align="right" width="120" style="padding:2px 0;font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral800};">${fmt(props.subtotalMinor)}</td>
      </tr>
      ${
        (props.promoDiscountMinor ?? 0) > 0
          ? `<tr>
        <td align="right" style="padding:2px 0;font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral500};">Promo code${props.promoCode ? ` (${escapeHtml(props.promoCode)})` : ""}</td>
        <td align="right" style="padding:2px 0;font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.orange600};">−${fmt(props.promoDiscountMinor ?? 0)}</td>
      </tr>`
          : ""
      }
      ${
        props.creditAppliedMinor > 0
          ? `<tr>
        <td align="right" style="padding:2px 0;font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral500};">Indulgence Credit</td>
        <td align="right" style="padding:2px 0;font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.orange600};">−${fmt(props.creditAppliedMinor)}</td>
      </tr>`
          : ""
      }
      <tr>
        <td align="right" style="padding:6px 0 2px 0;font-family:${SERIF_STACK};font-size:18px;font-weight:500;color:${BRAND_COLOURS.maroon600};">Total paid</td>
        <td align="right" style="padding:6px 0 2px 0;font-family:${SERIF_STACK};font-size:20px;font-weight:600;color:${BRAND_COLOURS.maroon600};">${fmt(props.totalMinor)}</td>
      </tr>
    </table>
  `;

  const addressBlock = `
    <div style="font-family:${SANS_STACK};font-size:14px;line-height:1.65;color:${BRAND_COLOURS.neutral800};">
      <strong>${escapeHtml(props.customerName)}</strong>${
        props.customerPhone ? ` · ${escapeHtml(props.customerPhone)}` : ""
      }<br>
      ${escapeHtml(props.shippingLine1)}<br>
      ${props.shippingLine2 ? `${escapeHtml(props.shippingLine2)}<br>` : ""}
      ${escapeHtml(props.shippingCity)} ${escapeHtml(props.shippingPostcode)}<br>
      ${escapeHtml(props.shippingCountry)}
    </div>
  `;

  const notesBlock = props.notes
    ? `
    <div style="margin-top:14px;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.neutral500};">Notes for the kitchen</div>
    <div style="margin-top:4px;font-family:${SANS_STACK};font-size:14px;line-height:1.65;color:${BRAND_COLOURS.neutral800};white-space:pre-line;">${escapeHtml(props.notes)}</div>
  `
    : "";

  const inner = `
    ${emailHeading(`New order · ${escapeHtml(props.reference)}`)}
    ${emailParagraph(`${props.customerName} just paid for ${props.items.length} item${props.items.length === 1 ? "" : "s"}.`)}

    <div style="margin:18px 0 6px 0;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Items</div>
    ${itemsTable}
    ${totalsBlock}

    <div style="margin:6px 0 6px 0;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Deliver to</div>
    ${addressBlock}
    ${notesBlock}

    <div style="margin-top:24px;">
      ${emailButton("Open in admin", props.adminUrl)}
    </div>
    <p style="margin:8px 0 0 0;font-family:${SANS_STACK};font-size:13px;color:${BRAND_COLOURS.neutral500};">
      Reply directly to this email — it goes straight to ${escapeHtml(props.customerEmail)}.
    </p>
  `;

  const text = `New order — ${props.reference}

Customer: ${props.customerName} <${props.customerEmail}>${
    props.customerPhone ? ` · ${props.customerPhone}` : ""
  }

Items:
${props.items
  .map((line) => `  ${line.quantity}× ${line.name} @ ${fmt(line.unitPriceMinor)} = ${fmt(line.totalMinor)}`)
  .join("\n")}

Subtotal: ${fmt(props.subtotalMinor)}
${(props.promoDiscountMinor ?? 0) > 0 ? `Promo code${props.promoCode ? ` (${props.promoCode})` : ""}: −${fmt(props.promoDiscountMinor ?? 0)}\n` : ""}${props.creditAppliedMinor > 0 ? `Indulgence Credit: −${fmt(props.creditAppliedMinor)}\n` : ""}Total paid: ${fmt(props.totalMinor)}

Deliver to:
${props.shippingLine1}
${props.shippingLine2 ? `${props.shippingLine2}\n` : ""}${props.shippingCity} ${props.shippingPostcode}
${props.shippingCountry}
${props.notes ? `\nNotes for the kitchen:\n${props.notes}\n` : ""}
Open in admin: ${props.adminUrl}
Reply directly to this email — it goes straight to ${props.customerEmail}.

— Nimi Events`;

  return {
    subject: `New order ${props.reference} — ${props.customerName}`,
    html: emailShell(inner, {
      eyebrow: "New paid order",
      preheader: `${props.customerName} · ${fmt(props.totalMinor)} · ${props.items.length} item${props.items.length === 1 ? "" : "s"}`,
    }),
    text,
  };
}
