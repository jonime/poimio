import {
  type EnrichmentDb,
  type IngestDb,
  recordSourceOutcome,
  type Source,
  type ThumbnailWriter,
} from "./db.ts";
import { type EmbeddingOptions, type EmbeddingRunResult, embedPendingItems } from "./embeddings.ts";
import {
  type EnrichmentOptions,
  type EnrichmentRunResult,
  runEnrichment,
} from "./enrich/coordinator.ts";
import { fetchPageHtml, type PageFetchBatchOptions, type PageFetchResult } from "./enrich/page.ts";
import type { FetchBatchOptions, FetchResult } from "./fetch.ts";
import { fetchFeeds } from "./fetch.ts";
import { parseFeed } from "./normalize/parse.ts";
import { MIN_THUMBNAIL_WIDTH } from "./normalize/thumbnail.ts";
import { applyThumbnail, lookupThumbnails, type ThumbnailCandidate } from "./thumbnails/lookup.ts";
import {
  NASA_RELEASES_FEED_URL,
  NASA_RELEASES_RULE,
  publisherAllowsArticle,
} from "./thumbnails/publisher.ts";

export interface SourceIngestionSummary {
  name: string;
  fetched: number;
  newItems: number;
  skipped: number;
  errors: string[];
}

export interface IngestionSummary {
  sources: SourceIngestionSummary[];
  enrichment: EnrichmentRunResult;
  embeddings: EmbeddingRunResult;
}

export interface IngestionOptions {
  fetchBatch?: (
    feeds: Parameters<typeof fetchFeeds>[0],
    options?: FetchBatchOptions,
  ) => Promise<FetchResult[]>;
  embedding?: EmbeddingOptions;
  enrichment?: Omit<EnrichmentOptions, "now">;
  thumbnailFetch?: PageFetchBatchOptions;
  now?: () => Date;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fetchInput(source: Source) {
  return {
    feedUrl: source.feedUrl,
    etag: source.etag,
    lastModified: source.lastModified,
  };
}

function isYouTubeShort(url: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed) return false;
  return (
    (parsed.hostname === "youtube.com" || parsed.hostname.endsWith(".youtube.com")) &&
    parsed.pathname.startsWith("/shorts/")
  );
}

/** Fetch, parse, persist, and embed the currently active feed catalog. */
export async function runIngestion(
  db: IngestDb & EnrichmentDb & ThumbnailWriter,
  openAiApiKey: string,
  options: IngestionOptions = {},
): Promise<IngestionSummary> {
  const sources = await db.listActiveSources();
  const fetchBatch = options.fetchBatch ?? fetchFeeds;
  const results = await fetchBatch(sources.map(fetchInput));
  const summaries: SourceIngestionSummary[] = [];
  const thumbnailCandidates: Array<ThumbnailCandidate & { publishedAt: Date }> = [];

  for (const [index, source] of sources.entries()) {
    const result = results[index];
    const summary: SourceIngestionSummary = {
      name: source.name,
      fetched: 0,
      newItems: 0,
      skipped: 0,
      errors: [],
    };
    summaries.push(summary);

    if (!result) {
      const error = "feed fetch returned no result";
      summary.errors.push(error);
      await recordSourceOutcome(
        db,
        source.id,
        { kind: "error", phase: "fetch", error },
        options.now?.(),
      );
      continue;
    }

    if (result.status === "not_modified") {
      summary.skipped = 1;
      await recordSourceOutcome(db, source.id, { kind: "not_modified" }, options.now?.());
      continue;
    }

    if (result.status === "error") {
      summary.errors.push(result.error);
      await recordSourceOutcome(
        db,
        source.id,
        { kind: "error", phase: "fetch", error: result.error },
        options.now?.(),
      );
      continue;
    }

    summary.fetched = 1;
    let parsed: Awaited<ReturnType<typeof parseFeed>>;
    try {
      parsed = await parseFeed(result.body, options.now ? { fetchTime: options.now() } : {});
    } catch (error) {
      const message = describeError(error);
      summary.errors.push(message);
      await recordSourceOutcome(
        db,
        source.id,
        { kind: "error", phase: "parse", error: message },
        options.now?.(),
      );
      continue;
    }

    const items = parsed.items.filter((item) => !isYouTubeShort(item.url));
    const inserted = await db.insertItems(source, items);
    summary.newItems = inserted.length;
    if (source.kind === "rss" && source.feedUrl === NASA_RELEASES_FEED_URL) {
      const insertedIds = new Map(inserted.map(({ url, id }) => [url, id]));
      for (const item of items) {
        const id = insertedIds.get(item.url);
        if (!id) continue;
        insertedIds.delete(item.url);
        if (
          item.type === "article" &&
          (item.thumbnailUrl === null ||
            (item.thumbnailWidth ?? MIN_THUMBNAIL_WIDTH) < MIN_THUMBNAIL_WIDTH) &&
          publisherAllowsArticle(NASA_RELEASES_RULE, item.url)
        ) {
          thumbnailCandidates.push({
            id,
            url: item.url,
            thumbnailUrl: item.thumbnailUrl,
            publishedAt: item.publishedAt,
          });
        }
      }
    }
    await recordSourceOutcome(
      db,
      source.id,
      {
        kind: "fetched",
        newItems: summary.newItems,
        ...(result.etag === undefined ? {} : { etag: result.etag }),
        ...(result.lastModified === undefined ? {} : { lastModified: result.lastModified }),
      },
      options.now?.(),
    );
  }

  const thumbnailUrls = new Set(thumbnailCandidates.map((candidate) => candidate.url));
  const cached = new Map<string, PageFetchResult>();
  const enrichment = await runEnrichment(db, openAiApiKey, {
    ...options.enrichment,
    fetchPage: async (url) => {
      const page = await (options.enrichment?.fetchPage ?? fetchPageHtml)(url);
      if (thumbnailUrls.has(url)) cached.set(url, page);
      return page;
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  thumbnailCandidates.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  const thumbnails = await lookupThumbnails(thumbnailCandidates, cached, options.thumbnailFetch);
  for (const candidate of thumbnailCandidates) {
    const thumbnail = thumbnails.get(candidate.id);
    if (thumbnail) await applyThumbnail(db, candidate, thumbnail);
  }

  const embeddings = await embedPendingItems(db, openAiApiKey, options.embedding);
  return { sources: summaries, enrichment, embeddings };
}

/** Format the command output with a row for every active source. */
export function formatIngestionSummary(summary: IngestionSummary): string {
  const lines = ["Ingestion summary", "Source | fetched | new | skipped | errors"];

  for (const source of summary.sources) {
    const errorDetails = source.errors.length > 0 ? ` (${source.errors.join("; ")})` : "";
    lines.push(
      `${source.name} | ${source.fetched} | ${source.newItems} | ${source.skipped} | ${source.errors.length}${errorDetails}`,
    );
  }

  lines.push(
    `Enrichment: ${summary.enrichment.processed} processed, ${summary.enrichment.succeeded} succeeded, ${summary.enrichment.unresolved} unresolved, ${summary.enrichment.skipped} skipped, ${summary.enrichment.failed} failed (page metadata ${summary.enrichment.byOrigin.page_metadata}, AI ${summary.enrichment.byOrigin.ai_generated}, requests ${summary.enrichment.summaryRequests})`,
  );
  lines.push(`Embedded: ${summary.embeddings.embedded}`);
  for (const failure of summary.embeddings.failedBatches) {
    lines.push(`Embedding error (${failure.itemIds.length} items): ${failure.error}`);
  }

  return lines.join("\n");
}
