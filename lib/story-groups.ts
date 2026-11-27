import { cosineSimilarity } from "./early-ranking.ts";
import { requireDefined } from "./required.ts";

export const ACTIVE_STORY_EMBEDDING_MODEL = "text-embedding-3-small@512";
export const SAME_LANGUAGE_STORY_THRESHOLD = 0.74;
export const MAX_STORY_GROUP_SIZE = 5;
export const STAND_IN_PAGE_SIZE = 30;
export const TXL_CANDIDATE_THRESHOLDS = [0.5, 0.55] as const;

export type StoryLanguage = "fi" | "en";

export interface StoryGroupCandidate {
  id: string;
  language: string;
  embeddingModel: string | null;
  embedding: number[] | null;
  enrichmentStatus: string | null;
  summary: string | null;
  exploration?: boolean;
  publishedAt?: string;
  sourceId?: string;
  title?: string;
}

export interface StoryGroupAssignment {
  id: string;
  duplicateOf: string | null;
  similarity: number | null;
}

export interface StoryEdge {
  itemAId: string;
  itemBId: string;
  representativeId: string;
  memberId: string;
  similarity: number;
  threshold: number;
  kind: "fi" | "en" | "fi-en";
}

export interface StandInPage<T extends StoryGroupCandidate = StoryGroupCandidate> {
  utcDay: string;
  pageIndex: number;
  items: T[];
}

export interface StoryReviewPairInput {
  itemAId: string;
  itemBId: string;
  sameStory: boolean;
}

export interface TxlStepResult {
  threshold: number;
  availableCount: number;
  reviewedCount: number;
  sameStoryCount: number;
  status: "passed" | "failed" | "insufficient_pairs";
}

export interface TxlDecision {
  chosenThreshold: number | null;
  steps: TxlStepResult[];
}

export interface SameLanguageCheckResult {
  finnishAvailable: number;
  englishAvailable: number;
  reviewedCount: number;
  sameStoryCount: number;
  passed: boolean;
  status: "passed" | "failed" | "insufficient_pairs";
}

export function canonicalPairKey(leftId: string, rightId: string): string {
  return leftId < rightId ? `${leftId}\u0000${rightId}` : `${rightId}\u0000${leftId}`;
}

export function canonicalPairIds(leftId: string, rightId: string): [string, string] {
  return leftId < rightId ? [leftId, rightId] : [rightId, leftId];
}

export function meanKey(embeddingModel: string, language: string): string {
  return `${embeddingModel}:${language}`;
}

export function subtractMean(vector: number[], mean: number[]): number[] {
  if (vector.length !== mean.length) {
    throw new Error("embedding dimensions do not match language mean");
  }
  return vector.map((value, index) => value - requireDefined(mean[index], `mean[${index}]`));
}

export function isZeroVector(vector: number[]): boolean {
  return vector.every((value) => value === 0);
}

export function isStoryItemEligible(
  item: StoryGroupCandidate,
  means: ReadonlyMap<string, number[]>,
  activeModel = ACTIVE_STORY_EMBEDDING_MODEL,
): boolean {
  if (item.embeddingModel !== activeModel) return false;
  if (!item.embedding || item.embedding.length === 0) return false;
  if (item.enrichmentStatus !== "completed") return false;
  if (item.summary === null || item.summary.trim().length === 0) return false;
  const mean = means.get(meanKey(item.embeddingModel, item.language));
  if (!mean || mean.length !== item.embedding.length) return false;
  return true;
}

export function centeredStorySimilarity(
  leftEmbedding: number[],
  leftMean: number[],
  rightEmbedding: number[],
  rightMean: number[],
): number {
  const leftCentered = subtractMean(leftEmbedding, leftMean);
  const rightCentered = subtractMean(rightEmbedding, rightMean);
  if (isZeroVector(leftCentered) || isZeroVector(rightCentered)) {
    return 0;
  }
  return cosineSimilarity(leftCentered, rightCentered);
}

export function pairThreshold(
  leftLanguage: string,
  rightLanguage: string,
  sameLanguageThreshold: number,
  crossLingualThreshold: number | null,
): number | null {
  if (leftLanguage === rightLanguage) {
    return sameLanguageThreshold;
  }
  if (
    crossLingualThreshold !== null &&
    ((leftLanguage === "fi" && rightLanguage === "en") ||
      (leftLanguage === "en" && rightLanguage === "fi"))
  ) {
    return crossLingualThreshold;
  }
  return null;
}

