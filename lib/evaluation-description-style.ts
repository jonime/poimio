import { seededShuffle } from "./evaluation-agreement.ts";
import { descriptionStyleReviewConfig, readConfiguredJudgingCsv } from "./manual-judging.ts";
import { requireDefined } from "./required.ts";

export type DescriptionStyleLanguage = "fi" | "en";
export type DescriptionStyleExtractionStatus =
  | "complete"
  | "extraction_failure"
  | "http_or_timeout";
export type DescriptionStyleSummaryStatus =
  | "complete"
  | "refusal_or_empty"
  | "http_or_timeout"
  | "not_attempted";
export type DescriptionStyleSide = "A" | "B";
export type DescriptionStyleReviewSelection = DescriptionStyleSide | "both" | "neither";

export interface DescriptionStyleItem {
  id: string;
  source_id: string;
  type: string;
  url: string;
  title: string;
  language: DescriptionStyleLanguage;
  summary_origin: string;
  [key: string]: unknown;
}

export interface DescriptionStyleSampleEntry {
  itemId: string;
  sourceId: string;
  language: DescriptionStyleLanguage;
}

export interface DescriptionStyleSample {
  schemaVersion: 1;
  seed: number;
  snapshotManifestHash: string;
  poolCounts: {
    overall: number;
    byLanguage: Record<DescriptionStyleLanguage, number>;
    bySource: Record<DescriptionStyleLanguage, Record<string, number>>;
  };
  items: DescriptionStyleSampleEntry[];
}

export interface DescriptionStyleOutput {
  status: DescriptionStyleSummaryStatus;
  text: string | null;
  error: string | null;
}

export interface DescriptionStyleRunItem {
  itemId: string;
  sourceId: string;
  language: DescriptionStyleLanguage;
  title: string;
  url: string;
  finalUrl: string | null;
  extractionTimestamp: string;
  inputTextDigest: string | null;
  changedInputDigest: boolean;
  extractionStatus: DescriptionStyleExtractionStatus;
  extractionError: string | null;
  current: DescriptionStyleOutput;
  candidate: DescriptionStyleOutput;
  pairComplete: boolean;
}

export interface DescriptionStyleRun {
  schemaVersion: 1;
  runId: string;
  timestamp: string;
  sampleHash: string;
  model: string;
  currentInstructionHash: string;
  candidateInstructionHash: string;
  items: DescriptionStyleRunItem[];
}

export interface NarrationPattern {
  id: string;
  language: DescriptionStyleLanguage;
  pattern: string;
}

export interface NarrationPatternConfig {
  schemaVersion: 1;
  normalization: readonly string[];
  patterns: NarrationPattern[];
}

export interface DescriptionStyleBlindKeyEntry {
  pairId: string;
  itemId: string;
  current: DescriptionStyleSide;
  candidate: DescriptionStyleSide;
}

export interface DescriptionStyleBlindReview {
  csv: string;
  key: DescriptionStyleBlindKeyEntry[];
}

export interface DescriptionStyleMetrics {
  reviewedPairs: number;
  currentNarrationOpenings: number;
  candidateNarrationOpenings: number;
  candidateWins: number;
  candidateLosses: number;
  ties: number;
  preferenceRate: number | null;
  candidateUnsupported: number;
  candidateWrongLanguage: number;
  candidateLaterNarration: number;
  sampleSufficient: boolean;
  narrationTargetMet: boolean;
  preferenceTargetMet: boolean;
  accuracyTargetMet: boolean;
  targetsMet: boolean;
  decision: "meets" | "misses" | "inconclusive";
}

export interface DescriptionStyleScore {
  overall: DescriptionStyleMetrics;
  fi: DescriptionStyleMetrics;
  en: DescriptionStyleMetrics;
}

export interface DescriptionStyleFailureCounts {
  extractionFailures: number;
  fetchFailures: number;
  refusalOrEmpty: { current: number; candidate: number };
  summaryHttpOrTimeout: { current: number; candidate: number };
  completePairs: number;
}

