import { describe, expect, it } from "vitest";
import {
  ACTIVE_STORY_EMBEDDING_MODEL,
  assignStoryGroups,
  buildStandInPages,
  canonicalPairKey,
  evaluateSameLanguageCheck,
  evaluateTxlDecision,
  meanKey,
  STORY_GROUP_GOLDEN_CASES,
  type StoryGroupCandidate,
  selectReviewEdges,
} from "./story-groups.ts";

function makeVector(x: number, y = 0): number[] {
  const vector = new Array<number>(512).fill(0);
  vector[0] = x;
  vector[1] = y;
  return vector;
}

function angleVector(similarity: number): number[] {
  return makeVector(similarity, Math.sqrt(Math.max(0, 1 - similarity * similarity)));
}

function defaultMeans(): Map<string, number[]> {
  return new Map([
    [meanKey(ACTIVE_STORY_EMBEDDING_MODEL, "fi"), makeVector(0, 0)],
    [meanKey(ACTIVE_STORY_EMBEDDING_MODEL, "en"), makeVector(0, 0)],
  ]);
}

function makeItem<T extends Partial<StoryGroupCandidate>>(
  id: string,
  overrides: T = {} as T,
): StoryGroupCandidate & T {
  return {
    id,
    language: "fi",
    embeddingModel: ACTIVE_STORY_EMBEDDING_MODEL,
    embedding: makeVector(1, 0),
    enrichmentStatus: "completed",
    summary: `Summary for ${id}`,
    exploration: false,
    ...overrides,
  };
}

describe("assignStoryGroups", () => {
  it("matches all exported golden cases", () => {
    for (const golden of STORY_GROUP_GOLDEN_CASES) {
      const means = new Map([
        [meanKey(ACTIVE_STORY_EMBEDDING_MODEL, "fi"), golden.means.fi],
        [meanKey(ACTIVE_STORY_EMBEDDING_MODEL, "en"), golden.means.en],
      ]);
      const result = assignStoryGroups({
        rows: golden.rows,
        means,
        crossLingualThreshold: golden.crossLingualThreshold,
      }).map(({ id, duplicateOf }) => ({ id, duplicateOf }));
      expect(result, golden.name).toEqual(golden.expected);
    }
  });

  it("joins the earliest matching representative in rank order", () => {
    const means = defaultMeans();
    const rows = [
      makeItem("rep-1", { embedding: makeVector(1, 0) }),
      makeItem("rep-2", { embedding: angleVector(0.73) }),
      makeItem("member", { embedding: angleVector(0.75) }),
    ];
    const result = assignStoryGroups({
      rows,
      means,
      crossLingualThreshold: 0.5,
    });
    expect(result.map((row) => ({ id: row.id, duplicateOf: row.duplicateOf }))).toEqual([
      { id: "rep-1", duplicateOf: null },
      { id: "rep-2", duplicateOf: null },
      { id: "member", duplicateOf: "rep-1" },
    ]);
  });

  it("enforces the 5-row cap including the representative", () => {
    const means = defaultMeans();
    const rows = Array.from({ length: 7 }, (_, index) =>
      makeItem(`item-${index}`, { embedding: makeVector(1, 0) }),
    );
    const result = assignStoryGroups({
      rows,
      means,
      crossLingualThreshold: 0.5,
    });
    expect(result.map((row) => row.duplicateOf)).toEqual([
      null,
      "item-0",
      "item-0",
      "item-0",
      "item-0",
      null,
      "item-5",
    ]);
  });

  it("respects same-language and cross-language thresholds and T_xl off", () => {
    const means = defaultMeans();
    const rows = [
      makeItem("fi-rep", { language: "fi", embedding: makeVector(1, 0) }),
      makeItem("fi-below", { language: "fi", embedding: angleVector(0.73) }),
      makeItem("fi-at", { language: "fi", embedding: angleVector(0.74) }),
      makeItem("en-mid", {
        language: "en",
        embedding: makeVector(0.52, -Math.sqrt(1 - 0.52 * 0.52)),
      }),
    ];

    const withTxl50 = assignStoryGroups({
      rows,
      means,
      crossLingualThreshold: 0.5,
    });
    expect(withTxl50.map((row) => row.duplicateOf)).toEqual([null, null, "fi-rep", "fi-rep"]);

    const withTxl55 = assignStoryGroups({
      rows,
      means,
      crossLingualThreshold: 0.55,
    });
    expect(withTxl55.map((row) => row.duplicateOf)).toEqual([null, null, "fi-rep", null]);

    const withTxlOff = assignStoryGroups({
      rows,
      means,
      crossLingualThreshold: null,
    });
    expect(withTxlOff.map((row) => row.duplicateOf)).toEqual([null, null, "fi-rep", null]);
  });

  it("never groups exploration or ineligible items", () => {
    const means = new Map([[meanKey(ACTIVE_STORY_EMBEDDING_MODEL, "fi"), makeVector(0, 0)]]);
    const rows = [
      makeItem("explore-first", { exploration: true, embedding: makeVector(1, 0) }),
      makeItem("wrong-model", { embeddingModel: "other-model" }),
      makeItem("no-embedding", { embedding: null }),
      makeItem("pending-enrich", { enrichmentStatus: "pending" }),
      makeItem("blank-summary", { summary: "   " }),
      makeItem("missing-mean", { language: "en" }),
      makeItem("zero-centered", { embedding: makeVector(0, 0) }),
      makeItem("eligible-rep", { embedding: makeVector(1, 0) }),
      makeItem("explore-second", { exploration: true, embedding: makeVector(1, 0) }),
      makeItem("eligible-member", { embedding: makeVector(1, 0) }),
    ];

    const result = assignStoryGroups({
      rows,
      means,
      crossLingualThreshold: 0.5,
    });
    expect(result.map((row) => [row.id, row.duplicateOf])).toEqual([
      ["explore-first", null],
      ["wrong-model", null],
      ["no-embedding", null],
      ["pending-enrich", null],
      ["blank-summary", null],
      ["missing-mean", null],
      ["zero-centered", null],
      ["eligible-rep", null],
      ["explore-second", null],
      ["eligible-member", "eligible-rep"],
    ]);
  });
});

