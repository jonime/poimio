import { describe, expect, it } from "vitest";
import {
  type CrosslingualVectorItem,
  sampleRandomCrosslingualPairs,
  scoreCrosslingualPairs,
} from "./evaluation-crosslingual.ts";

function item(id: string, language: "fi" | "en", embedding: number[]): CrosslingualVectorItem {
  return { id, language, embedding };
}

describe("evaluation cross-lingual check", () => {
  it("samples deterministic random pairs while excluding confirmed pairs", () => {
    const english = [item("e1", "en", [1, 0]), item("e2", "en", [0, 1])];
    const finnish = [item("f1", "fi", [1, 0]), item("f2", "fi", [0, 1])];
    const input = {
      englishItems: english,
      finnishItems: finnish,
      excludedPairs: [{ englishItemId: "e1", finnishItemId: "f1" }],
      seed: 7,
      count: 3,
    };
    const first = sampleRandomCrosslingualPairs(input);
    expect(first).toEqual(sampleRandomCrosslingualPairs(input));
    expect(first).toHaveLength(3);
    expect(first).not.toContainEqual(input.excludedPairs[0]);
  });

  it("scores raw and centered matches against random-pair percentiles", () => {
    const english = [
      item("e1", "en", [11, 0]),
      item("e2", "en", [10, 1]),
      item("e3", "en", [10, -1]),
      item("e4", "en", [9, 1]),
      item("e5", "en", [9, -1]),
      item("e6", "en", [8, 1]),
      item("e7", "en", [8, -1]),
      item("e8", "en", [7, 1]),
      item("e9", "en", [7, -1]),
      item("e10", "en", [6, 1]),
    ];
    const finnish = english.map((entry, index) => item(`f${index}`, "fi", [...entry.embedding]));
    const pairs = english.map((entry, index) => ({
      englishItemId: entry.id,
      finnishItemId: `f${index}`,
    }));
    const randomPairs = english.flatMap((entry) =>
      finnish
        .filter((other) => other.id !== `f${Number(entry.id.slice(1)) - 1}`)
        .map((other) => ({
          englishItemId: entry.id,
          finnishItemId: other.id,
        })),
    );
    const score = scoreCrosslingualPairs({
      englishItems: english,
      finnishItems: finnish,
      pairs,
      randomPairs,
      meanEnglish: [10, 0],
      meanFinnish: [10, 0],
    });

    expect(score.randomPairCount).toBeGreaterThan(0);
    expect(score.aboveRandom.centered).toBe(10);
    expect(score.passed).toBe(true);
    expect(["raw", "centered"]).toContain(score.passMethod);
  });

  it("requires ten valid matched pairs", () => {
    expect(() =>
      scoreCrosslingualPairs({
        englishItems: [],
        finnishItems: [],
        pairs: [],
        randomPairs: [],
        meanEnglish: [],
        meanFinnish: [],
      }),
    ).toThrow(/at least 10/u);
  });
});