export function assertDescriptionStyleRunAllowed(
  environment: Record<string, string | undefined>,
): string {
  if (environment.CI !== undefined) {
    throw new Error("Description-style comparison must not run in CI");
  }
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  return apiKey;
}

export function classifyExtractionFailure(error: string): DescriptionStyleExtractionStatus {
  return error === "page has no readable article text" ||
    error.startsWith("article extraction failed")
    ? "extraction_failure"
    : "http_or_timeout";
}

export function classifySummaryFailure(
  error: unknown,
): Exclude<DescriptionStyleSummaryStatus, "complete" | "not_attempted"> {
  const message = error instanceof Error ? error.message : String(error);
  return /no text|empty|refus/iu.test(message) ? "refusal_or_empty" : "http_or_timeout";
}

export function parseDescriptionStyleItems(value: string): DescriptionStyleItem[] {
  const items: DescriptionStyleItem[] = [];
  for (const [index, line] of value.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`snapshot items has invalid JSON on line ${index + 1}`);
    }
    if (
      row === null ||
      typeof row !== "object" ||
      !("id" in row) ||
      typeof row.id !== "string" ||
      !("source_id" in row) ||
      typeof row.source_id !== "string" ||
      !("type" in row) ||
      typeof row.type !== "string" ||
      !("url" in row) ||
      typeof row.url !== "string" ||
      !("title" in row) ||
      typeof row.title !== "string" ||
      !("language" in row) ||
      (row.language !== "fi" && row.language !== "en") ||
      !("summary_origin" in row) ||
      typeof row.summary_origin !== "string"
    ) {
      throw new Error(`snapshot items has an invalid row on line ${index + 1}`);
    }
    items.push(row as DescriptionStyleItem);
  }
  return items;
}

function roundRobinSample(
  items: DescriptionStyleItem[],
  language: DescriptionStyleLanguage,
  seed: number,
  quota: number,
): DescriptionStyleSampleEntry[] {
  const groups = new Map<string, DescriptionStyleItem[]>();
  for (const item of items
    .filter((candidate) => candidate.language === language)
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const group = groups.get(item.source_id) ?? [];
    group.push(item);
    groups.set(item.source_id, group);
  }
  const sourceOrder = seededShuffle([...groups.keys()], `${seed}:sources:${language}`);
  if (
    sourceOrder.length === 0 ||
    items.filter((item) => item.language === language).length < quota
  ) {
    throw new Error(`description-style sample needs ${quota} eligible ${language} items`);
  }
  const shuffledGroups = new Map(
    sourceOrder.map((sourceId) => [
      sourceId,
      seededShuffle(
        requireDefined(groups.get(sourceId), `source ${sourceId}`),
        `${seed}:items:${language}:${sourceId}`,
      ),
    ]),
  );
  const selected: DescriptionStyleSampleEntry[] = [];
  for (let round = 0; selected.length < quota; round += 1) {
    let added = false;
    for (const sourceId of sourceOrder) {
      const item = requireDefined(shuffledGroups.get(sourceId), `source ${sourceId}`)[round];
      if (item) {
        selected.push({ itemId: item.id, sourceId, language });
        added = true;
        if (selected.length === quota) break;
      }
    }
    if (!added) throw new Error(`description-style ${language} sample could not fill its quota`);
  }
  return selected;
}

