import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCsv, parseCsv } from "../lib/early-ranking.ts";
import {
  type EvaluationSnapshotManifest,
  parseJsonLines,
  requireFinalSnapshot,
  type SnapshotRow,
  validateSnapshotData,
} from "../lib/evaluation-snapshot.ts";
import { requireDefined } from "../lib/required.ts";
import {
  buildStandInPages,
  canonicalPairKey,
  evaluateSameLanguageCheck,
  evaluateTxlDecision,
  meanKey,
  SAME_LANGUAGE_STORY_THRESHOLD,
  type StoryEdge,
  type StoryGroupCandidate,
  selectReviewEdges,
  TXL_CANDIDATE_THRESHOLDS,
} from "../lib/story-groups.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotDir = resolve(root, "evaluation/snapshot");
const outputDir = resolve(root, "evaluation/story-groups");
const crosslingualScorePath = resolve(root, "evaluation/crosslingual/score.json");

interface SnapshotItem extends StoryGroupCandidate {
  publishedAt: string;
  sourceId: string;
  title: string;
}

function parseVector(value: unknown, label: string): number[] {
  const vector = Array.isArray(value)
    ? value.map(Number)
    : typeof value === "string"
      ? value.slice(1, -1).split(",").map(Number)
      : [];
  if (vector.length !== 512 || vector.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`${label} has an invalid 512-dimensional vector`);
  }
  return vector;
}

async function loadConfirmedPairKeys(): Promise<{
  keys: Set<string>;
  hash: string;
}> {
  const text = await readFile(crosslingualScorePath, "utf8");
  const parsed = JSON.parse(text) as {
    matchedPairs?: Array<{ englishItemId: string; finnishItemId: string }>;
  };
  const keys = new Set<string>();
  for (const pair of parsed.matchedPairs ?? []) {
    keys.add(canonicalPairKey(pair.englishItemId, pair.finnishItemId));
  }
  return {
    keys,
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

async function loadExistingReviews(path: string): Promise<Map<string, boolean>> {
  const reviews = new Map<string, boolean>();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return reviews;
    }
    throw error;
  }
  const [header, ...rows] = parseCsv(text);
  if (!header) return reviews;
  const cols = new Map(header.map((name, index) => [name, index]));
  const aIdx = cols.get("item_a_id");
  const bIdx = cols.get("item_b_id");
  const sameIdx = cols.get("same_story");
  if (aIdx === undefined || bIdx === undefined || sameIdx === undefined) {
    return reviews;
  }
  for (const row of rows) {
    const a = row[aIdx] ?? "";
    const b = row[bIdx] ?? "";
    const val = (row[sameIdx] ?? "").trim();
    if (!a || !b) continue;
    if (val === "1") reviews.set(canonicalPairKey(a, b), true);
    else if (val === "0") reviews.set(canonicalPairKey(a, b), false);
  }
  return reviews;
}

