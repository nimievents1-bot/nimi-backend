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

const SANS_STACK = `'Mulish', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const SERIF_STACK = `'Cormorant Garamond', Georgia, 'Times New Roman', serif`;

/**
 * Gift order email templates.
 *
 * Two audiences:
 *   1. Customer — receipt + tracking link
 *   2. Admin    — new paid order with everything needed to start
 *                 the design-approval workflow (PRD §7.4.5)
 *
 * Same shape and brand voice as `pastry-templates.ts`. Every template
 * returns `{ subject, html, text }` to match the existing mailer
 * contract.
 */

const fmtMoney = (minor: number, currency: string): string =>
  `${currency.toUpperCase()} ${(minor / 100).toFixed(2)}`;

const firstName = (full: string): string =>
  (full.trim().split(/\s+/)[0] ?? full).trim() || "there";

// ---------------------------------------------------------------------
// Customer receipt — fires immediately on paid checkout.
// ---------------------------------------------------------------------

interface GiftReceiptProps {
  customerName: string;
  reference: string;
  totalMinor: number;
  currency: string;
  /** Web-app deep-link to the customer's order detail page. */
  orderUrl: string;
}

export function giftOrderReceiptTemplate(props: GiftReceiptProps) {
  const greetingName = firstName(props.customerName);
  const total = fmtMoney(props.totalMinor, props.currency);

  const inner = `
    ${emailHeading("Thank you for your order.")}
    ${emailParagraph(`Hi ${greetingName},`)}
    ${emailParagraph(
      "Your gift order is in. Our team will prepare a design mock-up and send it through for your approval before we move into production.",
    )}
    ${emailPanel(`
      ${emailFact("Reference", props.reference)}
      <div style="margin-top:10px;">${emailFact("Total", total)}</div>
    `)}
    ${emailButton("View your order", props.orderUrl)}
    ${emailParagraph(
      "Lead times for made-to-order gifts run 6–10 weeks from design approval. We'll be in touch with the mock-up within a few working days.",
    )}
    <p style="margin:24px 0 0 0;font-family:${SERIF_STACK};font-style:italic;font-size:16px;color:${BRAND_COLOURS.maroon600};">With care,<br>The Nimi Events team</p>
  `;

  const text = `Hi ${greetingName},

Your gift order is in. Our team will prepare a design mock-up and send it through for your approval before we move into production.

Reference: ${props.reference}
Total:     ${total}

View your order: ${props.orderUrl}

Lead times for made-to-order gifts run 6–10 weeks from design approval. We'll be in touch with the mock-up within a few working days.

— The Nimi Events team`;

  return {
    subject: `Gift order ${props.reference} confirmed — Nimi Events`,
    html: emailShell(inner, {
      eyebrow: "Order confirmed",
      preheader: `${props.reference} — we'll send your design mock-up within a few working days.`,
    }),
    text,
  };
}

// ---------------------------------------------------------------------
// Admin notification — full payload so the kitchen can start work.
// ---------------------------------------------------------------------

interface GiftOrderItemSummary {
  collectionName: string;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  customisation?: {
    names?: string | null;
    dates?: string | null;
    colourTheme?: string | null;
    message?: string | null;
    logoUrl?: string | null;
  } | null;
}

interface GiftAdminProps {
  reference: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  totalMinor: number;
  currency: string;
  shippingLine1: string | null;
  shippingLine2: string | null;
  shippingCity: string | null;
  shippingPostcode: string | null;
  shippingCountry: string | null;
  notes: string | null;
  designApprovalAccepted: boolean;
  items: GiftOrderItemSummary[];
  adminUrl: string;
}

