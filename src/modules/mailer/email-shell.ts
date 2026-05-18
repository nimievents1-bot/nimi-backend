/**
 * Brand-aligned email shell.
 *
 * Email clients are hostile rendering targets — `<style>` tags get
 * stripped (Gmail), web fonts are silently dropped (most mobile mail
 * apps), flexbox/grid are unreliable (Outlook), and `border-radius`
 * doesn't render on older Outlook either. So every visual decision
 * here is conservative:
 *
 *   - Layout is built with `<table>`s, not divs.
 *   - Every style is inline (we never use `<style>` blocks).
 *   - Fonts fall back to system serif / sans serif because Cormorant
 *     Garamond and Mulish won't load in most clients — the brand
 *     voice survives through Georgia for headings + a humanist
 *     sans-serif stack for body, which preserves the editorial
 *     feeling reasonably well.
 *   - Square edges (no border-radius) — brand decision documented
 *     in the design system file.
 *   - A "preheader" line is included as visually-hidden text so the
 *     inbox preview shows a custom sentence rather than the literal
 *     start of the email body.
 *
 * Brand colour tokens are mirrored from `tailwind.config.ts` /
 * `design-system.html` so the email feels of-a-piece with the web app:
 *   cream-50  #FBF7EB  page background
 *   paper     #FFFFFF  card surface
 *   cream-200 #E6DBC1  hairlines
 *   maroon-600 #5C1F18 display headings
 *   maroon-700 #92381A button hover (we don't have hover here, used for accents)
 *   orange-600 #C2611E secondary accent
 *   neutral-800 #2C2620 body text
 *   neutral-500 #7A6A52 muted / metadata
 */

export const BRAND_COLOURS = {
  cream50: "#FBF7EB",
  cream100: "#F5EDD8",
  cream200: "#E6DBC1",
  paper: "#FFFFFF",
  maroon600: "#5C1F18",
  maroon700: "#92381A",
  orange500: "#E48039",
  orange600: "#C2611E",
  orange700: "#A4501B",
  neutral800: "#2C2620",
  neutral500: "#7A6A52",
} as const;

const SERIF_STACK = `'Cormorant Garamond', Georgia, 'Times New Roman', serif`;
const SANS_STACK = `'Mulish', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;

const escapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

export const escapeHtml = (raw: string): string =>
  raw.replace(/[&<>"']/g, (c) => escapeMap[c] ?? c);

interface ShellOptions {
  /** Visually-hidden preview text the inbox client surfaces in the
   *  preview pane. Keep it under ~120 characters; longer text is
   *  truncated. */
  preheader?: string;
  /** Title used in the eyebrow band above the main content. Short
   *  taxonomy label, e.g. "Order confirmed", "New order", "Status update". */
  eyebrow: string;
}

/**
 * Wrap arbitrary inner HTML in the branded email frame. `inner` is
 * inserted verbatim into the card body — callers are responsible for
 * escaping any customer-supplied strings inside it.
 */
export function emailShell(inner: string, opts: ShellOptions): string {
  const eyebrow = escapeHtml(opts.eyebrow);
  const preheader = opts.preheader ? escapeHtml(opts.preheader) : "";

  // Letter-spacing for the eyebrow gives it the brand voice — same
  // treatment we use on the web everywhere we render eyebrow labels.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light only">
    <title>Nimi Events</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND_COLOURS.cream50};color:${BRAND_COLOURS.neutral800};font-family:${SANS_STACK};-webkit-font-smoothing:antialiased;">
    ${
      preheader
        ? `<div style="display:none;font-size:1px;color:${BRAND_COLOURS.cream50};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>`
        : ""
    }
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:${BRAND_COLOURS.cream50};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:${BRAND_COLOURS.paper};border:1px solid ${BRAND_COLOURS.cream200};">

            <!-- Brand band -->
            <tr>
              <td style="background:${BRAND_COLOURS.maroon600};padding:20px 28px;text-align:left;color:${BRAND_COLOURS.cream50};">
                <div style="font-family:${SERIF_STACK};font-size:22px;letter-spacing:0.16em;text-transform:uppercase;font-weight:500;">
                  Nimi Events
                </div>
                <div style="font-family:${SERIF_STACK};font-style:italic;font-size:13px;color:${BRAND_COLOURS.cream100};margin-top:2px;letter-spacing:0.02em;">
                  Where good food gathers.
                </div>
              </td>
            </tr>

            <!-- Eyebrow + content card -->
            <tr>
              <td style="padding:28px 28px 8px 28px;">
                <div style="font-family:${SANS_STACK};font-size:11px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND_COLOURS.orange600};">
                  ${eyebrow}
                </div>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:0 28px 32px 28px;font-family:${SANS_STACK};font-size:15px;line-height:1.65;color:${BRAND_COLOURS.neutral800};">
                ${inner}
              </td>
            </tr>

            <!-- Cream footer band -->
            <tr>
              <td style="background:${BRAND_COLOURS.cream100};padding:20px 28px;border-top:1px solid ${BRAND_COLOURS.cream200};font-family:${SANS_STACK};font-size:12px;line-height:1.6;color:${BRAND_COLOURS.neutral500};">
                <div style="font-family:${SERIF_STACK};font-size:14px;color:${BRAND_COLOURS.maroon600};font-weight:500;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:6px;">
                  Nimi Events
                </div>
                <div>Catering · Event planning · Gifting · The Indulgence Club</div>
                <div style="margin-top:6px;">United Kingdom · <a href="https://nimievents.com" style="color:${BRAND_COLOURS.orange600};text-decoration:none;">nimievents.com</a></div>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Helper — renders a branded display heading inside the email body.
 * Italic serif, maroon, generous size.
 */