async function main(): Promise<void> {
  if (process.env.CI === "true") {
    throw new Error("Story-group evaluation is disabled in CI");
  }

  const [manifestText, sourceText, itemText, meanText, confirmed] = await Promise.all([
    readFile(resolve(snapshotDir, "manifest.json"), "utf8"),
    readFile(resolve(snapshotDir, "sources.jsonl"), "utf8"),
    readFile(resolve(snapshotDir, "items.jsonl"), "utf8"),
    readFile(resolve(snapshotDir, "means.jsonl"), "utf8"),
    loadConfirmedPairKeys(),
  ]);

  const manifest = JSON.parse(manifestText) as EvaluationSnapshotManifest;
  requireFinalSnapshot(manifest);
  const sourceRows = parseJsonLines<SnapshotRow>(sourceText, "sources.jsonl");
  const itemRows = parseJsonLines<SnapshotRow>(itemText, "items.jsonl");
  const meanRows = parseJsonLines<SnapshotRow>(meanText, "means.jsonl");

  validateSnapshotData({
    manifest,
    sources: sourceRows,
    items: itemRows,
    means: meanRows,
  });

  const means = new Map(
    meanRows.map((row) => [
      meanKey(String(row.embedding_model), String(row.language)),
      parseVector(row.mean, `mean ${String(row.embedding_model)}:${String(row.language)}`),
    ]),
  );

  const sourceNames = new Map(sourceRows.map((row) => [String(row.id), String(row.name)]));
  const validationIds = new Set(manifest.windows.validation.itemIds);
  const validationItems: SnapshotItem[] = [];
  for (const row of itemRows) {
    const id = String(row.id);
    if (!validationIds.has(id)) continue;
    validationItems.push({
      id,
      sourceId: String(row.source_id),
      title: String(row.title),
      language: String(row.language),
      embeddingModel: typeof row.embedding_model === "string" ? row.embedding_model : null,
      embedding: row.embedding ? parseVector(row.embedding, `item ${id}`) : null,
      enrichmentStatus: typeof row.enrichment_status === "string" ? row.enrichment_status : null,
      summary: typeof row.summary === "string" ? row.summary : null,
      publishedAt: String(row.published_at),
      exploration: false,
    });
  }

  const itemById = new Map(validationItems.map((item) => [item.id, item]));
  const pages = buildStandInPages(validationItems);

  const edges50 = selectReviewEdges({
    pages,
    means,
    crossLingualThreshold: TXL_CANDIDATE_THRESHOLDS[0],
    confirmedPairKeys: confirmed.keys,
    reviewedPairKeys: new Set(),
  }).filter((edge) => edge.kind === "fi-en");

  const edges55 = selectReviewEdges({
    pages,
    means,
    crossLingualThreshold: TXL_CANDIDATE_THRESHOLDS[1],
    confirmedPairKeys: confirmed.keys,
    reviewedPairKeys: new Set(),
  }).filter((edge) => edge.kind === "fi-en");

  const sameLangEdges = selectReviewEdges({
    pages,
    means,
    crossLingualThreshold: null,
    confirmedPairKeys: confirmed.keys,
    reviewedPairKeys: new Set(),
  });
  const fiEdges = sameLangEdges.filter((edge) => edge.kind === "fi");
  const enEdges = sameLangEdges.filter((edge) => edge.kind === "en");

  const reviewCsvPath = resolve(outputDir, "review.csv");
  const existingReviews = await loadExistingReviews(reviewCsvPath);

  const selectedReviewEdges: Array<{ bucket: string; edge: StoryEdge }> = [];
  const selectedKeys = new Set<string>();
  const addEdges = (bucket: string, edges: readonly StoryEdge[], maxCount: number) => {
    let added = 0;
    for (const edge of edges) {
      if (added >= maxCount) break;
      const key = canonicalPairKey(edge.itemAId, edge.itemBId);
      if (selectedKeys.has(key)) continue;
      selectedKeys.add(key);
      selectedReviewEdges.push({ bucket, edge });
      added += 1;
    }
  };

  addEdges("fi-en@0.50", edges50, 10);
  addEdges("fi-en@0.55", edges55, 10);
  addEdges("fi@0.74", fiEdges, 5);
  addEdges("en@0.74", enEdges, 5);

  const csvRows = [
    [
      "bucket",
      "kind",
      "similarity",
      "threshold",
      "item_a_id",
      "item_a_source",
      "item_a_title",
      "item_b_id",
      "item_b_source",
      "item_b_title",
      "same_story",
    ],
    ...selectedReviewEdges.map(({ bucket, edge }) => {
      const a = requireDefined(itemById.get(edge.itemAId), `item ${edge.itemAId}`);
      const b = requireDefined(itemById.get(edge.itemBId), `item ${edge.itemBId}`);
      const key = canonicalPairKey(edge.itemAId, edge.itemBId);
      const reviewed = existingReviews.get(key);
      return [
        bucket,
        edge.kind,
        edge.similarity.toFixed(6),
        edge.threshold.toFixed(2),
        edge.itemAId,
        sourceNames.get(a.sourceId) ?? a.sourceId,
        a.title,
        edge.itemBId,
        sourceNames.get(b.sourceId) ?? b.sourceId,
        b.title,
        reviewed === undefined ? "" : reviewed ? "1" : "0",
      ];
    }),
  ];

  const txlDecision = evaluateTxlDecision({
    edgesByThreshold: [
      { threshold: TXL_CANDIDATE_THRESHOLDS[0], edges: edges50 },
      { threshold: TXL_CANDIDATE_THRESHOLDS[1], edges: edges55 },
    ],
    reviewsByPairKey: existingReviews,
  });

  const sameLanguageCheck = evaluateSameLanguageCheck({
    finnishEdges: fiEdges,
    englishEdges: enEdges,
    reviewsByPairKey: existingReviews,
  });

  const report = {
    snapshotManifestHash: createHash("sha256").update(manifestText).digest("hex"),
    crosslingualScoreHash: confirmed.hash,
    sameLanguageThreshold: SAME_LANGUAGE_STORY_THRESHOLD,
    validationItemCount: validationItems.length,
    standInPageCount: pages.length,
    confirmedExcludedCount: confirmed.keys.size,
    availableEdgeCounts: {
      fiEnAt50: edges50.length,
      fiEnAt55: edges55.length,
      fiAt74: fiEdges.length,
      enAt74: enEdges.length,
    },
    txlDecision,
    sameLanguageCheck,
    reviewedPairs: selectedReviewEdges.map(({ bucket, edge }) => {
      const key = canonicalPairKey(edge.itemAId, edge.itemBId);
      return {
        bucket,
        kind: edge.kind,
        itemAId: edge.itemAId,
        itemBId: edge.itemBId,
        similarity: edge.similarity,
        threshold: edge.threshold,
        sameStory: existingReviews.get(key) ?? null,
      };
    }),
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(reviewCsvPath, encodeCsv(csvRows), "utf8");
  await writeFile(
    resolve(outputDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `Wrote ${selectedReviewEdges.length} review pairs to ${reviewCsvPath} and report to ${resolve(outputDir, "report.json")}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
