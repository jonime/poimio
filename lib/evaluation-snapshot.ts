import { createHash } from "node:crypto";

export const EVALUATION_SNAPSHOT_SCHEMA_VERSION = 1;
export const MINIMUM_SNAPSHOT_SPAN_MS = 14 * 24 * 60 * 60 * 1000;

export const SNAPSHOT_ITEM_COLUMNS = [
  "id",
  "source_id",
  "type",
  "url",
  "title",
  "summary",
  "summary_origin",
  "enrichment_status",
  "enrichment_attempt_count",
  "enrichment_last_attempt_at",
  "enrichment_next_attempt_at",
  "enrichment_error",
  "language",
  "categories",
  "thumbnail_url",
  "published_at",
  "embedding",
  "embedding_model",
  "created_at",
] as const;

export const SNAPSHOT_SOURCE_COLUMNS = [
  "id",
  "name",
  "feed_url",
  "site_url",
  "kind",
  "language",
  "is_active",
  "etag",
  "last_modified",
  "last_fetched_at",
  "last_success_at",
  "last_error",
  "created_at",
] as const;

export const SNAPSHOT_MEAN_COLUMNS = [
  "embedding_model",
  "language",
  "mean",
  "item_count",
  "computed_at",
] as const;

export type SnapshotRow = Record<string, unknown>;

export interface SnapshotWindow {
  startIndex: number;
  endIndexExclusive: number;
  firstItemId: string | null;
  lastItemId: string | null;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  itemIds: string[];
}

export interface EvaluationSnapshotManifest {
  schemaVersion: number;
  provisional: boolean;
  createdAt: string;
  dateRange: { from: string; toExclusive: string };
  windows: {
    feedback: SnapshotWindow;
    validation: SnapshotWindow;
    test: SnapshotWindow;
  };
  itemIds: string[];
  itemRowHashes: Record<string, string>;
  meanVectorHashes: Record<string, string>;
  counts: {
    items: number;
    sources: number;
    means: number;
    byLanguage: Record<string, number>;
    bySource: Record<string, number>;
  };
}

export interface SnapshotDateRange {
  from: string;
  toExclusive: string;
}

export function requireFinalSnapshot(
  manifest: EvaluationSnapshotManifest,
): void {
  if (manifest.provisional !== false) {
    throw new Error("Freeze and test runs require a non-provisional snapshot");
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashSnapshotRow(row: SnapshotRow): string {
  return sha256(JSON.stringify(canonicalize(row)));
}

export function meanHashKey(row: SnapshotRow): string {
  return `${String(row.embedding_model)}:${String(row.language)}`;
}

export function parseSnapshotDateRange(
  from: string | undefined,
  toExclusive: string | undefined,
  provisional = false,
): SnapshotDateRange {
  if (!from || !toExclusive) {
    throw new Error("Both --from and --to are required (the end is exclusive)");
  }
  const fromTime = Date.parse(from);
  const toTime = Date.parse(toExclusive);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) {
    throw new Error("Snapshot dates must be valid ISO-8601 timestamps");
  }
  if (toTime <= fromTime) {
    throw new Error("Snapshot end must be later than its start");
  }
  if (!provisional && toTime - fromTime < MINIMUM_SNAPSHOT_SPAN_MS) {
    throw new Error("The snapshot date range must cover at least 14 days");
  }
  return {
    from: new Date(fromTime).toISOString(),
    toExclusive: new Date(toTime).toISOString(),
  };
}

export function requireProductionUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  ) {
    throw new Error("Evaluation export requires an HTTPS production URL");
  }
  return url;
}

export function requireLocalSupabaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55321"
  ) {
    throw new Error(
      "Evaluation import is restricted to local Supabase at http://127.0.0.1:55321",
    );
  }
  return url;
}

export function parseJsonLines<T>(content: string, label: string): T[] {
  return content
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`${label} has invalid JSON on line ${index + 1}`);
      }
    });
}

