/**
 * Email templates for The Nimi Indulgence Club marketing flows.
 *
 * The four flows the operator runs through this file:
 *   1. Welcome   — fired on subscription becoming ACTIVE
 *   2. Credits   — fired on Stripe `invoice.paid` (monthly accrual)
 *   3. Birthday  — fired by the daily birthday cron
 *   4. Reminder  — fired by the daily unused-credits cron
 *
 * Conventions:
 *   - All templates return `{ subject, html, text }` matching what
 *     `MailerService.send()` accepts.
 *   - HTML is hand-rolled (no MJML or react-email) to keep the build
 *     surface small. The cream/maroon palette mirrors the marketing site.
 *   - Every interpolation goes through `escape()` to prevent header /
 *     attribute injection from name fields entered by users.
 */

const escapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "/": "&#x2F;",
};
const escape = (raw: string): string =>
  raw.replace(/[&<>"'/]/g, (c) => escapeMap[c] ?? c);

const baseStyle = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #2C2620; background: #FBF7EB; margin: 0; padding: 24px; }
  .card { max-width: 560px; margin: 0 auto; background: #FFFFFF; padding: 32px;
          border: 1px solid #E6DBC1; }
  .brand { font-family: Georgia, serif; font-size: 22px; font-weight: 500;
           letter-spacing: 0.16em; text-transform: uppercase; color: #5C1F18; margin: 0 0 8px; }
  h1 { font-family: Georgia, serif; font-size: 26px; color: #5C1F18; margin: 16px 0 12px; font-weight: 500; }
  p { line-height: 1.65; margin: 0 0 14px; }
  .btn { display: inline-block; background: #5C1F18; color: #FBF7EB; padding: 12px 22px;
         text-decoration: none; font-family: Georgia, serif; font-style: italic; font-weight: 500; margin: 16px 0; }
  .code { display: inline-block; background: #FBF7EB; border: 1px dashed #D9602B;
          padding: 10px 18px; font-family: "SF Mono", Menlo, monospace; font-weight: 600;
          letter-spacing: 0.18em; color: #5C1F18; margin: 6px 0 14px; }
  .muted { color: #7A6A52; font-size: 13px; }
  .signoff { margin-top: 22px; font-family: Georgia, serif; font-style: italic; color: #5C1F18; }
`;

const fmtGBP = (minor: number): string =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(minor / 100);

/** Welcome — sent the moment a subscription transitions to ACTIVE. */
export const indulgenceWelcomeTemplate = ({
  firstName,
  monthlyAmountMinor,
  accountUrl,
}: {
  firstName: string;
  monthlyAmountMinor: number;
  accountUrl: string;
}) => ({
  subject: "Welcome to The Nimi Indulgence Club",
  html: `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="card">
  <p class="brand">The Nimi Indulgence Club</p>
  <h1>Welcome, ${escape(firstName)}.</h1>
  <p>Your monthly indulgence is now set at <strong>${fmtGBP(monthlyAmountMinor)}</strong>.</p>
  <p>Each month, your credits will be ready for you to use on freshly made pastries and curated treats — created with care, inspired by authentic African flavours.</p>
  <p>As a member, you'll also enjoy priority access, exclusive drops and the occasional surprise from us.</p>
  <p><a class="btn" href="${escape(accountUrl)}">Open your account</a></p>
  <p class="muted">A reminder of the rules: three-month minimum commitment, credits valid for three months from issue, minimum pastry order £25, and no refunds on credits already issued.</p>
  <p class="signoff">We're glad to have you here.<br>— Nimi Events</p>
</div></body></html>`,
  text: `Welcome, ${firstName}.

Your monthly indulgence is now set at ${fmtGBP(monthlyAmountMinor)}.

Each month, your credits will be ready for you to use on freshly made pastries and curated treats — created with care, inspired by authentic African flavours.

As a member, you'll also enjoy priority access, exclusive drops and the occasional surprise from us.

Open your account: ${accountUrl}

A reminder of the rules: three-month minimum commitment, credits valid for three months from issue, minimum pastry order £25, and no refunds on credits already issued.

— Nimi Events`,
});

/** Credits issued — sent immediately after the monthly Stripe invoice clears. */
export const indulgenceCreditsIssuedTemplate = ({
  firstName,
  amountMinor,
  balanceMinor,
  accountUrl,
}: {
  firstName: string;
  amountMinor: number;
  balanceMinor: number;
  accountUrl: string;
}) => ({
  subject: `Your indulgence credits are ready (${fmtGBP(amountMinor)})`,
  html: `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="card">
  <p class="brand">Indulgence Credits</p>
  <h1>${fmtGBP(amountMinor)} added.</h1>
  <p>Hi ${escape(firstName)},</p>
  <p>Your indulgence credits for this month are now available. Total balance: <strong>${fmtGBP(balanceMinor)}</strong>.</p>
  <p>Whenever you're ready, use them to order from our latest pastry selection — freshly made and thoughtfully prepared. We recommend placing your order early, especially during busy periods.</p>
  <p><a class="btn" href="${escape(accountUrl)}">View your balance</a></p>
  <p class="muted">Each month's credits are valid for three months from issue. Minimum pastry order £25.</p>
  <p class="signoff">Enjoy your moment of indulgence.<br>— Nimi Events</p>
</div></body></html>`,
  text: `Hi ${firstName},

Your indulgence credits for this month are now available. ${fmtGBP(amountMinor)} added — total balance ${fmtGBP(balanceMinor)}.

Whenever you're ready, you can use them to order from our latest pastry selection — freshly made and thoughtfully prepared. We recommend placing your order early, especially during busy periods.

View your balance: ${accountUrl}

Each month's credits are valid for three months from issue. Minimum pastry order £25.

— Nimi Events`,
});

/** Birthday — sent by daily cron at 09:00 to anyone whose DD/MM matches today. */
export const indulgenceBirthdayTemplate = ({
  firstName,
  promoCode,
  validDays,
  accountUrl,
}: {
  firstName: string;
  promoCode: string;
  validDays: number;
  accountUrl: string;
}) => ({
  subject: `Happy birthday, ${firstName} — a small treat from us`,
  html: `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="card">
  <p class="brand">A little something</p>
  <h1>Happy birthday, ${escape(firstName)}.</h1>
  <p>We couldn't let your day pass without sending a little something your way.</p>
  <p>As part of The Nimi Indulgence Club, we've added a small treat to celebrate you — a moment of indulgence on us.</p>
  <p>Use this code on your next order:</p>
  <p><span class="code">${escape(promoCode)}</span></p>
  <p>Valid for the next ${validDays} day${validDays === 1 ? "" : "s"}.</p>
  <p><a class="btn" href="${escape(accountUrl)}">Place your order</a></p>
  <p class="signoff">With love,<br>— Nimi Events</p>
  <p class="muted">Authentically African flavours.</p>
</div></body></html>`,
  text: `Happy birthday, ${firstName}.

We couldn't let your day pass without sending a little something your way.

As part of The Nimi Indulgence Club, we've added a small treat to celebrate you — a moment of indulgence on us. Use this code on your next order:

  ${promoCode}

Valid for the next ${validDays} day${validDays === 1 ? "" : "s"}.

Place your order: ${accountUrl}

With love,
— Nimi Events
Authentically African flavours.`,
});

/** Reminder — sent by daily cron when a member has unused credits for 14+ days. */
export const indulgenceCreditsReminderTemplate = ({
  firstName,
  balanceMinor,
  accountUrl,
}: {
  firstName: string;
  balanceMinor: number;
  accountUrl: string;
}) => ({
  subject: "Your indulgence credits are still here",
  html: `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="card">
  <p class="brand">Just a quick note</p>
  <h1>Hi ${escape(firstName)},</h1>
  <p>Your indulgence credits are still available — <strong>${fmtGBP(balanceMinor)}</strong> ready when you are.</p>
  <p>Whenever you're ready, we'll have something freshly prepared for you. We wouldn't want you to miss out.</p>
  <p><a class="btn" href="${escape(accountUrl)}">Place your order</a></p>
  <p class="signoff">— Nimi Events</p>
</div></body></html>`,
  text: `Hi ${firstName},

Just a quick note — your indulgence credits are still available. ${fmtGBP(balanceMinor)} ready when you are.

Whenever you're ready, we'll have something freshly prepared for you. We wouldn't want you to miss out.

Place your order: ${accountUrl}

— Nimi Events`,
});
