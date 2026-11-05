/**
 * HTML text cleaning for feed descriptions (spec 001, task 5).
 *
 * Feed `<description>` / `<summary>` values are HTML fragments with entities.
 * We decode entities, strip tags (turning block-level tags into newlines),
 * and collapse whitespace so the stored summary is readable plain text.
 */

/** Common named HTML entities that appear in feed content. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
};

/**
 * Decode numeric and named HTML/XML entities.
 *
 * Unknown named entities are left as-is so we never invent content.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (match, decimal: string) => safeFromCodePoint(Number(decimal)) ?? match)
    .replace(
      /&#x([0-9a-fA-F]+);/g,
      (match, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)) ?? match,
    )
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match);
}

function safeFromCodePoint(code: number): string | null {
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

/** Tags whose closing tag introduces a line break in the plain text. */
const BLOCK_TAG_RE =
  /<\/(p|div|li|ul|ol|h[1-6]|blockquote|pre|figure|figcaption|tr|table|dd|dt|dl|section|article|header|footer)>/gi;

/**
 * Convert an HTML fragment to plain text.
 *
 * - `<script>`/`<style>`/`<noscript>` content is discarded entirely
 * - `<br>` and closing block tags become newlines
 * - all remaining tags are removed
 * - entities are decoded and runs of whitespace are collapsed
 */
export function htmlToText(html: string): string {
  if (!html) return "";

  let text = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?\s*>/gi, "\n");
  text = text.replace(BLOCK_TAG_RE, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Whether an HTML fragment carries no information beyond link(s).
 *
 * Hacker News descriptions are exactly `<![CDATA[<a href="...">Comments</a>]]>`,
 * which must normalize to an empty summary rather than the word "Comments".
 * We treat a fragment as link-only when every piece of text sits inside an
 * anchor and at least one anchor is present.
 */
export function isLinkOnly(html: string): boolean {
  const withoutAnchors = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ");
  const withoutTags = withoutAnchors.replace(/<[^>]+>/g, " ");
  return withoutTags.trim() === "" && /<a\b/i.test(html);
}

export const DEFAULT_SUMMARY_MAX_LENGTH = 1000;

/**
 * Truncate a summary to at most `maxLength` characters (default ~1,000),
 * cutting at the last word boundary when possible and appending an ellipsis.
 *
 * Short summaries are returned unchanged.
 */
export function truncateSummary(
  text: string,
  maxLength: number = DEFAULT_SUMMARY_MAX_LENGTH,
): string {
  if (text.length <= maxLength) return text;

  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  // Prefer a word boundary, but don't cut into the first half of the limit
  // if no reasonable boundary exists.
  const boundary = lastSpace > maxLength / 2 ? lastSpace : cut.length;
  return cut.slice(0, boundary).trimEnd() + "…";
}
