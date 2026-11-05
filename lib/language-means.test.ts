import { describe, expect, it } from "vitest";
import {
  addLanguageEmbedding,
  createLanguageMeanAccumulator,
  finishLanguageMeans,
  MIN_LANGUAGE_MEAN_ITEMS,
  parseEmbeddingVector,
} from "./language-means.ts";
import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";

function vector(value: number): number[] {
  return new Array<number>(EMBEDDING_DIMENSIONS).fill(value);
}

describe("language means", () => {
  it("parses only finite vectors with the configured dimensions", () => {
    expect(parseEmbeddingVector(`[${vector(0.25).join(",")}]`)).toEqual(vector(0.25));
    expect(() => parseEmbeddingVector("[1,2]")).toThrow(/512-dimension/);
    expect(() => parseEmbeddingVector("not a vector")).toThrow(/invalid/);
    expect(() => parseEmbeddingVector(`[${vector(Number.NaN).join(",")}]`)).toThrow(/finite/);
  });

  it("averages languages independently and excludes groups below 50 items", () => {
    const accumulator = createLanguageMeanAccumulator();
    for (let index = 0; index < MIN_LANGUAGE_MEAN_ITEMS; index++) {
      addLanguageEmbedding(accumulator, "fi", vector(index));
    }
    addLanguageEmbedding(accumulator, "en", vector(3));

    expect(accumulator.counts).toEqual({ fi: 50, en: 1 });
    expect(finishLanguageMeans(accumulator)).toEqual([
      { language: "fi", itemCount: 50, mean: vector(24.5) },
    ]);
  });
});
