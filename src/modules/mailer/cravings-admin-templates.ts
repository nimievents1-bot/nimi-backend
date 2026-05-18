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

/**
 * Admin notification for a new Indulgence Club subscription.
 *
 * Audience is the operator at `SUPPORT_INBOX` — the kitchen needs to
 * know a new subscriber has joined so they can:
 *   - confirm the address they need to ship monthly deliveries to
 *   - schedule the first welcome touchpoint
 *   - flag if the address is missing (and chase the customer)
 *
 * Reply-To points at the subscriber's email so a one-tap reply opens
 * a real conversation, same pattern as the paid-order admin email.
 *
 * Sent once per Stripe subscription id — idempotency lives in the
 * caller via an auditLog marker, identical to the welcome email.
 */
interface AdminSubscriptionStartedProps {
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  planName: string;
  monthlyAmountMinor: number;
  currency: string;
  /** First period end timestamp (renewal date). ISO string or null. */
  currentPeriodEnd: string | null;
  /** Default delivery address from the customer's profile. */
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    postcode: string | null;
    country: string | null;
  };
  /** Deep-link to the admin Indulgence Club subscribers page. */
  adminUrl: string;
}

const fmtMoney = (minor: number, currency: string): string =>
  `${currency.toUpperCase()} ${(minor / 100).toFixed(2)}`;

export function adminSubscriptionStartedTemplate(props: AdminSubscriptionStartedProps) {
  const total = fmtMoney(props.monthlyAmountMinor, props.currency);
  const renews = props.currentPeriodEnd
    ? new Date(props.currentPeriodEnd).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";

  // Address block — show whatever the customer has saved, and flag
  // when the address is missing so the operator knows they need to
  // chase the customer for it before the first delivery.
  const addressLines = [
    props.address.line1,
    props.address.line2,
    [props.address.city, props.address.postcode]
      .filter((v): v is string => Boolean(v && v.length > 0))
      .join(" "),
    props.address.country,
  ].filter((line): line is string => Boolean(line && line.length > 0));

  const addressBlock =
    addressLines.length > 0
      ? `<div style="font-family:${SANS_STACK};font-size:14px;line-height:1.65;color:${BRAND_COLOURS.neutral800};">${addressLines.map((l) => escapeHtml(l)).join("<br>")}</div>`
      : `<div style="font-family:${SANS_STACK};font-size:14px;font-style:italic;color:${BRAND_COLOURS.neutral500};">No address on file yet. The customer can add it on /account/profile — you may want to remind them before the first delivery.</div>`;

  const inner = `
    ${emailHeading("New Indulgence Club subscriber")}
    ${emailParagraph(`${props.customerName} just subscribed to ${props.planName}.`)}

    ${emailPanel(`
      ${emailFact("Customer", props.customerName)}
      <div style="margin-top:8px;">
        ${emailFact("Email", props.customerEmail)}
      </div>
      ${
        props.customerPhone
          ? `<div style="margin-top:8px;">${emailFact("Phone", props.customerPhone)}</div>`
          : ""
      }
      <div style="margin-top:8px;">
        ${emailFact("Plan", `${props.planName} · ${total}/month`)}
      </div>
      <div style="margin-top:8px;">
        ${emailFact("Next renewal", renews)}
      </div>
    `)}

    <div style="margin:18px 0 6px 0;font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND_COLOURS.maroon700};">Default delivery address</div>
    ${addressBlock}

    <div style="margin-top:24px;">
      ${emailButton("Open in admin", props.adminUrl)}
    </div>
    <p style="margin:8px 0 0 0;font-family:${SANS_STACK};font-size:13px;color:${BRAND_COLOURS.neutral500};">
      Reply directly to this email — it goes straight to ${escapeHtml(props.customerEmail)}.
    </p>
  `;

  const text = `New Indulgence Club subscriber

${props.customerName} just subscribed to ${props.planName}.

Customer:    ${props.customerName} <${props.customerEmail}>${
    props.customerPhone ? ` · ${props.customerPhone}` : ""
  }
Plan:        ${props.planName} · ${total}/month
Next renewal: ${renews}

Default delivery address:
${
    addressLines.length > 0
      ? addressLines.join("\n")
      : "No address on file yet. The customer can add it on /account/profile — you may want to remind them before the first delivery."
  }

Open in admin: ${props.adminUrl}
Reply directly to this email — it goes straight to ${props.customerEmail}.

— Nimi Events`;

  return {
    subject: `New subscription · ${props.customerName} → ${props.planName}`,
    html: emailShell(inner, {
      eyebrow: "New subscriber",
      preheader: `${props.customerName} · ${props.planName} · ${total}/month`,
    }),
    text,
  };
}