describe("buildStandInPages and selectReviewEdges", () => {
  it("splits validation items by UTC day and 30-row pages ordered publishedAt desc, id asc", () => {
    const day1Items = Array.from({ length: 31 }, (_, index) =>
      makeItem(`d1-${String(index).padStart(2, "0")}`, {
        publishedAt: `2026-11-05T10:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const day2Items = [
      makeItem("d2-b", { publishedAt: "2026-11-06T01:00:00.000Z" }),
      makeItem("d2-a", { publishedAt: "2026-11-06T01:00:00.000Z" }),
    ];
    const pages = buildStandInPages([...day1Items, ...day2Items]);

    expect(pages.map((page) => [page.utcDay, page.pageIndex, page.items.length])).toEqual([
      ["2026-11-05", 0, 30],
      ["2026-11-05", 1, 1],
      ["2026-11-06", 0, 2],
    ]);
    expect(pages[0]?.items[0]?.id).toBe("d1-30");
    expect(pages[1]?.items[0]?.id).toBe("d1-00");
    expect(pages[2]?.items.map((item) => item.id)).toEqual(["d2-a", "d2-b"]);
  });

  it("excludes confirmed and reviewed pairs and sorts deterministically by similarity then IDs", () => {
    const means = defaultMeans();
    const page1Items = [
      makeItem("item-c", {
        language: "fi",
        publishedAt: "2026-11-05T12:00:00.000Z",
        embedding: makeVector(1, 0),
      }),
      makeItem("item-a", {
        language: "en",
        publishedAt: "2026-11-05T11:00:00.000Z",
        embedding: angleVector(0.55),
      }),
      makeItem("item-b", {
        language: "en",
        publishedAt: "2026-11-05T10:00:00.000Z",
        embedding: angleVector(0.52),
      }),
      makeItem("item-confirmed", {
        language: "en",
        publishedAt: "2026-11-05T09:00:00.000Z",
        embedding: angleVector(0.51),
      }),
      makeItem("item-reviewed", {
        language: "en",
        publishedAt: "2026-11-05T08:00:00.000Z",
        embedding: angleVector(0.51),
      }),
    ];
    const pages = buildStandInPages(page1Items);
    const edges = selectReviewEdges({
      pages,
      means,
      crossLingualThreshold: 0.5,
      confirmedPairKeys: new Set([canonicalPairKey("item-c", "item-confirmed")]),
      reviewedPairKeys: new Set([canonicalPairKey("item-c", "item-reviewed")]),
    });

    expect(edges.map((edge) => [edge.itemAId, edge.itemBId, edge.kind])).toEqual([
      ["item-b", "item-c", "fi-en"],
      ["item-a", "item-c", "fi-en"],
    ]);
  });
});

describe("T_xl and same-language review rules", () => {
  function makeEdge(index: number, similarity: number, kind: "fi" | "en" | "fi-en" = "fi-en") {
    const rep = `rep-${String(index).padStart(2, "0")}`;
    const mem = `mem-${String(index).padStart(2, "0")}`;
    return {
      itemAId: mem,
      itemBId: rep,
      representativeId: rep,
      memberId: mem,
      similarity,
      threshold: kind === "fi-en" ? 0.5 : 0.74,
      kind,
    };
  }

  it("keeps 0.50 when 9 of 10 pass, or raises to 0.55 and evaluates unreviewed pairs", () => {
    const edges50 = Array.from({ length: 12 }, (_, index) => makeEdge(index, 0.5 + index * 0.01));
    const edges55 = edges50.filter((edge) => edge.similarity >= 0.55);
    const allPass = new Map(
      edges50.map((edge) => [canonicalPairKey(edge.itemAId, edge.itemBId), true]),
    );

    const passAt50 = evaluateTxlDecision({
      edgesByThreshold: [
        { threshold: 0.5, edges: edges50 },
        { threshold: 0.55, edges: edges55 },
      ],
      reviewsByPairKey: allPass,
    });
    expect(passAt50.chosenThreshold).toBe(0.5);
    expect(passAt50.steps).toHaveLength(1);

    // Fail at 0.50 and insufficient unreviewed pairs at 0.55 (< 10 remaining)
    const fail50 = new Map(
      edges50.map((edge, index) => [canonicalPairKey(edge.itemAId, edge.itemBId), index >= 2]),
    );
    const insufficientAt55 = evaluateTxlDecision({
      edgesByThreshold: [
        { threshold: 0.5, edges: edges50 },
        { threshold: 0.55, edges: edges55 },
      ],
      reviewsByPairKey: fail50,
    });
    expect(insufficientAt55.chosenThreshold).toBeNull();
    expect(insufficientAt55.steps.map((step) => step.status)).toEqual([
      "failed",
      "insufficient_pairs",
    ]);

    // Pass at 0.55 when at least 10 unreviewed edges >= 0.55 exist
    const manyEdges50 = Array.from({ length: 22 }, (_, index) =>
      makeEdge(index, 0.5 + index * 0.005),
    );
    const manyEdges55 = manyEdges50.filter((edge) => edge.similarity >= 0.55);
    const reviews = new Map(
      manyEdges50.map((edge, index) => [canonicalPairKey(edge.itemAId, edge.itemBId), index >= 10]),
    );
    const passAt55 = evaluateTxlDecision({
      edgesByThreshold: [
        { threshold: 0.5, edges: manyEdges50 },
        { threshold: 0.55, edges: manyEdges55 },
      ],
      reviewsByPairKey: reviews,
    });
    expect(passAt55.chosenThreshold).toBe(0.55);
    expect(passAt55.steps.map((step) => step.status)).toEqual(["failed", "passed"]);
  });

  it("evaluates the same-language check (5 fi + 5 en, >= 9 same story)", () => {
    const fiEdges = Array.from({ length: 6 }, (_, index) => makeEdge(index, 0.75, "fi"));
    const enEdges = Array.from({ length: 6 }, (_, index) => makeEdge(index + 10, 0.75, "en"));
    const reviews = new Map(
      [...fiEdges.slice(0, 5), ...enEdges.slice(0, 5)].map((edge, index) => [
        canonicalPairKey(edge.itemAId, edge.itemBId),
        index !== 0,
      ]),
    );
    const passed = evaluateSameLanguageCheck({
      finnishEdges: fiEdges,
      englishEdges: enEdges,
      reviewsByPairKey: reviews,
    });
    expect(passed).toEqual({
      finnishAvailable: 6,
      englishAvailable: 6,
      reviewedCount: 10,
      sameStoryCount: 9,
      passed: true,
      status: "passed",
    });

    const insufficient = evaluateSameLanguageCheck({
      finnishEdges: fiEdges.slice(0, 4),
      englishEdges: enEdges,
      reviewsByPairKey: reviews,
    });
    expect(insufficient.status).toBe("insufficient_pairs");
  });
});