export function createDescriptionStyleSample(input: {
  items: DescriptionStyleItem[];
  seed: number;
  snapshotManifestHash: string;
  perLanguage?: number;
}): DescriptionStyleSample {
  const perLanguage = input.perLanguage ?? 12;
  if (!Number.isSafeInteger(input.seed) || !Number.isInteger(perLanguage) || perLanguage < 1) {
    throw new Error("description-style seed and quota must be valid integers");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.snapshotManifestHash)) {
    throw new Error("description-style snapshot manifest hash must be SHA-256");
  }
  const pool = input.items.filter(
    (item) => item.type === "article" && item.summary_origin === "ai_generated",
  );
  const bySource: Record<DescriptionStyleLanguage, Record<string, number>> = { fi: {}, en: {} };
  for (const item of pool) {
    bySource[item.language][item.source_id] = (bySource[item.language][item.source_id] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    seed: input.seed,
    snapshotManifestHash: input.snapshotManifestHash,
    poolCounts: {
      overall: pool.length,
      byLanguage: {
        fi: pool.filter((item) => item.language === "fi").length,
        en: pool.filter((item) => item.language === "en").length,
      },
      bySource,
    },
    items: [
      ...roundRobinSample(pool, "fi", input.seed, perLanguage),
      ...roundRobinSample(pool, "en", input.seed, perLanguage),
    ],
  };
}

export function validateDescriptionStyleSample(
  value: unknown,
  snapshotManifestHash: string,
): DescriptionStyleSample {
  if (
    value === null ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("seed" in value) ||
    !Number.isSafeInteger(value.seed) ||
    !("snapshotManifestHash" in value) ||
    value.snapshotManifestHash !== snapshotManifestHash ||
    !("items" in value) ||
    !Array.isArray(value.items) ||
    value.items.length !== 24
  ) {
    throw new Error("description-style sample is invalid or belongs to another snapshot");
  }
  const ids = new Set<string>();
  for (const item of value.items) {
    if (
      item === null ||
      typeof item !== "object" ||
      !("itemId" in item) ||
      typeof item.itemId !== "string" ||
      !("sourceId" in item) ||
      typeof item.sourceId !== "string" ||
      !("language" in item) ||
      (item.language !== "fi" && item.language !== "en") ||
      ids.has(item.itemId)
    ) {
      throw new Error("description-style sample has an invalid or duplicate item");
    }
    ids.add(item.itemId);
  }
  const sample = value as DescriptionStyleSample;
  if (
    sample.items.filter((item) => item.language === "fi").length !== 12 ||
    sample.items.filter((item) => item.language === "en").length !== 12
  ) {
    throw new Error("description-style sample must contain 12 items per language");
  }
  return sample;
}

export function parseNarrationPatterns(value: unknown): NarrationPatternConfig {
  if (
    value === null ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("normalization" in value) ||
    !Array.isArray(value.normalization) ||
    value.normalization.length !== 2 ||
    value.normalization[0] !== "trim" ||
    value.normalization[1] !== "collapseWhitespace" ||
    !("patterns" in value) ||
    !Array.isArray(value.patterns) ||
    value.patterns.length === 0
  ) {
    throw new Error("narration patterns are invalid");
  }
  for (const pattern of value.patterns) {
    if (
      pattern === null ||
      typeof pattern !== "object" ||
      !("id" in pattern) ||
      typeof pattern.id !== "string" ||
      !("language" in pattern) ||
      (pattern.language !== "fi" && pattern.language !== "en") ||
      !("pattern" in pattern) ||
      typeof pattern.pattern !== "string"
    ) {
      throw new Error("narration pattern is invalid");
    }
    try {
      new RegExp(pattern.pattern, "iu");
    } catch {
      throw new Error(`narration pattern ${pattern.id} is not a valid regular expression`);
    }
  }
  return value as NarrationPatternConfig;
}

export function hasNarrationOpening(
  text: string,
  language: DescriptionStyleLanguage,
  config: NarrationPatternConfig,
): boolean {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const sentence = normalized.match(/^.*?[.!?](?:\s|$)/u)?.[0] ?? normalized;
  return config.patterns.some(
    (pattern) => pattern.language === language && new RegExp(pattern.pattern, "iu").test(sentence),
  );
}

