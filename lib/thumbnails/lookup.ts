import type { ThumbnailWriter } from "../db.ts";
import { fetchPages, type PageFetchBatchOptions, type PageFetchResult } from "../enrich/page.ts";
import {
  approvedHttpsUrl,
  NASA_RELEASES_RULE,
  selectPageThumbnail,
  type ThumbnailLookup,
} from "./publisher.ts";

export const THUMBNAIL_LOOKUP_LIMIT = 20;

export interface ThumbnailCandidate {
  id: string;
  url: string;
  thumbnailUrl: string | null;
}

/** Callers supply newest-first candidates and, during ingestion, any reused pages. */
export async function lookupThumbnails(
  candidates: ThumbnailCandidate[],
  cached: ReadonlyMap<string, PageFetchResult> = new Map(),
  options?: PageFetchBatchOptions,
): Promise<Map<string, ThumbnailLookup>> {
  const urls = [...new Set(candidates.map((candidate) => candidate.url))]
    .filter((url) => !cached.has(url))
    .slice(0, THUMBNAIL_LOOKUP_LIMIT);
  const pages = await fetchPages(urls, {
    ...options,
    allowUrl: (url) => approvedHttpsUrl(url.href) !== null && NASA_RELEASES_RULE.articleUrl(url),
  });
  const fetched = new Map(urls.map((url, index) => [url, pages[index]]));
  const results = new Map<string, ThumbnailLookup>();
  for (const candidate of candidates) {
    const page = cached.get(candidate.url) ?? fetched.get(candidate.url);
    if (page) {
      results.set(
        candidate.id,
        selectPageThumbnail(NASA_RELEASES_RULE, page, candidate.thumbnailUrl),
      );
    }
  }
  return results;
}

export async function applyThumbnail(
  db: ThumbnailWriter,
  candidate: ThumbnailCandidate,
  result: ThumbnailLookup,
): Promise<boolean> {
  if (result.status === "fetch_failure") return false;
  const thumbnail = result.status === "found" ? result.url : null;
  return (
    thumbnail !== candidate.thumbnailUrl &&
    db.saveThumbnail(candidate.id, candidate.thumbnailUrl, thumbnail)
  );
}
