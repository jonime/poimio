import { describe, expect, it } from "vitest";
import {
  CENTERED_RANKING_METHODS,
  centerEmbeddingsByLanguage,
  encodeCsv,
  parseCsv,
  rankEarlyItems,
  scoreCenteredEarlyRanking,
  scoreEarlyRanking,
  type CenteredRankingAnswerKey,
  type EarlyRankingItem,
  type RankingAnswerKey,
} from "./early-ranking";

function item(id: string, embedding: number[], publishedAt: string): EarlyRankingItem {
  return {
    id,
    title: id,
    summary: null,
    language: "en",
    url: `https://example.test/${id}`,
    publishedAt,
    embedding,
  };
}

describe("early ranking", () => {
  const items = [
    item("liked-a", [1, 0], "2026-01-01T00:00:00Z"),
    item("liked-b", [0, 1], "2026-01-02T00:00:00Z"),
    item("near-a", [0.99, 0.01], "2026-01-03T00:00:00Z"),
    item("middle", [0.7, 0.7], "2026-01-04T00:00:00Z"),
    item("near-b", [0.01, 0.99], "2026-01-05T00:00:00Z"),
  ];

  it("ranks by nearest liked and excludes feedback items", () => {
    expect(
      rankEarlyItems(items, ["liked-a", "liked-b"], "nearest-liked").map(({ id }) => id),
    ).toEqual(["near-a", "near-b", "middle"]);
  });

  it("ranks against the mean liked vector", () => {
    expect(
      rankEarlyItems(items, ["liked-a", "liked-b"], "average-vector").map(({ id }) => id),
    ).toEqual(["middle", "near-a", "near-b"]);
  });

  it("centers and normalizes embeddings within each language", () => {
    const mixedItems = [
      {
        ...item("fi-a", [2, 0], "2026-01-01T00:00:00Z"),
        language: "fi" as const,
      },
      {
        ...item("fi-b", [0, 2], "2026-01-02T00:00:00Z"),
        language: "fi" as const,
      },
      {
        ...item("en-a", [3, 0], "2026-01-03T00:00:00Z"),
        language: "en" as const,
      },
      {
        ...item("en-b", [3, 2], "2026-01-04T00:00:00Z"),
        language: "en" as const,
      },
    ];

    const centered = centerEmbeddingsByLanguage(mixedItems);

    expect(centered.means).toEqual({ fi: [1, 1], en: [3, 1] });
    expect(centered.items[0]?.embedding[0]).toBeCloseTo(Math.SQRT1_2);
    expect(centered.items[0]?.embedding[1]).toBeCloseTo(-Math.SQRT1_2);
    expect(centered.items[1]?.embedding[0]).toBeCloseTo(-Math.SQRT1_2);
    expect(centered.items[1]?.embedding[1]).toBeCloseTo(Math.SQRT1_2);
    expect(centered.items.slice(2).map(({ embedding }) => embedding)).toEqual([
      [0, -1],
      [0, 1],
    ]);
  });

  it("scores centered variants using previous and newly collected judgments", () => {
    const urls = Array.from({ length: 10 }, (_, index) => `https://example.test/${index}`);
    const personas = Object.fromEntries(
      CENTERED_RANKING_METHODS.map((method) => [
        method,
        urls.map((url, index) => ({ url, rank: index + 1 })),
      ]),
    ) as CenteredRankingAnswerKey["personas"][string];
    const answerKey: CenteredRankingAnswerKey = {
      languageMeans: { fi: [1, 2], en: [3, 4] },
      personas: { p1: personas },
    };
    const oldJudgments = urls.slice(0, 5).map((url, index) => ({
      persona: "p1",
      url,
      relevant: index < 2 ? "1" : "0",
    }));
    const newJudgments = urls.slice(5).map((url, index) => ({
      persona: "p1",
      url,
      relevant: index < 4 ? "1" : "0",
    }));

    const result = scoreCenteredEarlyRanking([...oldJudgments, ...newJudgments], answerKey);

    expect(result.perPersona).toHaveLength(CENTERED_RANKING_METHODS.length);
    expect(result.macroAverage).toEqual({
      "nearest-liked-raw": 0.6,
      "average-vector-raw": 0.6,
      "nearest-liked-centered": 0.6,
      "average-vector-centered": 0.6,
      "newest-first": 0.6,
    });
    expect(result.gate1).toEqual({
      passed: false,
      decision:
        "Use average-vector-raw as the gate 1 baseline; nearest-liked does not meet both criteria.",
    });
    expect(result.languageMeans).toEqual(answerKey.languageMeans);
  });

  it("uses newest-first with deterministic ties", () => {
    expect(rankEarlyItems(items, ["liked-a"], "newest-first").map(({ id }) => id)).toEqual([
      "near-b",
      "middle",
      "near-a",
      "liked-b",
    ]);
  });

  it("round-trips CSV quotes, commas, and newlines", () => {
    const rows = [
      ["title", "summary"],
      ['A, "quoted" title', "line one\nline two"],
    ];
    expect(parseCsv(encodeCsv(rows))).toEqual(rows);
  });

  it("computes per-persona and macro precision@10 plus gate 1", () => {
    const key: RankingAnswerKey = {
      personas: {
        p1: {
          "nearest-liked": Array.from({ length: 10 }, (_, index) => ({
            blindId: `n${index}`,
            rank: index + 1,
          })),
          "average-vector": Array.from({ length: 10 }, (_, index) => ({
            blindId: `a${index}`,
            rank: index + 1,
          })),
          "newest-first": Array.from({ length: 10 }, (_, index) => ({
            blindId: `f${index}`,
            rank: index + 1,
          })),
        },
      },
    };
    const judgingRows = [
      ...Array.from({ length: 6 }, (_, index) => ({
        persona: "p1",
        blind_id: `n${index}`,
        relevant: "1",
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        persona: "p1",
        blind_id: `a${index}`,
        relevant: "1",
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        persona: "p1",
        blind_id: `f${index}`,
        relevant: "1",
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        persona: "p1",
        blind_id: `n${index + 6}`,
        relevant: "0",
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        persona: "p1",
        blind_id: `a${index + 5}`,
        relevant: "0",
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        persona: "p1",
        blind_id: `f${index + 4}`,
        relevant: "0",
      })),
    ];

    const result = scoreEarlyRanking(judgingRows, key);
    expect(result.macroAverage).toEqual({
      "nearest-liked": 0.6,
      "average-vector": 0.5,
      "newest-first": 0.4,
    });
    expect(result.gate1.passed).toBe(true);
  });
});