export function stringifyJsonLines(rows: SnapshotRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function assertColumns(
  rows: SnapshotRow[],
  requiredColumns: readonly string[],
  label: string,
): void {
  rows.forEach((row, index) => {
    const missing = requiredColumns.filter(
      (column) => !Object.hasOwn(row, column),
    );
    if (missing.length > 0) {
      throw new Error(
        `${label} row ${index + 1} is missing columns: ${missing.join(", ")}`,
      );
    }
  });
}

function snapshotWindow(
  rows: SnapshotRow[],
  startIndex: number,
  endIndexExclusive: number,
): SnapshotWindow {
  const windowRows = rows.slice(startIndex, endIndexExclusive);
  const first = windowRows[0];
  const last = windowRows.at(-1);
  return {
    startIndex,
    endIndexExclusive,
    firstItemId: first ? String(first.id) : null,
    lastItemId: last ? String(last.id) : null,
    firstPublishedAt: first ? String(first.published_at) : null,
    lastPublishedAt: last ? String(last.published_at) : null,
    itemIds: windowRows.map((row) => String(row.id)),
  };
}

export function buildSnapshotManifest(input: {
  dateRange: SnapshotDateRange;
  sources: SnapshotRow[];
  items: SnapshotRow[];
  means: SnapshotRow[];
  provisional?: boolean;
  createdAt?: string;
}): EvaluationSnapshotManifest {
  const { dateRange, sources, items, means } = input;
  const provisional = input.provisional ?? false;
  assertColumns(items, SNAPSHOT_ITEM_COLUMNS, "item");
  assertColumns(sources, SNAPSHOT_SOURCE_COLUMNS, "source");
  assertColumns(means, SNAPSHOT_MEAN_COLUMNS, "mean");

  const sortedItems = [...items].sort((left, right) => {
    const timeOrder = String(left.published_at).localeCompare(
      String(right.published_at),
    );
    return timeOrder || String(left.id).localeCompare(String(right.id));
  });
  if (sortedItems.length === 0) {
    throw new Error("The snapshot contains no eligible items");
  }
  const firstPublished = Date.parse(String(sortedItems[0]!.published_at));
  const lastPublished = Date.parse(String(sortedItems.at(-1)!.published_at));
  if (
    !Number.isFinite(firstPublished) ||
    !Number.isFinite(lastPublished) ||
    (!provisional && lastPublished - firstPublished < MINIMUM_SNAPSHOT_SPAN_MS)
  ) {
    throw new Error("Eligible snapshot items must span at least 14 days");
  }

  const feedbackEnd = Math.round(sortedItems.length * 0.5);
  const validationEnd = Math.round(sortedItems.length * 0.75);
  const itemIds = sortedItems.map((row) => String(row.id));
  const itemRowHashes = Object.fromEntries(
    sortedItems.map((row) => [String(row.id), hashSnapshotRow(row)]),
  );
  const meanVectorHashes = Object.fromEntries(
    [...means]
      .sort((left, right) =>
        meanHashKey(left).localeCompare(meanHashKey(right)),
      )
      .map((row) => [
        meanHashKey(row),
        sha256(JSON.stringify(canonicalize(row.mean))),
      ]),
  );
  const byLanguage: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const row of sortedItems) {
    const language = String(row.language);
    const sourceId = String(row.source_id);
    byLanguage[language] = (byLanguage[language] ?? 0) + 1;
    bySource[sourceId] = (bySource[sourceId] ?? 0) + 1;
  }

  return {
    schemaVersion: EVALUATION_SNAPSHOT_SCHEMA_VERSION,
    provisional,
    createdAt: input.createdAt ?? new Date().toISOString(),
    dateRange,
    windows: {
      feedback: snapshotWindow(sortedItems, 0, feedbackEnd),
      validation: snapshotWindow(sortedItems, feedbackEnd, validationEnd),
      test: snapshotWindow(sortedItems, validationEnd, sortedItems.length),
    },
    itemIds,
    itemRowHashes,
    meanVectorHashes,
    counts: {
      items: sortedItems.length,
      sources: sources.length,
      means: means.length,
      byLanguage,
      bySource,
    },
  };
}

export function validateSnapshotData(input: {
  manifest: EvaluationSnapshotManifest;
  sources: SnapshotRow[];
  items: SnapshotRow[];
  means: SnapshotRow[];
}): void {
  const { manifest, sources, items, means } = input;
  if (manifest.schemaVersion !== EVALUATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Snapshot schema ${manifest.schemaVersion} is unsupported; expected ${EVALUATION_SNAPSHOT_SCHEMA_VERSION}`,
    );
  }
  assertColumns(items, SNAPSHOT_ITEM_COLUMNS, "item");
  assertColumns(sources, SNAPSHOT_SOURCE_COLUMNS, "source");
  assertColumns(means, SNAPSHOT_MEAN_COLUMNS, "mean");

  const itemIds = items.map((row) => String(row.id));
  if (new Set(itemIds).size !== itemIds.length) {
    throw new Error("Snapshot contains duplicate item IDs");
  }
  if (
    itemIds.length !== manifest.itemIds.length ||
    manifest.itemIds.some((id) => !itemIds.includes(id))
  ) {
    throw new Error("Snapshot item IDs do not match the manifest");
  }
  const expectedManifest = buildSnapshotManifest({
    dateRange: manifest.dateRange,
    sources,
    items,
    means,
    provisional: manifest.provisional,
    createdAt: manifest.createdAt,
  });
  if (
    JSON.stringify(expectedManifest.itemIds) !==
      JSON.stringify(manifest.itemIds) ||
    JSON.stringify(expectedManifest.windows) !==
      JSON.stringify(manifest.windows) ||
    JSON.stringify(expectedManifest.counts) !== JSON.stringify(manifest.counts)
  ) {
    throw new Error("Snapshot windows or counts do not match the manifest");
  }
  const expectedItemHashIds = Object.keys(manifest.itemRowHashes).sort();
  if (expectedItemHashIds.join("\n") !== [...itemIds].sort().join("\n")) {
    throw new Error("Manifest item hashes do not match the snapshot item IDs");
  }
  for (const row of items) {
    const id = String(row.id);
    if (hashSnapshotRow(row) !== manifest.itemRowHashes[id]) {
      throw new Error(`Item hash mismatch for ${id}`);
    }
  }

  const expectedMeans = Object.fromEntries(
    means.map((row) => [
      meanHashKey(row),
      sha256(JSON.stringify(canonicalize(row.mean))),
    ]),
  );
  if (
    JSON.stringify(Object.entries(expectedMeans).sort()) !==
    JSON.stringify(Object.entries(manifest.meanVectorHashes).sort())
  ) {
    throw new Error("Snapshot mean-vector hashes do not match the manifest");
  }

  const sourceIds = new Set(sources.map((row) => String(row.id)));
  const missingSource = items.find(
    (row) => !sourceIds.has(String(row.source_id)),
  );
  if (missingSource) {
    throw new Error(
      `Snapshot is missing source ${String(missingSource.source_id)}`,
    );
  }
  const meanKeys = new Set(means.map(meanHashKey));
  const missingMean = items.find(
    (row) =>
      !meanKeys.has(`${String(row.embedding_model)}:${String(row.language)}`),
  );
  if (missingMean) {
    throw new Error(
      `Snapshot is missing a mean for item ${String(missingMean.id)}`,
    );
  }
}
