import type {
  BackfillDb,
  EnrichmentItem,
  IngestDb,
  SummaryOrigin,
  UnembeddedItem,
} from "../db.ts";
import {
  embedPendingItems,
  type EmbeddingBatchFailure,
  type EmbeddingOptions,
} from "../embeddings.ts";
import {
  MAX_ENRICHMENT_ITEMS_PER_RUN,
  runEnrichment,
  type EnrichmentOptions,
  type EnrichmentProgress,
  type EnrichmentRunResult,
} from "./coordinator.ts";

export type EnrichmentBackfillDb = BackfillDb &
  Pick<IngestDb, "listUnembeddedItems" | "saveEmbedding">;

export interface BackfillOptions {
  dryRun?: boolean;
  limit?: number;
  retryFailed?: boolean;
  now?: () => Date;
  enrichment?: Pick<EnrichmentOptions, "fetchPage" | "summarize">;
  embedding?: Pick<EmbeddingOptions, "fetch">;
  onProgress?: (progress: BackfillProgressEvent) => void;
}

export type BackfillProgressEvent =
  | {
      phase: "selection";
      total: number;
      due: number;
      exhausted: number;
      embeddingRecovery: number;
    }
  | { phase: "requeue"; count: number }
  | ({ phase: "description" } & EnrichmentProgress)
  | { phase: "embedding"; status: "starting"; total: number }
  | {
      phase: "embedding";
      status: "completed";
      total: number;
      embedded: number;
      failedBatches: number;
    };

export interface BackfillResult {
  dryRun: boolean;
  processed: number;
  skipped: number;
  succeeded: number;
  unresolved: number;
  failed: number;
  summaryRequests: number;
  embedded: number;
  embeddingFailures: EmbeddingBatchFailure[];
  byOrigin: Record<SummaryOrigin, number>;
}

export interface BackfillCliOptions extends BackfillOptions {
  environment: "local" | "production";
}

function emptyOrigins(): Record<SummaryOrigin, number> {
  return { feed: 0, page_metadata: 0, ai_generated: 0 };
}

function countOrigin(
  origins: Record<SummaryOrigin, number>,
  origin: SummaryOrigin | null,
): void {
  if (origin !== null) origins[origin]++;
}

function describeDryRun(
  due: EnrichmentItem[],
  exhausted: EnrichmentItem[],
  missingEmbeddings: UnembeddedItem[],
): BackfillResult {
  const selected = due.length + exhausted.length + missingEmbeddings.length;
  const byOrigin = emptyOrigins();
  for (const item of missingEmbeddings)
    countOrigin(byOrigin, item.summaryOrigin);
  return {
    dryRun: true,
    processed: 0,
    skipped: selected,
    succeeded: 0,
    unresolved: due.length + exhausted.length,
    failed: 0,
    summaryRequests: 0,
    embedded: 0,
    embeddingFailures: [],
    byOrigin,
  };
}

export async function runEnrichmentBackfill(
  db: EnrichmentBackfillDb,
  apiKey: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const reportProgress = (progress: BackfillProgressEvent) => {
    try {
      options.onProgress?.(progress);
    } catch {
      // Progress listeners must not affect processing.
    }
  };
  const now = options.now ?? (() => new Date());
  const limit = Math.max(
    1,
    Math.min(
      options.limit ?? MAX_ENRICHMENT_ITEMS_PER_RUN,
      MAX_ENRICHMENT_ITEMS_PER_RUN,
    ),
  );
  const selectedAt = now();
  const due = await db.listDueEnrichmentItems(limit, selectedAt);
  let remaining = limit - due.length;
  const exhausted =
    options.retryFailed && remaining > 0
      ? await db.listExhaustedEnrichmentItems(remaining)
      : [];
  remaining -= exhausted.length;
  const allMissingEmbeddings = await db.listUnembeddedItems();
  const missingEmbeddings = allMissingEmbeddings.slice(0, remaining);
  reportProgress({
    phase: "selection",
    total: due.length + exhausted.length + missingEmbeddings.length,
    due: due.length,
    exhausted: exhausted.length,
    embeddingRecovery: missingEmbeddings.length,
  });

  if (options.dryRun) {
    return describeDryRun(due, exhausted, missingEmbeddings);
  }

  if (exhausted.length > 0) {
    reportProgress({ phase: "requeue", count: exhausted.length });
  }
  const requeuedCount = exhausted.length
    ? await db.requeueExhaustedEnrichmentItems(exhausted.map((item) => item.id))
    : 0;
  const enrichmentIds = [
    ...due.map((item) => item.id),
    ...exhausted.map((item) => item.id),
  ];
  const enrichment: EnrichmentRunResult = await runEnrichment(db, apiKey, {
    ...options.enrichment,
    now,
    limit: enrichmentIds.length,
    itemIds: enrichmentIds,
    onProgress: (progress) =>
      reportProgress({ phase: "description", ...progress }),
  });
  const embeddingIds = [
    ...new Set([
      ...missingEmbeddings.map((item) => item.id),
      ...enrichment.succeededIds,
    ]),
  ];
  if (embeddingIds.length > 0) {
    reportProgress({
      phase: "embedding",
      status: "starting",
      total: embeddingIds.length,
    });
  }
  const embedding = await embedPendingItems(db, apiKey, {
    ...options.embedding,
    itemIds: embeddingIds,
    limit: embeddingIds.length,
  });
  if (embeddingIds.length > 0) {
    reportProgress({
      phase: "embedding",
      status: "completed",
      total: embeddingIds.length,
      embedded: embedding.embedded,
      failedBatches: embedding.failedBatches.length,
    });
  }
  const embeddingFailureCount = embedding.failedBatches.reduce(
    (total, failure) => total + failure.itemIds.length,
    0,
  );
  const unpersistedEmbeddings = Math.max(
    0,
    embeddingIds.length - embedding.embedded - embeddingFailureCount,
  );
  const byOrigin = emptyOrigins();
  for (const item of missingEmbeddings)
    countOrigin(byOrigin, item.summaryOrigin);
  byOrigin.page_metadata += enrichment.byOrigin.page_metadata;
  byOrigin.ai_generated += enrichment.byOrigin.ai_generated;

  return {
    dryRun: false,
    processed: due.length + requeuedCount + missingEmbeddings.length,
    skipped:
      exhausted.length -
      requeuedCount +
      enrichment.skipped +
      unpersistedEmbeddings,
    succeeded: embedding.embedded,
    unresolved: enrichment.unresolved + exhausted.length - requeuedCount,
    failed: enrichment.failed + embeddingFailureCount,
    summaryRequests: enrichment.summaryRequests,
    embedded: embedding.embedded,
    embeddingFailures: embedding.failedBatches,
    byOrigin,
  };
}

