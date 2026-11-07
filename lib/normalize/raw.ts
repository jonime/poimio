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
 * Article thumbnail candidates are read from the XML tree so embedded
 * content and comments cannot supply item metadata.
 */

import { JSDOM } from "jsdom";
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

const MEDIA_RSS_NAMESPACE = "http://search.yahoo.com/mrss/";

function isMediaContainer(element: Element): boolean {
  return (
    element.namespaceURI === MEDIA_RSS_NAMESPACE &&
    (element.localName === "group" || element.localName === "content")
  );
}

function extractArticleThumbnail(item: Element): FeedThumbnail | null {
  const candidates: FeedThumbnail[] = [];
  let existingUnknown: FeedThumbnail | undefined;
  const pending = Array.from(item.children).reverse();

  while (pending.length > 0) {
    const element = pending.pop();
    if (!element) break;
    if (isMediaContainer(element)) {
      for (const child of Array.from(element.children).reverse()) pending.push(child);
    }

    const kind = element.localName;
    const isMedia = element.namespaceURI === MEDIA_RSS_NAMESPACE;
    const isThumbnail = isMedia && kind === "thumbnail";
    const isMediaContent = isMedia && kind === "content";
    const isItemElement =
      element.parentElement === item && element.namespaceURI === item.namespaceURI;
    const isAtomEnclosure =
      isItemElement && kind === "link" && element.getAttribute("rel") === "enclosure";
    const isRssEnclosure = isItemElement && kind === "enclosure";
    if (!isThumbnail && !isMediaContent && !isAtomEnclosure && !isRssEnclosure) continue;

    const type = element.getAttribute("type");
    if (
      !isThumbnail &&
      !/^image\/[^\s]+$/i.test(type ?? "") &&
      !(isMediaContent && type === null && element.getAttribute("medium") === "image")
    ) {
      continue;
    }

    const value = element.getAttribute(isAtomEnclosure ? "href" : "url");
    const url = value && URL.parse(value.trim());
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
      continue;

    const candidate = { url: url.href, width: imageWidth(element.getAttribute("width")) };
    if (isThumbnail && candidate.width === null) existingUnknown ??= candidate;
    candidates.push(candidate);
  }

  const selected = selectFeedThumbnail(candidates);
  return selected?.width === null ? (existingUnknown ?? selected) : selected;
}

/** Read actual item metadata in document order, without rewriting the feed XML. */
export function extractArticleThumbnails(
  xml: string,
  format: "rss" | "atom",
  expectedCount: number,
): Array<FeedThumbnail | null> {
  let dom: JSDOM;
  try {
    dom = new JSDOM(xml, { contentType: "application/xml" });
  } catch {
    // Keep items from the primary parser when strict XML parsing fails.
    return [];
  }

  try {
    const root = dom.window.document.documentElement;
    const parent =
      format === "rss"
        ? Array.from(root.children).find(
            (element) =>
              element.localName === "channel" && element.namespaceURI === root.namespaceURI,
          )
        : root;
    const itemTag = format === "rss" ? "item" : "entry";
    const items = Array.from(parent?.children ?? []).filter(
      (element) => element.localName === itemTag && element.namespaceURI === root.namespaceURI,
    );
    if (items.length !== expectedCount) return [];
    return items.map(extractArticleThumbnail);
  } finally {
    dom.window.close();
  }
}
