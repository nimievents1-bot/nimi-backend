/**
 * Email templates — server-rendered plain HTML and text fallbacks.
 *
 * Newer templates (`passwordResetTemplate` and below) use the shared
 * `email-shell.ts` helpers so they match the brand design system used
 * by the pastry-order and Indulgence Club admin emails. Older templates
 * still use the local `baseStyle` block — they'll be ported the next
 * time we touch them.
 *
 * Every template returns:
 *   - subject line
 *   - HTML body
 *   - plain-text body (deliverability + a11y)
 *
 * No HTML coming in from variables is trusted: every variable is escaped
 * with `escape()` below before interpolation.
 */

import {
  BRAND_COLOURS,
  emailButton,
  emailHeading,
  emailParagraph,
  emailShell,
  escapeHtml as escapeHtmlShell,
} from "./email-shell";

const escapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "/": "&#x2F;",
};

const escape = (raw: string): string => raw.replace(/[&<>"'/]/g, (c) => escapeMap[c] ?? c);

const baseStyle = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #2C2620; background: #FBF7EB; margin: 0; padding: 24px; }
  .card { max-width: 560px; margin: 0 auto; background: #FFFFFF; padding: 32px;
          border: 1px solid #E6DBC1; border-radius: 0; }
  .brand { font-family: Georgia, serif; font-size: 22px; font-weight: 500;
           letter-spacing: 0.16em; text-transform: uppercase; color: #5C1F18; margin: 0 0 8px; }
  h1 { font-family: Georgia, serif; font-size: 26px; color: #5C1F18; margin: 16px 0 12px; font-weight: 500; }
  p { line-height: 1.65; margin: 0 0 14px; }
  .btn { display: inline-block; background: #5C1F18; color: #FBF7EB; padding: 12px 22px;
         text-decoration: none; font-family: Georgia, serif; font-style: italic; font-weight: 500; margin: 16px 0; }
  .muted { color: #7A6A52; font-size: 13px; }
  hr { border: none; border-top: 1px solid #E6DBC1; margin: 24px 0; }
`;

interface BaseProps {
  recipientName?: string;
}

interface VerifyEmailProps extends BaseProps {
  url: string;
}

export const verifyEmailTemplate = ({ recipientName, url }: VerifyEmailProps) => {
  const greeting = recipientName ? `Hello ${escape(recipientName)},` : "Hello,";
  return {
    subject: "Verify your email — Nimi Events",
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="card">
  <p class="brand">Nimi Events</p>
  <h1>One last step</h1>
  <p>${greeting}</p>
  <p>Confirm your email so we can keep your account secure.</p>
  <p><a class="btn" href="${escape(url)}">Verify email</a></p>
  <p class="muted">If the button doesn't work, paste this link into your browser:<br>${escape(url)}</p>
  <hr>
  <p class="muted">If you didn't create a Nimi Events account, you can ignore this email.</p>
</div></body></html>`,
    text: `${greeting}

Confirm your email so we can keep your account secure:
${url}

If you didn't create a Nimi Events account, you can ignore this email.

— Nimi Events`,
  };
};

interface PasswordResetProps extends BaseProps {
  url: string;
  ip?: string;
}

/**
 * Branded password reset email — rendered via the shared `email-shell`
 * helpers so it reads as part of the same design system as the
 * pastry-order and Indulgence Club emails. Inline-styled, table-based,
 * preheader-equipped so it survives Gmail/Outlook.
 */
export const passwordResetTemplate = ({ recipientName, url, ip }: PasswordResetProps) => {
  const greetingName = recipientName ? recipientName.trim().split(/\s+/)[0] ?? "there" : "there";

  const inner = `
    ${emailHeading("Reset your password")}
    ${emailParagraph(`Hi ${greetingName},`)}
    ${emailParagraph(
      "We received a request to reset the password for your Nimi Events account. The link below expires in 15 minutes.",
    )}
    ${emailButton("Reset password", url)}
    <p style="margin:12px 0 18px 0;font-family:'Mulish',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;color:${BRAND_COLOURS.neutral500};">
      Or paste this link into your browser:<br>
      <span style="color:${BRAND_COLOURS.maroon600};word-break:break-all;">${escapeHtmlShell(url)}</span>
    </p>
    ${ip ? emailParagraph(`Requested from IP: ${ip}`) : ""}
    <p style="margin:18px 0 0 0;font-family:'Mulish',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;color:${BRAND_COLOURS.neutral500};border-top:1px solid ${BRAND_COLOURS.cream200};padding-top:14px;">
      If you didn&rsquo;t request a password reset, you can safely ignore this email — your password won&rsquo;t change.
    </p>
  `;

  const ipText = ip ? `\n\nRequested from IP: ${ip}` : "";

  return {
    subject: "Reset your password — Nimi Events",
    html: emailShell(inner, {
      eyebrow: "Account security",
      preheader: "Reset your Nimi Events password. The link expires in 15 minutes.",
    }),
    text: `Hi ${greetingName},

We received a request to reset the password for your Nimi Events account. The link below expires in 15 minutes:
${url}${ipText}

If you didn't request a password reset, you can safely ignore this email — your password won't change.

— Nimi Events`,
  };
};

interface ContactAckProps {
  name: string;
  kind: string;
}

export const contactAckTemplate = ({ name, kind }: ContactAckProps) => {
  const subject =
    kind === "CATERING"
      ? "We've received your catering enquiry"
      : kind === "EVENTS"
      ? "We've received your event enquiry"
      : "We've received your message";
  return {
    subject: `${subject} — Nimi Events`,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="card">
  <p class="brand">Nimi Events</p>
  <h1>Thank you, ${escape(name)}.</h1>
  <p>We've received your enquiry and will reply within one working day.</p>
  <p>If your message is time-sensitive, you can also reach us at
     <a href="mailto:hello@nimievents.co.uk">hello@nimievents.co.uk</a>.</p>
  <hr>
  <p class="muted">— The Nimi Events team</p>
</div></body></html>`,
    text: `Thank you, ${name}.

We've received your enquiry and will reply within one working day. If your message is time-sensitive, reach us at hello@nimievents.co.uk.

— The Nimi Events team`,
  };
};

interface ContactNotifyProps {
  enquiryId: string;
  kind: string;
  name: string;
  email: string;
  phone?: string;
  notes: string;
  adminUrl: string;
}

export const contactNotifyTemplate = ({
  enquiryId,
  kind,
  name,
  email,
  phone,
  notes,
  adminUrl,
}: ContactNotifyProps) => {
  return {
    subject: `[${kind}] New enquiry from ${name}`,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="card">
  <p class="brand">Nimi Events · Admin</p>
  <h1>New ${escape(kind.toLowerCase())} enquiry</h1>
  <p><strong>${escape(name)}</strong> &lt;${escape(email)}&gt;</p>
  ${phone ? `<p>Phone: ${escape(phone)}</p>` : ""}
  <p style="white-space: pre-wrap;">${escape(notes)}</p>
  <p><a class="btn" href="${escape(adminUrl)}">Open in admin</a></p>
  <p class="muted">Enquiry id: ${escape(enquiryId)}</p>
</div></body></html>`,
    text: `New ${kind.toLowerCase()} enquiry from ${name} <${email}>
${phone ? `Phone: ${phone}\n` : ""}
${notes}

Open in admin: ${adminUrl}
Enquiry id: ${enquiryId}`,
  };
};