export function assignStoryGroups(input: {
  rows: readonly StoryGroupCandidate[];
  means: ReadonlyMap<string, number[]>;
  sameLanguageThreshold?: number;
  crossLingualThreshold: number | null;
  maxGroupSize?: number;
  activeModel?: string;
}): StoryGroupAssignment[] {
  const sameLanguageThreshold = input.sameLanguageThreshold ?? SAME_LANGUAGE_STORY_THRESHOLD;
  const maxGroupSize = input.maxGroupSize ?? MAX_STORY_GROUP_SIZE;
  const activeModel = input.activeModel ?? ACTIVE_STORY_EMBEDDING_MODEL;

  const representatives: Array<{
    id: string;
    language: string;
    centered: number[];
    size: number;
  }> = [];

  return input.rows.map((row): StoryGroupAssignment => {
    if (row.exploration === true || !isStoryItemEligible(row, input.means, activeModel)) {
      return { id: row.id, duplicateOf: null, similarity: null };
    }

    const embedding = requireDefined(row.embedding, `embedding for ${row.id}`);
    const model = requireDefined(row.embeddingModel, `embeddingModel for ${row.id}`);
    const mean = requireDefined(
      input.means.get(meanKey(model, row.language)),
      `mean for ${model}:${row.language}`,
    );
    const centered = subtractMean(embedding, mean);

    for (const rep of representatives) {
      if (rep.size >= maxGroupSize) continue;
      const threshold = pairThreshold(
        row.language,
        rep.language,
        sameLanguageThreshold,
        input.crossLingualThreshold,
      );
      if (threshold === null) continue;
      const similarity =
        isZeroVector(centered) || isZeroVector(rep.centered)
          ? 0
          : cosineSimilarity(centered, rep.centered);
      if (similarity >= threshold) {
        rep.size += 1;
        return { id: row.id, duplicateOf: rep.id, similarity };
      }
    }

    representatives.push({
      id: row.id,
      language: row.language,
      centered,
      size: 1,
    });
    return { id: row.id, duplicateOf: null, similarity: null };
  });
}

