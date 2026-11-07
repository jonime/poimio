/**
 * Feed parsing and normalization (spec 001, task 5).
 *
 * `parseFeed` turns a raw RSS 2.0 or Atom document (as returned by
 * `fetchFeed`) into normalized items shaped for the `content_items` table:
 *
 * - `url` — normalized (tracking params and fragment dropped)
 * - `title` — plain text
 * - `summary` — from the RSS `<description>` or Atom `<summary>` only
 *   (never the full `<content>`); link-only descriptions (Hacker News
 *   "Comments") normalize to an empty summary; YouTube `media:description`
 *   is used when there is no summary, with boilerplate lines removed;
 *   finally truncated to ~1,000 characters
 * - `type` — `video` for YouTube watch/shorts URLs, `article` otherwise
 * - `categories` — deduplicated
 * - `thumbnailUrl` — from item-level feed media when present
 * - `publishedAt` — from `pubDate`/`published`/`updated`, falling back to
 *   the fetch time
 *
 * The module is pure: it takes XML in and returns data out, with no
 * database access (persistence is task 6).
 */

import Parser from "rss-parser";
import { removeYouTubeBoilerplate } from "./boilerplate.ts";
import {
  elementText,
  extractArticleThumbnail,
  extractAtomCategories,
  extractThumbnailUrl,
  splitItemBlocks,
} from "./raw.ts";
import { decodeEntities, htmlToText, isLinkOnly, truncateSummary } from "./text.ts";
import { normalizeUrl } from "./url.ts";

/** A normalized feed item, shaped for the `content_items` table. */
export interface ParsedItem {
  /** Normalized, deduplication-safe item URL. */
  url: string;
  /** Plain-text title. */
  title: string;
  /** Cleaned, truncated plain-text summary (may be empty). */
  summary: string;
  type: "video" | "article";
  categories: string[];
  /** Item thumbnail URL, when the feed provides one. */
  thumbnailUrl: string | null;
  /** Feed-declared image width, when available. */
  thumbnailWidth?: number;
  publishedAt: Date;
}

/** The result of parsing one feed document. */
export interface ParsedFeed {
  format: "rss" | "atom";
  /** Feed-level title, for logging/inspection. */
  title: string;
  items: ParsedItem[];
}

export interface ParseOptions {
  /**
   * When the feed document was fetched. Used as the fallback for
   * `publishedAt` when an item carries no usable date.
   */
  fetchTime?: Date;
}

/** Detect the feed format from the document root element. */
export function detectFormat(xml: string): "rss" | "atom" | null {
  const body = xml.replace(/^\uFEFF/, "");
  if (/<feed\b/i.test(body)) return "atom";
  if (/<rss\b/i.test(body)) return "rss";
  return null;
}

/**
 * Whether a normalized URL points at a YouTube video (watch, shorts, or
 * live), including `youtu.be` short links.
 */
function isYouTubeVideoUrl(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be") return true;
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    return (
      parsed.pathname.startsWith("/watch") ||
      parsed.pathname.startsWith("/shorts") ||
      parsed.pathname.startsWith("/live")
    );
  }
  return false;
}

/**
 * Resolve an item's publication date: the ISO date `rss-parser` computes
 * first, then the raw date string, then the fetch-time fallback.
 */
function resolvePublishedAt(item: Record<string, unknown>, fetchTime: Date): Date {
  const iso = item.isoDate;
  if (typeof iso === "string") {
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const raw = item.pubDate ?? item.published ?? item.updated;
  if (typeof raw === "string" || typeof raw === "number") {
    const parsed = new Date(String(raw));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fetchTime;
}

/**
 * Build the normalized summary for one item from its raw XML block.
 *
 * Only the RSS `<description>` or Atom `<summary>` element is ever used;
 * the full `<content>` is deliberately ignored. For video items with no
 * summary, `media:description` is used as a fallback source, with
 * YouTube boilerplate lines removed.
 */
function buildSummary(block: string, format: "rss" | "atom", type: "video" | "article"): string {
  const summaryTag = format === "rss" ? "description" : "summary";
  const raw = elementText(block, summaryTag);

  let text = "";
  if (raw != null && !isLinkOnly(raw)) {
    text = htmlToText(raw);
  }

  if (text === "" && type === "video") {
    const mediaDescription = elementText(block, "media:description");
    if (mediaDescription != null) {
      text = removeYouTubeBoilerplate(htmlToText(mediaDescription));
    }
  }

  return truncateSummary(text);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "" && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Parse a feed document and normalize its items.
 *
 * @throws when the document is neither RSS nor Atom, or when the parser
 * fails on malformed XML (the ingestion run isolates per-source errors).
 */
export async function parseFeed(xml: string, options: ParseOptions = {}): Promise<ParsedFeed> {
  const format = detectFormat(xml);
  if (format == null) {
    throw new Error("unsupported feed format: expected RSS 2.0 or Atom");
  }

  const parser = new Parser();
  const feed = await parser.parseString(xml);
  const items = feed.items;
  const blocks = splitItemBlocks(xml, format);
  // Pairing is positional: rss-parser preserves document order. If the
  // counts ever disagree we normalize without the raw-block fields rather
  // than risk attaching data to the wrong item.
  const useBlocks = blocks.length === items.length;
  const fetchTime = options.fetchTime ?? new Date();

  const parsed: ParsedItem[] = items.map((item, index) => {
    const block = useBlocks ? (blocks[index] ?? "") : "";
    const link = typeof item.link === "string" ? item.link : "";
    const url = normalizeUrl(link);
    const type: "video" | "article" = isYouTubeVideoUrl(url) ? "video" : "article";

    const titleRaw = typeof item.title === "string" ? item.title : "";
    const title = decodeEntities(titleRaw).replace(/\s+/g, " ").trim();

    // RSS categories come from the parser (correct at the XML level); Atom
    // categories are missing from the parser output, so we extract them
    // from the raw entry block instead.
    const categories =
      format === "rss"
        ? dedupe((item.categories as string[] | undefined) ?? [])
        : dedupe(extractAtomCategories(block));

    const thumbnail = type === "article" ? extractArticleThumbnail(block) : null;

    return {
      url,
      title,
      summary: buildSummary(block, format, type),
      type,
      categories,
      thumbnailUrl: type === "video" ? extractThumbnailUrl(block) : (thumbnail?.url ?? null),
      ...(thumbnail?.width == null ? {} : { thumbnailWidth: thumbnail.width }),
      publishedAt: resolvePublishedAt(item as unknown as Record<string, unknown>, fetchTime),
    };
  });

  return {
    format,
    title: typeof feed.title === "string" ? feed.title : "",
    items: parsed,
  };
}