export function giftOrderAdminNotifyTemplate(props: GiftAdminProps) {
  const fmt = (m: number) => fmtMoney(m, props.currency);

  // Item rows include customisation right under the collection name so
  // the kitchen team can read the brief in one pass without clicking
  // through to the admin detail page.
  const itemRows = props.items
    .map((line) => {
      const cust = line.customisation;
      const custLines: string[] = [];
      if (cust?.names) custLines.push(`Names: ${escapeHtml(cust.names)}`);
      if (cust?.dates) custLines.push(`Dates: ${escapeHtml(cust.dates)}`);
      if (cust?.colourTheme) custLines.push(`Colour: ${escapeHtml(cust.colourTheme)}`);
      if (cust?.message) custLines.push(`Message: ${escapeHtml(cust.message)}`);
      if (cust?.logoUrl) {
        // Render the logo URL as a real anchor so the admin can
        // open it with one click from the order email. We still
        // escapeHtml the URL (defence-in-depth) and constrain it
        // to the href attribute — both the visible text and the
        // attribute go through escapeHtml so a maliciously crafted
        // URL can't break out of the tag.
        const safeUrl = escapeHtml(cust.logoUrl);
        custLines.push(
          `Logo: <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:${BRAND_COLOURS.maroon600};text-decoration:underline;">Open / download</a>`,
        );
      }
      const custBlock =
        custLines.length > 0
          ? `<div style="margin-top:4px;font-size:12px;color:${BRAND_COLOURS.neutral500};line-height:1.5;">${custLines.join("<br>")}</div>`
          : "";
      return `
        <tr>
          <td style="padding:10px;border-bottom:1px solid ${BRAND_COLOURS.cream200};font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral800};vertical-align:top;">
            <strong style="color:${BRAND_COLOURS.maroon600};">${line.quantity}×</strong> ${escapeHtml(line.collectionName)}
            ${custBlock}
          </td>
          <td align="right" style="padding:10px;border-bottom:1px solid ${BRAND_COLOURS.cream200};font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral500};vertical-align:top;white-space:nowrap;">
            ${fmt(line.unitPriceMinor)}
          </td>
          <td align="right" style="padding:10px;border-bottom:1px solid ${BRAND_COLOURS.cream200};font-family:${SANS_STACK};font-size:14px;color:${BRAND_COLOURS.neutral800};vertical-align:top;white-space:nowrap;">
            ${fmt(line.totalMinor)}
          </td>
        </tr>`;
    })
    .join("");

  const itemsTable = `
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:8px 0 16px 0;border:1px solid ${BRAND_COLOURS.cream200};">
      <thead>
        <tr style="background:${BRAND_COLOURS.cream100};">
          <th align="left" style="padding:8px 10px;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Collection</th>
          <th align="right" style="padding:8px 10px;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Unit</th>
          <th align="right" style="padding:8px 10px;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Line</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
  `;

  const addressLines = [
    props.shippingLine1,
    props.shippingLine2,
    [props.shippingCity, props.shippingPostcode]
      .filter((v): v is string => Boolean(v && v.length > 0))
      .join(" "),
    props.shippingCountry,
  ].filter((line): line is string => Boolean(line && line.length > 0));

  const addressBlock =
    addressLines.length > 0
      ? `<div style="font-family:${SANS_STACK};font-size:14px;line-height:1.65;color:${BRAND_COLOURS.neutral800};">${addressLines.map((l) => escapeHtml(l)).join("<br>")}</div>`
      : `<div style="font-family:${SANS_STACK};font-size:14px;font-style:italic;color:${BRAND_COLOURS.neutral500};">No address captured — the customer needs to add one before we can ship.</div>`;

  const notesBlock = props.notes
    ? `
      <div style="margin-top:14px;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.neutral500};">Notes from the customer</div>
      <div style="margin-top:4px;font-family:${SANS_STACK};font-size:14px;line-height:1.65;color:${BRAND_COLOURS.neutral800};white-space:pre-line;">${escapeHtml(props.notes)}</div>
    `
    : "";

  const inner = `
    ${emailHeading(`New gift order · ${escapeHtml(props.reference)}`)}
    ${emailParagraph(
      `${props.customerName} just paid for ${props.items.length} gift collection${props.items.length === 1 ? "" : "s"}. The order is in "Awaiting design approval" — the next step is to share a mock-up with the customer.`,
    )}

    ${emailPanel(`
      ${emailFact("Customer", props.customerName)}
      <div style="margin-top:8px;">${emailFact("Email", props.customerEmail)}</div>
      ${
        props.customerPhone
          ? `<div style="margin-top:8px;">${emailFact("Phone", props.customerPhone)}</div>`
          : ""
      }
      <div style="margin-top:8px;">${emailFact("Total paid", fmt(props.totalMinor))}</div>
      <div style="margin-top:8px;">${emailFact("Design approval accepted", props.designApprovalAccepted ? "Yes" : "No (check before proceeding)")}</div>
    `)}

    <div style="margin:18px 0 6px 0;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Items + customisation</div>
    ${itemsTable}

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

  const text = `New gift order — ${props.reference}

Customer: ${props.customerName} <${props.customerEmail}>${
    props.customerPhone ? ` · ${props.customerPhone}` : ""
  }

Items:
${props.items
  .map((line) => {
    const cust = line.customisation;
    const custParts: string[] = [];
    if (cust?.names) custParts.push(`names: ${cust.names}`);
    if (cust?.dates) custParts.push(`dates: ${cust.dates}`);
    if (cust?.colourTheme) custParts.push(`colour: ${cust.colourTheme}`);
    if (cust?.message) custParts.push(`message: ${cust.message}`);
    if (cust?.logoUrl) custParts.push(`logo: ${cust.logoUrl}`);
    return `  ${line.quantity}× ${line.collectionName} @ ${fmt(line.unitPriceMinor)} = ${fmt(line.totalMinor)}${custParts.length > 0 ? "\n     " + custParts.join("\n     ") : ""}`;
  })
  .join("\n")}

Total paid: ${fmt(props.totalMinor)}
Design approval accepted: ${props.designApprovalAccepted ? "Yes" : "No (check before proceeding)"}

Deliver to:
${addressLines.length > 0 ? addressLines.join("\n") : "No address captured."}
${props.notes ? `\nNotes from the customer:\n${props.notes}\n` : ""}
Open in admin: ${props.adminUrl}
Reply directly to this email — it goes straight to ${props.customerEmail}.

— Nimi Events`;

  return {
    subject: `New gift order ${props.reference} — ${props.customerName}`,
    html: emailShell(inner, {
      eyebrow: "New paid gift order",
      preheader: `${props.customerName} · ${fmt(props.totalMinor)} · ${props.items.length} collection${props.items.length === 1 ? "" : "s"}`,
    }),
    text,
  };
}
