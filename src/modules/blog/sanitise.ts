/**
 * Server-side HTML sanitiser for blog post bodies.
 *
 * The brand owner edits posts in the admin via a simple HTML textarea;
 * Phase 6.1 will swap in TipTap. Until then, we defend the renderer with
 * a strict allow-list of tags and attributes. Anything outside the list
 * is stripped before persist — never rendered.
 *
 * Implementation notes:
 *   - Pure-string parsing rather than a heavy DOM lib, kept under 100
 *     lines so it's easy to audit. Good enough for trusted-author HTML.
 *   - We rely on React's default escaping for the actual rendering, so
 *     even if something slipped past, attribute injection would be
 *     mostly inert.
 *   - All event-handler attributes (`on*`), `style`, `srcset`, and
 *     `javascript:` / `data:` URLs are rejected outright.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "hr",
  "h2", "h3", "h4",
  "strong", "em", "u", "s", "code", "blockquote",
  "ul", "ol", "li",
  "a", "img", "figure", "figcaption",
  "pre",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "rel", "target"]),
  img: new Set(["src", "alt", "width", "height", "loading"]),
  figure: new Set(["class"]),
  blockquote: new Set(["cite"]),
};

const SAFE_PROTOCOLS = ["http:", "https:", "mailto:", "tel:"] as const;

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return true;
  try {
    const parsed = new URL(trimmed);
    return (SAFE_PROTOCOLS as readonly string[]).includes(parsed.protocol);
  } catch {
    return false;
  }
}

function sanitiseAttrs(tag: string, attrString: string): string {
  const allowedForTag = ALLOWED_ATTRS[tag];
  if (!allowedForTag) return "";

  const out: string[] = [];
  // Match key="value" or key='value' or key=value or bare key.
  const re = /([a-zA-Z][\w-]*)\s*(=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString)) !== null) {
    const key = m[1]!.toLowerCase();
    const rawVal = m[4] ?? m[5] ?? m[6] ?? "";
    if (!allowedForTag.has(key)) continue;
    if (key.startsWith("on")) continue;

    if ((key === "href" || key === "src") && !isSafeUrl(rawVal)) continue;

    // Force `rel="noopener noreferrer"` on every external link target.
    if (tag === "a" && key === "target" && rawVal === "_blank") {
      out.push(`target="_blank"`);
      out.push(`rel="noopener noreferrer"`);
      continue;
    }

    // Escape quotes in the value.
    const escaped = rawVal.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    out.push(`${key}="${escaped}"`);
  }
  return out.length ? " " + out.join(" ") : "";
}

export function sanitiseHtml(input: string): string {
  if (input.length > 200_000) {
    throw new Error("HTML body exceeds maximum size");
  }

  // Drop script/style/iframe/object tag pairs entirely (case-insensitive).
  const stripped = input
    .replace(/<\s*(script|style|iframe|object|embed|noscript)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\?[^>]*\?>/g, "") // PHP-style processing instructions
    .replace(/<!--[\s\S]*?-->/g, ""); // HTML comments

  // Now walk the remaining tags and either keep with sanitised attrs or strip.
  return stripped.replace(
    /<\s*(\/?)([a-zA-Z][a-zA-Z0-9]*)\s*((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g,
    (_, closing: string, tag: string, attrs: string) => {
      const t = tag.toLowerCase();
      if (!ALLOWED_TAGS.has(t)) return "";
      if (closing) return `</${t}>`;
      return `<${t}${sanitiseAttrs(t, attrs)}>`;
    },
  );
}

/**
 * Compute approximate word count from sanitised HTML body.
 * Used for the index ("3 min read"-ish) and to flag empty drafts.
 */
export function estimateWordCount(html: string): number {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return 0;
  return text.split(" ").length;
}