export function countDescriptionStyleFailures(
  items: DescriptionStyleRunItem[],
): DescriptionStyleFailureCounts {
  return {
    extractionFailures: items.filter((item) => item.extractionStatus === "extraction_failure")
      .length,
    fetchFailures: items.filter((item) => item.extractionStatus === "http_or_timeout").length,
    refusalOrEmpty: {
      current: items.filter((item) => item.current.status === "refusal_or_empty").length,
      candidate: items.filter((item) => item.candidate.status === "refusal_or_empty").length,
    },
    summaryHttpOrTimeout: {
      current: items.filter((item) => item.current.status === "http_or_timeout").length,
      candidate: items.filter((item) => item.candidate.status === "http_or_timeout").length,
    },
    completePairs: items.filter((item) => item.pairComplete).length,
  };
}

function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function encodeCsv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => row.map(csvField).join(",")).join("\n")}\n`;
}

export function createDescriptionStyleBlindReview(
  run: DescriptionStyleRun,
  seed: number,
): DescriptionStyleBlindReview {
  const key: DescriptionStyleBlindKeyEntry[] = [];
  const rows: string[][] = [
    [
      "pair_id",
      "title",
      "language",
      "item_url",
      "description_a",
      "description_b",
      "preference",
      "unsupported",
      "wrong_language",
      "later_sentence_narration",
    ],
  ];
  for (const item of run.items.filter(
    (entry) => entry.pairComplete && entry.current.text !== null && entry.candidate.text !== null,
  )) {
    const order = seededShuffle(["current", "candidate"] as const, `${seed}:${item.itemId}`);
    const a = requireDefined(order[0], `A/B order for ${item.itemId}`);
    const currentSide: DescriptionStyleSide = a === "current" ? "A" : "B";
    const candidateSide: DescriptionStyleSide = a === "candidate" ? "A" : "B";
    const pairId = `${run.runId}:${item.itemId}`;
    key.push({ pairId, itemId: item.itemId, current: currentSide, candidate: candidateSide });
    const aText = requireDefined(
      a === "current" ? item.current.text : item.candidate.text,
      "A text",
    );
    const bText = requireDefined(
      a === "candidate" ? item.current.text : item.candidate.text,
      "B text",
    );
    rows.push([pairId, item.title, item.language, item.url, aText, bText, "", "", "", ""]);
  }
  return { csv: encodeCsv(rows), key };
}

function selectedSideHasCandidate(selection: string, candidateSide: DescriptionStyleSide): boolean {
  return selection === candidateSide || selection === "both";
}

function metricsForRows(
  rows: Array<{
    language: DescriptionStyleLanguage;
    preference: string;
    unsupported: string;
    wrongLanguage: string;
    laterNarration: string;
    currentSide: DescriptionStyleSide;
    candidateSide: DescriptionStyleSide;
    currentNarration: boolean;
    candidateNarration: boolean;
  }>,
  minimumPairs: number,
): DescriptionStyleMetrics {
  const currentNarrationOpenings = rows.filter((row) => row.currentNarration).length;
  const candidateNarrationOpenings = rows.filter((row) => row.candidateNarration).length;
  const candidateWins = rows.filter((row) => row.preference === row.candidateSide).length;
  const candidateLosses = rows.filter((row) => row.preference === row.currentSide).length;
  const ties = rows.filter((row) => row.preference === "tie").length;
  const reviewedPairs = rows.length;
  const preferenceRate = reviewedPairs === 0 ? null : (candidateWins + ties) / reviewedPairs;
  const candidateUnsupported = rows.filter((row) =>
    selectedSideHasCandidate(row.unsupported, row.candidateSide),
  ).length;
  const candidateWrongLanguage = rows.filter((row) =>
    selectedSideHasCandidate(row.wrongLanguage, row.candidateSide),
  ).length;
  const candidateLaterNarration = rows.filter((row) =>
    selectedSideHasCandidate(row.laterNarration, row.candidateSide),
  ).length;
  const sampleSufficient = reviewedPairs >= minimumPairs;
  const narrationTargetMet =
    candidateNarrationOpenings <= 1 && candidateNarrationOpenings < currentNarrationOpenings;
  const preferenceTargetMet =
    preferenceRate !== null && preferenceRate >= 0.8 && candidateWins > candidateLosses;
  const accuracyTargetMet = candidateUnsupported === 0 && candidateWrongLanguage === 0;
  const targetsMet = narrationTargetMet && preferenceTargetMet && accuracyTargetMet;
  return {
    reviewedPairs,
    currentNarrationOpenings,
    candidateNarrationOpenings,
    candidateWins,
    candidateLosses,
    ties,
    preferenceRate,
    candidateUnsupported,
    candidateWrongLanguage,
    candidateLaterNarration,
    sampleSufficient,
    narrationTargetMet,
    preferenceTargetMet,
    accuracyTargetMet,
    targetsMet,
    decision: !sampleSufficient ? "inconclusive" : targetsMet ? "meets" : "misses",
  };
}

export function scoreDescriptionStyleReview(input: {
  csv: string;
  key: DescriptionStyleBlindKeyEntry[];
  run: DescriptionStyleRun;
  patterns: NarrationPatternConfig;
}): DescriptionStyleScore {
  const keyByPair = new Map(input.key.map((entry) => [entry.pairId, entry]));
  if (keyByPair.size !== input.key.length) throw new Error("review key contains duplicate pairs");
  const itemById = new Map(input.run.items.map((item) => [item.itemId, item]));
  const configuredRows = readConfiguredJudgingCsv(input.csv, descriptionStyleReviewConfig);
  const seenPairs = new Set<string>();
  for (const { values } of configuredRows) {
    const pairId = values.pair_id ?? "";
    if (seenPairs.has(pairId)) throw new Error(`review CSV contains duplicate pair ${pairId}`);
    seenPairs.add(pairId);
  }
  if (seenPairs.size !== keyByPair.size || [...keyByPair.keys()].some((id) => !seenPairs.has(id))) {
    throw new Error("review CSV must contain every generated pair exactly once");
  }
  const rows = configuredRows.map(({ values }, index) => {
    const pairId = requireDefined(values.pair_id, `pair ID at row ${index + 2}`);
    const key = requireDefined(keyByPair.get(pairId), `review key for ${pairId}`);
    const item = requireDefined(itemById.get(key.itemId), `run item ${key.itemId}`);
    const currentSideText = key.current === "A" ? values.description_a : values.description_b;
    const candidateSideText = key.candidate === "A" ? values.description_a : values.description_b;
    if (
      currentSideText !== item.current.text ||
      candidateSideText !== item.candidate.text ||
      values.title !== item.title ||
      values.language !== item.language ||
      values.item_url !== item.url
    ) {
      throw new Error(`review row ${index + 2} differs from the generated pair`);
    }
    const answerValues = [
      values.preference ?? "",
      values.unsupported ?? "",
      values.wrong_language ?? "",
      values.later_sentence_narration ?? "",
    ];
    const answered = answerValues.filter((value) => value !== "").length;
    if (answered !== 0 && answered !== answerValues.length) {
      throw new Error(`review row ${index + 2} is only partially reviewed`);
    }
    if (answered === 0) return null;
    return {
      language: item.language,
      preference: requireDefined(values.preference, "preference"),
      unsupported: requireDefined(values.unsupported, "unsupported"),
      wrongLanguage: requireDefined(values.wrong_language, "wrong language"),
      laterNarration: requireDefined(values.later_sentence_narration, "later narration"),
      currentSide: key.current,
      candidateSide: key.candidate,
      currentNarration: hasNarrationOpening(
        requireDefined(item.current.text, "current text"),
        item.language,
        input.patterns,
      ),
      candidateNarration: hasNarrationOpening(
        requireDefined(item.candidate.text, "candidate text"),
        item.language,
        input.patterns,
      ),
    };
  });
  const reviewed = rows.filter((row) => row !== null);
  return {
    overall: metricsForRows(reviewed, 20),
    fi: metricsForRows(
      reviewed.filter((row) => row.language === "fi"),
      10,
    ),
    en: metricsForRows(
      reviewed.filter((row) => row.language === "en"),
      10,
    ),
  };
}
