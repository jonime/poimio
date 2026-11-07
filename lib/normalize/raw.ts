/**
 * Small raw-XML extractions for fields `rss-parser` does not surface
 * (spec 001, task 5).
 *
 * `rss-parser` (xml2js under the hood) gives us titles, links, dates, and
 * RSS categories, but it drops the `media:*` namespace entirely and does not
 * map Atom `<category term="…">` elements. Since feed XML from these sources
 * is well-formed, targeted extractions over each item/entry block are
 * reliable for the few missing fields:
 *
 * - `<description>` / `<summary>` element text (the only legal summary
 *   sources per the spec; never the full `<content>`)
 * - Atom `<category>` terms
 * - `<media:thumbnail url="…">`
 *
 * These run per item block, not over the whole feed, so stray text inside a
 * description's CDATA cannot produce phantom fields.
 */

import { decodeEntities } from "./text.ts";
import { type FeedThumbnail, imageWidth, selectFeedThumbnail } from "./thumbnail.ts";

/**
 * Extract the inner content of the first `tag` element in a block, unwrapping
 * CDATA when present. Returns `null` when the element is absent.
 */
export function elementText(block: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  const inner = match?.[1];
  return inner === undefined ? null : unwrapCdata(inner);
}

function unwrapCdata(inner: string): string {
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata?.[1] ?? inner;
}

/**
 * Split a feed document into its item blocks, in document order.
 *
 * `rss` feeds use `<item>…</item>`; Atom feeds use `<entry>…</entry>`.
 * These elements do not nest, so a non-greedy match per element is exact.
 */
export function splitItemBlocks(xml: string, format: "rss" | "atom"): string[] {
  const tag = format === "rss" ? "item" : "entry";
  const blocks: string[] = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "g");
  for (const match of xml.matchAll(pattern)) {
    blocks.push(match[0]);
  }
  return blocks;
}

/**
 * Extract Atom category terms (`<category … term="…"/>`, self-closing or not).
 * Elements without a `term` attribute are skipped.
 */
export function extractAtomCategories(block: string): string[] {
  const terms: string[] = [];
  for (const match of block.matchAll(/<category\b([^>]*?)(?:\/>|>[\s\S]*?<\/category>)/gi)) {
    const attrs = match[1] ?? "";
    const term = attrValue(attrs, "term");
    if (term != null) terms.push(decodeEntities(term).trim());
  }
  return terms;
}

function attrValue(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  if (!match) return null;
  return match[2] ?? match[3] ?? null;
}

/**
 * Extract the `url` attribute of a `<media:thumbnail>` element, if any.
 * Works for both YouTube's `<media:group><media:thumbnail …/></media:group>`
 * and BBC's item-level `<media:thumbnail …/>`.
 */
export function extractThumbnailUrl(block: string): string | null {
  const match = block.match(/<media:thumbnail\b[^>]*>/i);
  if (!match) return null;
  const url = attrValue(match[0], "url");
  return url == null ? null : decodeEntities(url).trim();
}

/** Consider media on this item only, ignoring embedded HTML and channel art. */
export function extractArticleThumbnail(block: string): FeedThumbnail | null {
  const markup = block.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(description|summary|content|content:encoded)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  const candidates: FeedThumbnail[] = [];
  let existingUnknown: FeedThumbnail | undefined;
  for (const match of markup.matchAll(
    /<(media:thumbnail|media:content|enclosure|link)(?=\s|\/?>)[^>]*>/gi,
  )) {
    const [tag, name] = match;
    const kind = name?.toLowerCase();
    if (kind === "link" && attrValue(tag, "rel") !== "enclosure") continue;
    if (kind !== "media:thumbnail") {
      const type = attrValue(tag, "type");
      if (
        !/^image\/[^\s]+$/i.test(type ?? "") &&
        !(kind === "media:content" && attrValue(tag, "medium") === "image" && type === null)
      )
        continue;
    }

    const value = attrValue(tag, kind === "link" ? "href" : "url");
    const url = URL.parse(decodeEntities(value ?? "").trim());
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
      continue;
    const candidate = { url: url.href, width: imageWidth(attrValue(tag, "width")) };
    if (kind === "media:thumbnail" && candidate.width === null) existingUnknown ??= candidate;
    candidates.push(candidate);
  }
  const selected = selectFeedThumbnail(candidates);
  return selected?.width === null ? (existingUnknown ?? selected) : selected;
}