function parsePositiveLimit(value: string): number {
  if (!/^\d+$/.test(value))
    throw new Error("--limit must be a positive integer.");
  const limit = Number(value);
  if (limit < 1 || limit > MAX_ENRICHMENT_ITEMS_PER_RUN) {
    throw new Error(
      `--limit must be between 1 and ${MAX_ENRICHMENT_ITEMS_PER_RUN}.`,
    );
  }
  return limit;
}

export function parseBackfillArgs(args: string[]): BackfillCliOptions {
  const options: BackfillCliOptions = { environment: "local" };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--retry-failed") {
      options.retryFailed = true;
    } else if (argument === "--limit" || argument.startsWith("--limit=")) {
      const value = argument === "--limit" ? args[++index] : argument.slice(8);
      if (!value) throw new Error("--limit requires a value.");
      options.limit = parsePositiveLimit(value);
    } else if (argument === "--env" || argument.startsWith("--env=")) {
      const value = argument === "--env" ? args[++index] : argument.slice(6);
      if (value !== "local" && value !== "production") {
        throw new Error("--env must be local or production.");
      }
      options.environment = value;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

export function formatBackfillResult(result: BackfillResult): string {
  const lines = [
    result.dryRun ? "Enrichment backfill (dry run)" : "Enrichment backfill",
    `Processed: ${result.processed}`,
    `Skipped: ${result.skipped}`,
    `Succeeded: ${result.succeeded}`,
    `Unresolved: ${result.unresolved}`,
    `Failed: ${result.failed}`,
    `Summary requests: ${result.summaryRequests}`,
    `Embedded: ${result.embedded}`,
    `Embedding batches failed: ${result.embeddingFailures.length}`,
    `Provenance: feed ${result.byOrigin.feed}, page metadata ${result.byOrigin.page_metadata}, AI generated ${result.byOrigin.ai_generated}`,
  ];
  return lines.join("\n");
}

export function formatBackfillProgress(
  progress: BackfillProgressEvent,
): string {
  switch (progress.phase) {
    case "selection":
      return `Selected ${progress.total} item(s): ${progress.due} due, ${progress.exhausted} exhausted, ${progress.embeddingRecovery} embedding recovery.`;
    case "requeue":
      return `Requeuing ${progress.count} exhausted item(s).`;
    case "description":
      if (progress.status === "starting") {
        return `Description ${progress.current}/${progress.total}: processing.`;
      }
      if (progress.status === "completed") {
        const source =
          progress.origin === "ai_generated" ? "AI summary" : "page metadata";
        return `Description ${progress.current}/${progress.total}: saved (${source}).`;
      }
      if (progress.status === "unresolved") {
        return `Description ${progress.current}/${progress.total}: unresolved; retry scheduled.`;
      }
      if (progress.status === "failed") {
        return `Description ${progress.current}/${progress.total}: state update failed.`;
      }
      return `Description ${progress.current}/${progress.total}: skipped.`;
    case "embedding":
      return progress.status === "starting"
        ? `Embedding ${progress.total} item(s).`
        : `Embedding complete: ${progress.embedded} saved, ${progress.failedBatches} batch failure(s).`;
  }
}
