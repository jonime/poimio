import type { FetchBatchOptions, FetchResult } from "./fetch.ts";
import { fetchFeeds } from "./fetch.ts";
import {
  embedPendingItems,
  type EmbeddingOptions,
  type EmbeddingRunResult,
} from "./embeddings.ts";
import {
  recordSourceOutcome,
  type EnrichmentDb,
  type IngestDb,
  type Source,
} from "./db.ts";
import {
  runEnrichment,
  type EnrichmentOptions,
  type EnrichmentRunResult,
} from "./enrich/coordinator.ts";
import { parseFeed } from "./normalize/parse.ts";

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
    (parsed.hostname === "youtube.com" ||
      parsed.hostname.endsWith(".youtube.com")) &&
    parsed.pathname.startsWith("/shorts/")
  );
}

/** Fetch, parse, persist, and embed the currently active feed catalog. */
export async function runIngestion(
  db: IngestDb & EnrichmentDb,
  openAiApiKey: string,
  options: IngestionOptions = {},
): Promise<IngestionSummary> {
  const sources = await db.listActiveSources();
  const fetchBatch = options.fetchBatch ?? fetchFeeds;
  const results = await fetchBatch(sources.map(fetchInput));
  const summaries: SourceIngestionSummary[] = [];

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
      await recordSourceOutcome(
        db,
        source.id,
        { kind: "not_modified" },
        options.now?.(),
      );
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
    let parsed;
    try {
      parsed = await parseFeed(result.body, { fetchTime: options.now?.() });
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

    summary.newItems = await db.insertItems(
      source,
      parsed.items.filter((item) => !isYouTubeShort(item.url)),
    );
    await recordSourceOutcome(
      db,
      source.id,
      {
        kind: "fetched",
        newItems: summary.newItems,
        etag: result.etag,
        lastModified: result.lastModified,
      },
      options.now?.(),
    );
  }

  const enrichment = await runEnrichment(db, openAiApiKey, {
    ...options.enrichment,
    now: options.now,
  });
  const embeddings = await embedPendingItems(
    db,
    openAiApiKey,
    options.embedding,
  );
  return { sources: summaries, enrichment, embeddings };
}

/** Format the command output with a row for every active source. */
export function formatIngestionSummary(summary: IngestionSummary): string {
  const lines = [
    "Ingestion summary",
    "Source | fetched | new | skipped | errors",
  ];

  for (const source of summary.sources) {
    const errorDetails =
      source.errors.length > 0 ? ` (${source.errors.join("; ")})` : "";
    lines.push(
      `${source.name} | ${source.fetched} | ${source.newItems} | ${source.skipped} | ${source.errors.length}${errorDetails}`,
    );
  }

  lines.push(
    `Enrichment: ${summary.enrichment.processed} processed, ${summary.enrichment.succeeded} succeeded, ${summary.enrichment.unresolved} unresolved, ${summary.enrichment.skipped} skipped, ${summary.enrichment.failed} failed (page metadata ${summary.enrichment.byOrigin.page_metadata}, AI ${summary.enrichment.byOrigin.ai_generated}, requests ${summary.enrichment.summaryRequests})`,
  );
  lines.push(`Embedded: ${summary.embeddings.embedded}`);
  for (const failure of summary.embeddings.failedBatches) {
    lines.push(
      `Embedding error (${failure.itemIds.length} items): ${failure.error}`,
    );
  }

  return lines.join("\n");
}
