import type { SupabaseClient } from "@supabase/supabase-js";
import { safeHttpUrl, type FeedItem } from "./feed-ui";

export type GuestFeedItem = Pick<FeedItem,
  "id" | "url" | "title" | "summary" | "summary_origin" | "type" |
  "language" | "thumbnail_url" | "published_at" | "source_name"
>;

export const guestFeedColumns =
  "id,source_id,url,title,summary,summary_origin,type,language,thumbnail_url,published_at,sources(id,name)";
const pageSize = 500;
type Candidate = GuestFeedItem & { source_id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCandidate(value: unknown): Candidate | null {
  if (!isRecord(value) || !isRecord(value.sources) ||
    typeof value.id !== "string" || typeof value.source_id !== "string" ||
    typeof value.url !== "string" || typeof value.title !== "string" ||
    typeof value.summary !== "string" || !value.summary.trim() ||
    !["feed", "page_metadata", "ai_generated"].includes(String(value.summary_origin)) ||
    (value.type !== "article" && value.type !== "video") ||
    (value.language !== "fi" && value.language !== "en") ||
    typeof value.published_at !== "string" || !Number.isFinite(Date.parse(value.published_at)) ||
    (value.thumbnail_url !== null && typeof value.thumbnail_url !== "string") ||
    typeof value.sources.name !== "string" || value.sources.id !== value.source_id
  ) throw new Error("Malformed public feed data");

  const url = safeHttpUrl(value.url);
  if (!url) return null;
  return {
    id: value.id, source_id: value.source_id, url, title: value.title,
    summary: value.summary, summary_origin: value.summary_origin as GuestFeedItem["summary_origin"],
    type: value.type, language: value.language,
    thumbnail_url: safeHttpUrl(value.thumbnail_url),
    published_at: value.published_at, source_name: value.sources.name,
  };
}

function newestFirst(a: Candidate, b: Candidate): number {
  return Date.parse(b.published_at) - Date.parse(a.published_at) || a.id.localeCompare(b.id);
}

export function selectGuestFeed(rows: unknown[]): GuestFeedItem[] {
  const seen = new Set<string>();
  const candidates = rows.map(parseCandidate).filter((item): item is Candidate => item !== null)
    .sort(newestFirst).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

  function languageQueue(language: "fi" | "en"): Candidate[] {
    const sources = new Map<string, Candidate[]>();
    for (const item of candidates.filter((item) => item.language === language)) {
      const source = sources.get(item.source_id) ?? [];
      source.push(item);
      sources.set(item.source_id, source);
    }
    const queue: Candidate[] = [];
    for (let round = 0; queue.length < 12; round++) {
      const items = [...sources.values()].flatMap((items) => items[round] ? [items[round]] : []);
      if (!items.length) break;
      items.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) ||
        a.source_id.localeCompare(b.source_id));
      queue.push(...items);
    }
    return queue;
  }

  const queues = [languageQueue("fi"), languageQueue("en")];
  const result: GuestFeedItem[] = [];
  for (let round = 0; result.length < 12; round++) {
    if (!queues.some((queue) => queue[round])) break;
    for (const queue of queues) {
      const item = queue[round];
      if (item && result.length < 12) {
        result.push({
          id: item.id, url: item.url, title: item.title, summary: item.summary,
          summary_origin: item.summary_origin, type: item.type, language: item.language,
          thumbnail_url: item.thumbnail_url, published_at: item.published_at,
          source_name: item.source_name,
        });
      }
    }
  }
  return result;
}

export async function readGuestFeed(client: SupabaseClient, asOf: string): Promise<GuestFeedItem[]> {
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.from("content_items")
      .select(guestFeedColumns)
      .lte("published_at", asOf)
      .order("published_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1)
      .abortSignal(AbortSignal.timeout(8_000));
    if (error || !Array.isArray(data)) throw new Error("Public feed could not be loaded");
    rows.push(...data);
    if (data.length < pageSize) return selectGuestFeed(rows);
  }
}
