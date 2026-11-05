import { cosineSimilarity } from "./early-ranking.ts";

export interface ReplayItem {
  id: string;
  language: "fi" | "en";
  sourceId: string;
  categories: string[];
  embedding: number[];
}

export interface ReplayFeedbackSequence {
  relevantIds: string[];
  nonRelevantIds: string[];
}

export interface ReplayFeedback {
  likes: string[];
  dislikes: string[];
}

export interface SeedStatistics {
  count: number;
  mean: number;
  standardDeviation: number;
  confidence95: [number, number];
}

export function candidateScopes(
  candidates: ReplayItem[],
  ratedIds: Set<string>,
  duplicateIds: Set<string>,
): { headline: ReplayItem[]; duplicateInclusive: ReplayItem[] } {
  const unrated = candidates.filter((item) => !ratedIds.has(item.id));
  return {
    headline: unrated.filter((item) => !duplicateIds.has(item.id)),
    duplicateInclusive: unrated,
  };
}

function deterministicShuffle<T>(items: T[], seed: string): T[] {
  const shuffled = [...items];
  let state = 0;
  for (const character of seed) {
    state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  if (state === 0) state = 0x9e3779b9;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const swap = (state >>> 0) % (index + 1);
    [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
  }
  return shuffled;
}

export function createFeedbackSequence(input: {
  items: ReplayItem[];
  relevantItemIds: string[];
  seed: number;
  personaId: string;
  language?: "fi" | "en";
}): ReplayFeedbackSequence {
  const { items, relevantItemIds, seed, personaId, language } = input;
  const relevantSet = new Set(relevantItemIds);
  const eligible = items.filter((item) => language === undefined || item.language === language);
  return {
    relevantIds: deterministicShuffle(
      eligible.filter((item) => relevantSet.has(item.id)).map((item) => item.id),
      `${seed}:${personaId}:${language ?? "all"}:relevant`,
    ),
    nonRelevantIds: deterministicShuffle(
      eligible.filter((item) => !relevantSet.has(item.id)).map((item) => item.id),
      `${seed}:${personaId}:${language ?? "all"}:non-relevant`,
    ),
  };
}

export function feedbackPrefix(sequence: ReplayFeedbackSequence, k: number): ReplayFeedback | null {
  const dislikeCount = Math.floor(k / 2);
  if (
    !Number.isInteger(k) ||
    k < 0 ||
    sequence.relevantIds.length < k ||
    sequence.nonRelevantIds.length < dislikeCount
  ) {
    return null;
  }
  return {
    likes: sequence.relevantIds.slice(0, k),
    dislikes: sequence.nonRelevantIds.slice(0, dislikeCount),
  };
}

function centered(item: ReplayItem, meanByLanguage: Record<"fi" | "en", number[]>): number[] {
  const mean = meanByLanguage[item.language];
  if (mean.length !== item.embedding.length) {
    throw new Error("embedding dimensions do not match language mean");
  }
  return item.embedding.map((value, index) => value - mean[index]!);
}

export function nearDuplicateIds(input: {
  candidates: ReplayItem[];
  feedbackItems: ReplayItem[];
  meanByLanguage: Record<"fi" | "en", number[]>;
  threshold: number;
}): Set<string> {
  const { candidates, feedbackItems, meanByLanguage, threshold } = input;
  return new Set(
    candidates
      .filter((candidate) =>
        feedbackItems.some(
          (signal) =>
            cosineSimilarity(
              centered(candidate, meanByLanguage),
              centered(signal, meanByLanguage),
            ) >= threshold,
        ),
      )
      .map((item) => item.id),
  );
}

export function precisionAt10(
  rankedIds: string[],
  candidateIds: string[],
  relevantIds: Set<string>,
): number | null {
  if (!candidateIds.some((id) => relevantIds.has(id))) return null;
  return rankedIds.slice(0, 10).filter((id) => relevantIds.has(id)).length / 10;
}

export function top10Diversity(
  rankedIds: string[],
  itemById: Map<string, ReplayItem>,
): { distinctSources: number; distinctCategories: number } {
  const top = rankedIds.slice(0, 10).flatMap((id) => {
    const item = itemById.get(id);
    return item ? [item] : [];
  });
  return {
    distinctSources: new Set(top.map((item) => item.sourceId)).size,
    distinctCategories: new Set(top.flatMap((item) => item.categories)).size,
  };
}

export function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 1;
  let intersectionSize = 0;
  leftSet.forEach((value) => {
    if (rightSet.has(value)) intersectionSize += 1;
  });
  return intersectionSize / union.size;
}

export function seedStatistics(values: number[]): SeedStatistics | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.length < 2
      ? 0
      : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const margin = 1.96 * (standardDeviation / Math.sqrt(values.length));
  return {
    count: values.length,
    mean,
    standardDeviation,
    confidence95: [mean - margin, mean + margin],
  };
}

export function pairedDifferenceStatistics(
  valuesBySeed: Map<number, number>,
  baselineBySeed: Map<number, number>,
): SeedStatistics | null {
  const differences = [...valuesBySeed]
    .filter(([seed]) => baselineBySeed.has(seed))
    .map(([seed, value]) => value - baselineBySeed.get(seed)!);
  return seedStatistics(differences);
}
