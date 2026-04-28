/**
 * Newsletter-specific email templates.
 * Kept separate from the auth/contact templates for clarity.
 */
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
          border: 1px solid #E6DBC1; }
  .brand { font-family: Georgia, serif; font-size: 22px; font-weight: 500;
           letter-spacing: 0.16em; text-transform: uppercase; color: #5C1F18; margin: 0 0 8px; }
  h1 { font-family: Georgia, serif; font-size: 26px; color: #5C1F18; margin: 16px 0 12px; font-weight: 500; }
  p { line-height: 1.65; margin: 0 0 14px; }
  .btn { display: inline-block; background: #5C1F18; color: #FBF7EB; padding: 12px 22px;
         text-decoration: none; font-family: Georgia, serif; font-style: italic; font-weight: 500; margin: 16px 0; }
  .muted { color: #7A6A52; font-size: 13px; }
`;

export const newsletterConfirmTemplate = ({ url }: { url: string }) => ({
  subject: "Confirm your newsletter subscription — Nimi Events",
  html: `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="card">
  <p class="brand">Nimi Events</p>
  <h1>Confirm your subscription</h1>
  <p>Thanks for signing up. Please confirm to start receiving our newsletter.</p>
  <p><a class="btn" href="${escape(url)}">Confirm subscription</a></p>
  <p class="muted">If the button doesn't work, paste this link into your browser:<br>${escape(url)}</p>
  <p class="muted">If you didn't sign up, simply ignore this email.</p>
</div></body></html>`,
  text: `Thanks for signing up. Please confirm to start receiving our newsletter:
${url}

If you didn't sign up, simply ignore this email.

— Nimi Events`,
});