export function buildStandInPages<T extends StoryGroupCandidate & { publishedAt: string }>(
  items: readonly T[],
  pageSize = STAND_IN_PAGE_SIZE,
): StandInPage<T>[] {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const parsed = Date.parse(item.publishedAt);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid publishedAt timestamp for item ${item.id}: ${item.publishedAt}`);
    }
    const utcDay = new Date(parsed).toISOString().slice(0, 10);
    const list = byDay.get(utcDay);
    if (list) list.push(item);
    else byDay.set(utcDay, [item]);
  }

  const pages: StandInPage<T>[] = [];
  const days = [...byDay.keys()].sort();
  for (const utcDay of days) {
    const dayItems = requireDefined(byDay.get(utcDay), `day ${utcDay}`).sort((left, right) => {
      const timeDiff = Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
      if (timeDiff !== 0) return timeDiff;
      return left.id.localeCompare(right.id);
    });
    for (
      let offset = 0, pageIndex = 0;
      offset < dayItems.length;
      offset += pageSize, pageIndex += 1
    ) {
      pages.push({
        utcDay,
        pageIndex,
        items: dayItems.slice(offset, offset + pageSize),
      });
    }
  }
  return pages;
}

export function edgeKind(leftLanguage: string, rightLanguage: string): "fi" | "en" | "fi-en" {
  if (leftLanguage === "fi" && rightLanguage === "fi") return "fi";
  if (leftLanguage === "en" && rightLanguage === "en") return "en";
  if (
    (leftLanguage === "fi" && rightLanguage === "en") ||
    (leftLanguage === "en" && rightLanguage === "fi")
  ) {
    return "fi-en";
  }
  throw new Error(`Unsupported language pair: ${leftLanguage}/${rightLanguage}`);
}

export function selectReviewEdges(input: {
  pages: readonly StandInPage[];
  means: ReadonlyMap<string, number[]>;
  sameLanguageThreshold?: number;
  crossLingualThreshold: number | null;
  confirmedPairKeys: ReadonlySet<string>;
  reviewedPairKeys: ReadonlySet<string>;
}): StoryEdge[] {
  const sameLanguageThreshold = input.sameLanguageThreshold ?? SAME_LANGUAGE_STORY_THRESHOLD;
  const seenKeys = new Set<string>();
  const edges: StoryEdge[] = [];

  for (const page of input.pages) {
    const itemById = new Map(page.items.map((item) => [item.id, item]));
    const assignments = assignStoryGroups({
      rows: page.items,
      means: input.means,
      sameLanguageThreshold,
      crossLingualThreshold: input.crossLingualThreshold,
    });
    for (const assignment of assignments) {
      if (assignment.duplicateOf === null || assignment.similarity === null) continue;
      const key = canonicalPairKey(assignment.duplicateOf, assignment.id);
      if (
        input.confirmedPairKeys.has(key) ||
        input.reviewedPairKeys.has(key) ||
        seenKeys.has(key)
      ) {
        continue;
      }
      seenKeys.add(key);
      const rep = requireDefined(itemById.get(assignment.duplicateOf), "representative item");
      const member = requireDefined(itemById.get(assignment.id), "member item");
      const [itemAId, itemBId] = canonicalPairIds(rep.id, member.id);
      const threshold = requireDefined(
        pairThreshold(
          rep.language,
          member.language,
          sameLanguageThreshold,
          input.crossLingualThreshold,
        ),
        "edge threshold",
      );
      edges.push({
        itemAId,
        itemBId,
        representativeId: rep.id,
        memberId: member.id,
        similarity: assignment.similarity,
        threshold,
        kind: edgeKind(rep.language, member.language),
      });
    }
  }

  return edges.sort((left, right) => {
    const simDiff = left.similarity - right.similarity;
    if (simDiff !== 0) return simDiff;
    const aDiff = left.itemAId.localeCompare(right.itemAId);
    if (aDiff !== 0) return aDiff;
    return left.itemBId.localeCompare(right.itemBId);
  });
}

export function evaluateTxlDecision(input: {
  edgesByThreshold: ReadonlyArray<{ threshold: number; edges: readonly StoryEdge[] }>;
  reviewsByPairKey: ReadonlyMap<string, boolean>;
  sampleSize?: number;
  requiredSameStory?: number;
}): TxlDecision {
  const sampleSize = input.sampleSize ?? 10;
  const requiredSameStory = input.requiredSameStory ?? 9;
  const reviewedKeys = new Set<string>();
  const steps: TxlStepResult[] = [];

  for (const bucket of input.edgesByThreshold) {
    const unreviewed = bucket.edges.filter(
      (edge) => !reviewedKeys.has(canonicalPairKey(edge.itemAId, edge.itemBId)),
    );
    if (unreviewed.length < sampleSize) {
      steps.push({
        threshold: bucket.threshold,
        availableCount: unreviewed.length,
        reviewedCount: 0,
        sameStoryCount: 0,
        status: "insufficient_pairs",
      });
      return { chosenThreshold: null, steps };
    }
    const sample = unreviewed.slice(0, sampleSize);
    let sameStoryCount = 0;
    for (const edge of sample) {
      const key = canonicalPairKey(edge.itemAId, edge.itemBId);
      reviewedKeys.add(key);
      if (input.reviewsByPairKey.get(key) === true) {
        sameStoryCount += 1;
      }
    }
    const passed = sameStoryCount >= requiredSameStory;
    steps.push({
      threshold: bucket.threshold,
      availableCount: unreviewed.length,
      reviewedCount: sample.length,
      sameStoryCount,
      status: passed ? "passed" : "failed",
    });
    if (passed) {
      return { chosenThreshold: bucket.threshold, steps };
    }
  }

  return { chosenThreshold: null, steps };
}

export function evaluateSameLanguageCheck(input: {
  finnishEdges: readonly StoryEdge[];
  englishEdges: readonly StoryEdge[];
  reviewsByPairKey: ReadonlyMap<string, boolean>;
  perLanguageCount?: number;
  requiredSameStory?: number;
}): SameLanguageCheckResult {
  const perLanguageCount = input.perLanguageCount ?? 5;
  const requiredSameStory = input.requiredSameStory ?? 9;

  if (
    input.finnishEdges.length < perLanguageCount ||
    input.englishEdges.length < perLanguageCount
  ) {
    return {
      finnishAvailable: input.finnishEdges.length,
      englishAvailable: input.englishEdges.length,
      reviewedCount: 0,
      sameStoryCount: 0,
      passed: false,
      status: "insufficient_pairs",
    };
  }

  const sample = [
    ...input.finnishEdges.slice(0, perLanguageCount),
    ...input.englishEdges.slice(0, perLanguageCount),
  ];
  const sameStoryCount = sample.filter(
    (edge) => input.reviewsByPairKey.get(canonicalPairKey(edge.itemAId, edge.itemBId)) === true,
  ).length;
  const passed = sameStoryCount >= requiredSameStory;

  return {
    finnishAvailable: input.finnishEdges.length,
    englishAvailable: input.englishEdges.length,
    reviewedCount: sample.length,
    sameStoryCount,
    passed,
    status: passed ? "passed" : "failed",
  };
}

function unitVector(dim0: number, dim1: number): number[] {
  const vector = new Array<number>(512).fill(0);
  vector[0] = dim0;
  vector[1] = dim1;
  return vector;
}

function angleVector(similarity: number): number[] {
  return unitVector(similarity, Math.sqrt(Math.max(0, 1 - similarity * similarity)));
}

export interface StoryGroupGoldenCase {
  name: string;
  crossLingualThreshold: number | null;
  means: Record<"fi" | "en", number[]>;
  rows: StoryGroupCandidate[];
  expected: Array<{ id: string; duplicateOf: string | null }>;
}

const zeroMean = new Array<number>(512).fill(0);

export const STORY_GROUP_GOLDEN_CASES: readonly StoryGroupGoldenCase[] = [
  {
    name: "earliest representative, 5-row cap, exploration, and ineligibility",
    crossLingualThreshold: 0.5,
    means: { fi: zeroMean, en: zeroMean },
    rows: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        language: "fi",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: unitVector(1, 0),
        enrichmentStatus: "completed",
        summary: "Rep A",
        exploration: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        language: "fi",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: angleVector(0.75),
        enrichmentStatus: "completed",
        summary: "Rep B",
        exploration: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        language: "fi",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: angleVector(0.95),
        enrichmentStatus: "completed",
        summary: "Exploration item",
        exploration: true,
      },
      {
        id: "00000000-0000-4000-8000-000000000004",
        language: "fi",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: null,
        enrichmentStatus: "pending",
        summary: "Ineligible item",
        exploration: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000005",
        language: "fi",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: angleVector(0.8),
        enrichmentStatus: "completed",
        summary: "Member 1 of A",
        exploration: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000006",
        language: "fi",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: angleVector(0.82),
        enrichmentStatus: "completed",
        summary: "Member 2 of A",
        exploration: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000007",
        language: "en",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: angleVector(0.55),
        enrichmentStatus: "completed",
        summary: "Member 3 of A (cross-lingual)",
        exploration: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000008",
        language: "fi",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: angleVector(0.85),
        enrichmentStatus: "completed",
        summary: "Member 4 of A (reaches cap 5)",
        exploration: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000009",
        language: "fi",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: angleVector(0.9),
        enrichmentStatus: "completed",
        summary: "Overflow becomes Rep C (matches A at 0.90 and B at ~0.96, joins B)",
        exploration: false,
      },
    ],
    expected: [
      { id: "00000000-0000-4000-8000-000000000001", duplicateOf: null },
      {
        id: "00000000-0000-4000-8000-000000000002",
        duplicateOf: "00000000-0000-4000-8000-000000000001",
      },
      { id: "00000000-0000-4000-8000-000000000003", duplicateOf: null },
      { id: "00000000-0000-4000-8000-000000000004", duplicateOf: null },
      {
        id: "00000000-0000-4000-8000-000000000005",
        duplicateOf: "00000000-0000-4000-8000-000000000001",
      },
      {
        id: "00000000-0000-4000-8000-000000000006",
        duplicateOf: "00000000-0000-4000-8000-000000000001",
      },
      {
        id: "00000000-0000-4000-8000-000000000007",
        duplicateOf: "00000000-0000-4000-8000-000000000001",
      },
      { id: "00000000-0000-4000-8000-000000000008", duplicateOf: null },
      {
        id: "00000000-0000-4000-8000-000000000009",
        duplicateOf: "00000000-0000-4000-8000-000000000008",
      },
    ],
  },
  {
    name: "cross-lingual off keeps fi-en separate",
    crossLingualThreshold: null,
    means: { fi: zeroMean, en: zeroMean },
    rows: [
      {
        id: "00000000-0000-4000-8000-000000000011",
        language: "fi",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: unitVector(1, 0),
        enrichmentStatus: "completed",
        summary: "FI rep",
        exploration: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        language: "en",
        embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
        embedding: unitVector(1, 0),
        enrichmentStatus: "completed",
        summary: "EN item",
        exploration: false,
      },
    ],
    expected: [
      { id: "00000000-0000-4000-8000-000000000011", duplicateOf: null },
      { id: "00000000-0000-4000-8000-000000000012", duplicateOf: null },
    ],
  },
];
