import { cosineSimilarity } from "./early-ranking.ts";

export interface CrosslingualVectorItem {
  id: string;
  language: "fi" | "en";
  embedding: number[];
}

export interface CrosslingualPair {
  englishItemId: string;
  finnishItemId: string;
}

export interface CrosslingualMatchScore extends CrosslingualPair {
  rawSimilarity: number;
  centeredSimilarity: number;
}

export interface CrosslingualScores {
  matchedPairs: CrosslingualMatchScore[];
  randomPairCount: number;
  random95thPercentile: { raw: number; centered: number };
  aboveRandom: { raw: number; centered: number };
  gateSample: { count: number; rawAbove: number; centeredAbove: number };
  passed: boolean;
  passMethod: "raw" | "centered" | null;
}

function subtract(left: number[], right: number[]): number[] {
  if (left.length !== right.length) {
    throw new Error("embedding dimensions do not match language means");
  }
  return left.map((value, index) => value - right[index]!);
}

function percentile95(values: number[]): number {
  if (values.length === 0) throw new Error("random pair sample is empty");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

export function scoreCrosslingualPairs(input: {
  englishItems: CrosslingualVectorItem[];
  finnishItems: CrosslingualVectorItem[];
  pairs: CrosslingualPair[];
  randomPairs: CrosslingualPair[];
  meanEnglish: number[];
  meanFinnish: number[];
}): CrosslingualScores {
  const {
    englishItems,
    finnishItems,
    pairs,
    randomPairs,
    meanEnglish,
    meanFinnish,
  } = input;
  if (pairs.length < 10)
    throw new Error("at least 10 confirmed pairs are required");
  const englishById = new Map(englishItems.map((item) => [item.id, item]));
  const finnishById = new Map(finnishItems.map((item) => [item.id, item]));
  const matchedPairs = pairs.map((pair): CrosslingualMatchScore => {
    const english = englishById.get(pair.englishItemId);
    const finnish = finnishById.get(pair.finnishItemId);
    if (!english || !finnish) {
      throw new Error(
        "confirmed pair references an item outside its language pool",
      );
    }
    return {
      ...pair,
      rawSimilarity: cosineSimilarity(english.embedding, finnish.embedding),
      centeredSimilarity: cosineSimilarity(
        subtract(english.embedding, meanEnglish),
        subtract(finnish.embedding, meanFinnish),
      ),
    };
  });
  const randomScores = randomPairs.map((pair) => {
    const english = englishById.get(pair.englishItemId);
    const finnish = finnishById.get(pair.finnishItemId);
    if (!english || !finnish) {
      throw new Error(
        "random pair references an item outside its language pool",
      );
    }
    return {
      raw: cosineSimilarity(english.embedding, finnish.embedding),
      centered: cosineSimilarity(
        subtract(english.embedding, meanEnglish),
        subtract(finnish.embedding, meanFinnish),
      ),
    };
  });
  const rawThreshold = percentile95(randomScores.map((score) => score.raw));
  const centeredThreshold = percentile95(
    randomScores.map((score) => score.centered),
  );
  const aboveRaw = matchedPairs.filter(
    (pair) => pair.rawSimilarity > rawThreshold,
  ).length;
  const aboveCentered = matchedPairs.filter(
    (pair) => pair.centeredSimilarity > centeredThreshold,
  ).length;
  const gatePairs = matchedPairs.slice(0, 10);
  const gateAboveRaw = gatePairs.filter(
    (pair) => pair.rawSimilarity > rawThreshold,
  ).length;
  const gateAboveCentered = gatePairs.filter(
    (pair) => pair.centeredSimilarity > centeredThreshold,
  ).length;
  const passMethod =
    gateAboveRaw >= 9 ? "raw" : gateAboveCentered >= 9 ? "centered" : null;
  return {
    matchedPairs,
    randomPairCount: randomScores.length,
    random95thPercentile: { raw: rawThreshold, centered: centeredThreshold },
    aboveRandom: { raw: aboveRaw, centered: aboveCentered },
    gateSample: {
      count: gatePairs.length,
      rawAbove: gateAboveRaw,
      centeredAbove: gateAboveCentered,
    },
    passed: passMethod !== null,
    passMethod,
  };
}

export function sampleRandomCrosslingualPairs(input: {
  englishItems: CrosslingualVectorItem[];
  finnishItems: CrosslingualVectorItem[];
  excludedPairs: CrosslingualPair[];
  count?: number;
  seed: number;
}): CrosslingualPair[] {
  const {
    englishItems,
    finnishItems,
    excludedPairs,
    count = 10_000,
    seed,
  } = input;
  const excluded = new Set(
    excludedPairs.map(
      (pair) => `${pair.englishItemId}\u0000${pair.finnishItemId}`,
    ),
  );
  const availableCount =
    englishItems.length * finnishItems.length - excluded.size;
  const requested = Math.min(count, availableCount);
  if (requested < 1)
    throw new Error("no random cross-lingual pairs are available");
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const selected = new Map<string, CrosslingualPair>();
  while (selected.size < requested) {
    const english = englishItems[Math.floor(next() * englishItems.length)]!;
    const finnish = finnishItems[Math.floor(next() * finnishItems.length)]!;
    const key = `${english.id}\u0000${finnish.id}`;
    if (!excluded.has(key))
      selected.set(key, {
        englishItemId: english.id,
        finnishItemId: finnish.id,
      });
  }
  return [...selected.values()];
}
