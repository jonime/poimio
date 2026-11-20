import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  balancedCoverage,
  candidateScopes,
  compositeFeedbackPrefix,
  compositePersonas,
  createCompositeFeedbackSequence,
  createFeedbackSequence,
  feedbackPrefix,
  jaccard,
  type MemberRelevance,
  nearDuplicateIds,
  pairedDifferenceStatistics,
  precisionAt10,
  type ReplayItem,
  seedStatistics,
  top10Diversity,
  unionRelevance,
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

describe("composite personas", () => {
  const ids = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  // a* and b* are exclusive to one member, s* is relevant to both, n* to neither.
  const memberA = new Set([...ids("a", 6), ...ids("s", 2)]);
  const memberB = new Set([...ids("b", 6), ...ids("s", 2)]);
  const relevance: MemberRelevance = [memberA, memberB];
  const items = [...ids("a", 6), ...ids("b", 6), ...ids("s", 2), ...ids("n", 6)].map(
    (id, index): ReplayItem => item(id, index % 2 === 0 ? "fi" : "en", [index, 1]),
  );
  const sequence = (startMember: 0 | 1, seed = 1, language?: "fi" | "en") =>
    createCompositeFeedbackSequence({
      items,
      relevance,
      startMember,
      seed,
      compositeId: "a+b",
      ...(language === undefined ? {} : { language }),
    });

  it("creates every pair of personas", () => {
    expect(compositePersonas(["p1", "p2", "p3", "p4"]).map(({ id }) => id)).toEqual([
      "p1+p2",
      "p1+p3",
      "p1+p4",
      "p2+p3",
      "p2+p4",
      "p3+p4",
    ]);
  });

  it("treats an item as relevant when either member labels it relevant", () => {
    const union = unionRelevance(relevance);
    expect(union.size).toBe(14);
    expect(union.has("a0") && union.has("b0") && union.has("s0")).toBe(true);
    expect(union.has("n0")).toBe(false);
  });

  it("likes only member-exclusive items, alternating members without repeats", () => {
    for (const startMember of [0, 1] as const) {
      const feedback = compositeFeedbackPrefix(sequence(startMember), 5);
      assert(feedback, "feedback must exist");
      expect(new Set(feedback.likes).size).toBe(5);
      feedback.likes.forEach((id, index) => {
        const member = (startMember + index) % 2 === 0 ? "a" : "b";
        expect(id.startsWith(member), `${id} at ${index}`).toBe(true);
        expect(id.startsWith("s")).toBe(false);
      });
    }
  });

  it("keeps each member's likes as a prefix of larger feedback sizes", () => {
    const seq = sequence(0);
    const small = compositeFeedbackPrefix(seq, 3);
    const large = compositeFeedbackPrefix(seq, 10);
    assert(small && large, "feedback must exist");
    expect(large.likes.slice(0, 3)).toEqual(small.likes);
    expect(large.dislikes.slice(0, small.dislikes.length)).toEqual(small.dislikes);
    const a = large.likes.filter((id) => id.startsWith("a"));
    expect(a).toEqual(seq.exclusiveIds[0].slice(0, 5));
  });

  it("starts with the first member on even seed indexes and the second on odd ones", () => {
    const even = compositeFeedbackPrefix(sequence(0), 3);
    const odd = compositeFeedbackPrefix(sequence(1), 3);
    expect(even?.likes.map((id) => id[0])).toEqual(["a", "b", "a"]);
    expect(odd?.likes.map((id) => id[0])).toEqual(["b", "a", "b"]);
  });

  it("uses dislikes that are relevant to neither member", () => {
    const feedback = compositeFeedbackPrefix(sequence(0), 10);
    expect(feedback?.dislikes).toHaveLength(5);
    expect(feedback?.dislikes.every((id) => id.startsWith("n"))).toBe(true);
  });

  it("applies exclusive quotas within the feedback language for cross-lingual runs", () => {
    const english = sequence(0, 1, "en");
    const all = [...english.exclusiveIds[0], ...english.exclusiveIds[1], ...english.neitherIds];
    expect(
      all.every((id) => items.find((candidate) => candidate.id === id)?.language === "en"),
    ).toBe(true);
    const feedback = compositeFeedbackPrefix(english, 3);
    assert(feedback, "English feedback must exist");
    expect(feedback.likes.map((id) => id[0])).toEqual(["a", "b", "a"]);
    expect(
      [...feedback.likes, ...feedback.dislikes].every(
        (id) => items.find((candidate) => candidate.id === id)?.language === "en",
      ),
    ).toBe(true);
    // Only 3 English items are exclusive to each member, so 7 likes need a fourth.
    expect(english.exclusiveIds[0]).toHaveLength(3);
    expect(compositeFeedbackPrefix(english, 7)).toBeNull();
  });

  it("reports a missing cell when a quota or the dislike pool is too small", () => {
    const seq = sequence(0);
    expect(compositeFeedbackPrefix({ ...seq, exclusiveIds: [seq.exclusiveIds[0], []] }, 3)).toBe(
      null,
    );
    expect(
      compositeFeedbackPrefix({ ...seq, exclusiveIds: [seq.exclusiveIds[0].slice(0, 1), []] }, 1),
    ).not.toBeNull();
    expect(
      compositeFeedbackPrefix({ ...seq, exclusiveIds: [[], seq.exclusiveIds[1]] }, 1),
    ).toBeNull();
    expect(compositeFeedbackPrefix({ ...seq, neitherIds: ["n0"] }, 5)).toBeNull();
    expect(compositeFeedbackPrefix({ ...seq, neitherIds: ["n0", "n1"] }, 5)).not.toBeNull();
  });

  it("counts only member-exclusive items for balanced coverage", () => {
    const shared = ids("s", 2);
    expect(balancedCoverage(["a0", "a1", "b0", "b1", ...ids("n", 6)], relevance)).toBe(1);
    expect(balancedCoverage(["a0", "a1", "b0", ...shared, ...ids("n", 5)], relevance)).toBe(0);
    expect(balancedCoverage([...shared, "a0", "a1", "a2", "b0", ...ids("n", 4)], relevance)).toBe(
      0,
    );
    expect(balancedCoverage([...ids("n", 10), "a0", "a1", "b0", "b1"], relevance)).toBe(0);
  });
});