export function emailHeading(text: string): string {
  return `<h1 style="margin:0 0 16px 0;font-family:${SERIF_STACK};font-size:32px;line-height:1.2;font-weight:500;color:${BRAND_COLOURS.maroon600};">${escapeHtml(text)}</h1>`;
}

/**
 * Helper — body paragraph with the brand body typography.
 */
export function emailParagraph(text: string): string {
  return `<p style="margin:0 0 14px 0;font-family:${SANS_STACK};font-size:15px;line-height:1.65;color:${BRAND_COLOURS.neutral800};">${escapeHtml(text)}</p>`;
}

/**
 * Helper — primary call-to-action button. Italic-serif voice matches
 * the web app's CTA pattern.
 */
export function emailButton(label: string, href: string): string {
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:8px 0 8px 0;"><tr><td style="background:${BRAND_COLOURS.maroon600};">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 28px;font-family:${SERIF_STACK};font-style:italic;font-size:18px;font-weight:500;color:${BRAND_COLOURS.cream50};text-decoration:none;letter-spacing:0.02em;">${escapeHtml(label)}</a>
  </td></tr></table>`;
}

/**
 * Helper — content card inside the body, used for reference/summary
 * panels (order ref, total amount, etc.). Cream-100 surface with a
 * maroon left border in the brand style.
 */
export function emailPanel(inner: string): string {
  return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:16px 0 20px 0;background:${BRAND_COLOURS.cream100};border-left:4px solid ${BRAND_COLOURS.orange500};">
    <tr><td style="padding:14px 18px;font-family:${SANS_STACK};font-size:14px;line-height:1.65;color:${BRAND_COLOURS.neutral800};">${inner}</td></tr>
  </table>`;
}

/**
 * Helper — definition list row inside a panel ("Reference: NIMI-…").
 */
export function emailFact(label: string, value: string): string {
  return `<div style="margin-bottom:4px;"><span style="color:${BRAND_COLOURS.neutral500};font-size:12px;text-transform:uppercase;letter-spacing:0.16em;font-weight:600;">${escapeHtml(label)}</span><br><span style="font-family:${SERIF_STACK};font-size:18px;color:${BRAND_COLOURS.maroon600};">${escapeHtml(value)}</span></div>`;
}
