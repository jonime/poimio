import type { ThumbnailBackfillDb, ThumbnailCursor, ThumbnailRow } from "../db.ts";
import type { PageFetchBatchOptions } from "../enrich/page.ts";
import { MIN_THUMBNAIL_WIDTH } from "../normalize/thumbnail.ts";
import { applyThumbnail, lookupThumbnails, THUMBNAIL_LOOKUP_LIMIT } from "./lookup.ts";
import {
  NASA_RELEASES_RULE,
  nasaStoredThumbnailWidth,
  publisherAllowsArticle,
} from "./publisher.ts";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function parseThumbnailCursor(value: string): ThumbnailCursor {
  const [publishedAt, id, extra] = value.split(",");
  if (
    extra !== undefined ||
    !publishedAt ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(publishedAt) ||
    !Number.isFinite(Date.parse(publishedAt)) ||
    !id ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new Error("Invalid thumbnail backfill cursor. Use the value reported by a previous run.");
  }
  return { publishedAt, id };
}

export async function runThumbnailBackfill(
  db: ThumbnailBackfillDb,
  options: {
    dryRun?: boolean;
    cursor?: ThumbnailCursor;
    now?: Date;
    pageFetch?: PageFetchBatchOptions;
  } = {},
) {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - SEVEN_DAYS_MS);
  const candidates: ThumbnailRow[] = [];
  let after = options.cursor;

  // Most rows may already have suitable images. Scan ordered pages until we
  // have a full batch of eligible candidates or exhaust the seven-day window.
  while (candidates.length < THUMBNAIL_LOOKUP_LIMIT) {
    const rows = await db.listRecentThumbnailRows(since, now, THUMBNAIL_LOOKUP_LIMIT, after);
    for (const row of rows) {
      const width = nasaStoredThumbnailWidth(row.thumbnailUrl);
      if (
        (row.thumbnailUrl === null || (width !== null && width < MIN_THUMBNAIL_WIDTH)) &&
        publisherAllowsArticle(NASA_RELEASES_RULE, row.url)
      ) {
        candidates.push(row);
        if (candidates.length === THUMBNAIL_LOOKUP_LIMIT) break;
      }
    }
    after = rows.at(-1);
    if (!after || rows.length < THUMBNAIL_LOOKUP_LIMIT) break;
  }

  const last = candidates.at(-1);
  const result = {
    candidates,
    found: 0,
    upgraded: 0,
    omitted: 0,
    fetchFailures: 0,
    concurrentChanges: 0,
    cursor:
      last && candidates.length === THUMBNAIL_LOOKUP_LIMIT
        ? `${last.publishedAt},${last.id}`
        : null,
  };
  if (options.dryRun) return result;

  const lookups = await lookupThumbnails(candidates, undefined, options.pageFetch);
  for (const candidate of candidates) {
    const lookup = lookups.get(candidate.id);
    if (!lookup || lookup.status === "fetch_failure") {
      result.fetchFailures++;
      continue;
    }
    if (lookup.status === "found") {
      result.found++;
      if (await applyThumbnail(db, candidate, lookup)) result.upgraded++;
      else result.concurrentChanges++;
    } else if (candidate.thumbnailUrl === null || (await applyThumbnail(db, candidate, lookup))) {
      result.omitted++;
    } else {
      result.concurrentChanges++;
    }
  }
  return result;
}
