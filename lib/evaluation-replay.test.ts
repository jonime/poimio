import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  candidateScopes,
  createFeedbackSequence,
  feedbackPrefix,
  jaccard,
  nearDuplicateIds,
  pairedDifferenceStatistics,
  precisionAt10,
  type ReplayItem,
  seedStatistics,
  top10Diversity,
} from "./evaluation-replay.ts";

function item(
  id: string,
  language: "fi" | "en",
  embedding: number[],
  sourceId = `source-${id}`,
): ReplayItem {
  return { id, language, embedding, sourceId, categories: [language, id] };
}

describe("evaluation replay protocol", () => {
  const feedbackItems = [
    item("like-fi", "fi", [1, 0]),
    item("like-en", "en", [0, 1]),
    item("other-fi", "fi", [0, 1]),
    item("other-en", "en", [1, 0]),
  ];

  it("uses deterministic feedback sequences with prefix behavior across k", () => {
    const sequence = createFeedbackSequence({
      items: feedbackItems,
      relevantItemIds: ["like-fi", "like-en"],
      seed: 1,
      personaId: "p1",
    });
    const first = feedbackPrefix(sequence, 1);
    assert(first, "First feedback prefix must exist");
    const third = feedbackPrefix(
      {
        ...sequence,
        relevantIds: [...sequence.relevantIds, "extra-like"],
        nonRelevantIds: [...sequence.nonRelevantIds, "extra-negative"],
      },
      3,
    );
    expect(feedbackPrefix(sequence, 1)).toEqual(first);
    expect(third?.likes.slice(0, 1)).toEqual(first.likes);
    expect(third?.dislikes).toEqual(sequence.nonRelevantIds.slice(0, 1));
    expect(feedbackPrefix(sequence, 4)).toBeNull();
  });

  it("uses only same-language signals for cross-lingual feedback", () => {
    const sequence = createFeedbackSequence({
      items: feedbackItems,
      relevantItemIds: ["like-fi", "like-en"],
      seed: 1,
      personaId: "p1",
      language: "en",
    });
    expect(sequence.relevantIds).toEqual(["like-en"]);
    expect(sequence.nonRelevantIds).toEqual(["other-en"]);
  });

  it("removes near duplicates before ranking using centered similarity", () => {
    const feedback = item("like", "en", [11, 0]);
    const candidates = [item("duplicate", "en", [10.9, 0.1]), item("different", "en", [10, 1])];
    const ids = nearDuplicateIds({
      candidates,
      feedbackItems: [feedback],
      meanByLanguage: { fi: [0, 0], en: [10, 0] },
      threshold: 0.9,
    });
    expect(ids).toEqual(new Set(["duplicate"]));
    const scopes = candidateScopes([feedback, ...candidates], new Set(["like"]), ids);
    expect(scopes.headline.map(({ id }) => id)).toEqual(["different"]);
    expect(scopes.duplicateInclusive.map(({ id }) => id)).toEqual(["duplicate", "different"]);
  });

  it("reports missing P@10 cells and computes diversity and Jaccard", () => {
    const relevant = new Set(["a"]);
    expect(precisionAt10(["x"], ["x"], relevant)).toBeNull();
    expect(precisionAt10(["a", "b"], ["a", "b"], relevant)).toBe(0.1);
    const items = new Map([
      ["a", item("a", "fi", [1, 0], "s1")],
      ["b", item("b", "en", [0, 1], "s1")],
    ]);
    expect(top10Diversity(["a", "b"], items)).toEqual({
      distinctSources: 1,
      distinctCategories: 4,
    });
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
  });

  it("calculates seed spread and paired differences", () => {
    expect(seedStatistics([0.2, 0.4])?.mean).toBeCloseTo(0.3);
    const difference = pairedDifferenceStatistics(
      new Map([
        [1, 0.5],
        [2, 0.4],
      ]),
      new Map([
        [1, 0.3],
        [2, 0.3],
      ]),
    );
    expect(difference?.mean).toBeCloseTo(0.15);
    expect(difference?.count).toBe(2);
  });
});
