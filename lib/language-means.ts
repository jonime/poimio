import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";

export const MIN_LANGUAGE_MEAN_ITEMS = 50;

export type ContentLanguage = "fi" | "en";

export interface LanguageMeanAccumulator {
  counts: Record<ContentLanguage, number>;
  sums: Record<ContentLanguage, number[]>;
}

export interface LanguageMean {
  language: ContentLanguage;
  itemCount: number;
  mean: number[];
}

export function createLanguageMeanAccumulator(): LanguageMeanAccumulator {
  return {
    counts: { fi: 0, en: 0 },
    sums: {
      fi: new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
      en: new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
    },
  };
}

export function parseEmbeddingVector(value: unknown): number[] {
  if (typeof value !== "string" || !value.startsWith("[") || !value.endsWith("]")) {
    throw new Error("database returned an invalid embedding vector");
  }

  const vector = value
    .slice(1, -1)
    .split(",")
    .map((component) => Number(component));
  if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
    throw new Error(
      `database returned an embedding that is not a finite ${EMBEDDING_DIMENSIONS}-dimension vector`,
    );
  }
  return vector;
}

export function addLanguageEmbedding(
  accumulator: LanguageMeanAccumulator,
  language: ContentLanguage,
  embedding: number[],
): void {
  if (embedding.length !== EMBEDDING_DIMENSIONS || !embedding.every(Number.isFinite)) {
    throw new Error(`expected a finite ${EMBEDDING_DIMENSIONS}-dimension vector`);
  }

  accumulator.counts[language]++;
  const sum = accumulator.sums[language];
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index++) {
    sum[index] += embedding[index]!;
  }
}

export function finishLanguageMeans(
  accumulator: LanguageMeanAccumulator,
  minimumItems = MIN_LANGUAGE_MEAN_ITEMS,
): LanguageMean[] {
  return (Object.keys(accumulator.counts) as ContentLanguage[])
    .filter((language) => accumulator.counts[language] >= minimumItems)
    .map((language) => {
      const itemCount = accumulator.counts[language];
      return {
        language,
        itemCount,
        mean: accumulator.sums[language].map((sum) => sum / itemCount),
      };
    });
}
