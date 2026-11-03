import { describe, expect, it } from "vitest";
import {
  chunkItems,
  evaluationLabelBatchSize,
  labelCacheKey,
  parseLabelJsonLines,
  parseLabelResponse,
  validateLabelSet,
  type EvaluationLabel,
  type EvaluationLabelItem,
  type EvaluationPersona,
} from "./evaluation-labels.ts";

const personas: EvaluationPersona[] = [
  { id: "ai", description: "AI and software" },
  { id: "sports", description: "Finnish sports" },
];
const items: EvaluationLabelItem[] = [
  { id: "a", title: "AI", summary: "Summary", language: "en" },
  { id: "b", title: "Hockey", summary: "Yhteenveto", language: "fi" },
];

function label(
  personaId: string,
  itemId: string,
  relevant = false,
): EvaluationLabel {
  return {
    personaId,
    itemId,
    model: "local-qwen-build",
    promptVersion: "relevance-v1",
    relevant,
  };
}

describe("evaluation labels", () => {
  it("batches without dropping or reordering items", () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkItems([], 20)).toEqual([]);
    expect(() => chunkItems([1], 0)).toThrow(/positive integer/u);
  });

  it("bounds the configurable request size at twenty", () => {
    expect(evaluationLabelBatchSize(undefined)).toBe(20);
    expect(evaluationLabelBatchSize("5")).toBe(5);
    expect(() => evaluationLabelBatchSize("21")).toThrow(/from 1 to 20/u);
  });

  it("validates exact JSON response coverage and boolean values", () => {
    expect(
      parseLabelResponse(
        '{"labels":[{"item_id":"a","relevant":true},{"item_id":"b","relevant":false}]}',
        ["a", "b"],
      ),
    ).toEqual(
      new Map([
        ["a", true],
        ["b", false],
      ]),
    );
    expect(() => parseLabelResponse("not json", ["a"])).toThrow(/valid JSON/u);
    expect(() =>
      parseLabelResponse('{"labels":[{"item_id":"a","relevant":"yes"}]}', [
        "a",
      ]),
    ).toThrow(/boolean/u);
    expect(() =>
      parseLabelResponse('{"labels":[{"item_id":"a","relevant":true}]}', [
        "a",
        "b",
      ]),
    ).toThrow(/every requested item/u);
  });

  it("keys cache records by persona, item, model, and prompt version", () => {
    expect(labelCacheKey("ai", "a", "qwen-a", "v1")).not.toBe(
      labelCacheKey("ai", "a", "qwen-b", "v1"),
    );
    expect(
      parseLabelJsonLines(`${JSON.stringify(label("ai", "a"))}\n`),
    ).toHaveLength(1);
    expect(() => parseLabelJsonLines('{"itemId":false}\n')).toThrow(
      /invalid schema/u,
    );
  });

  it("requires a complete single-model, single-prompt label set", () => {
    const complete = [
      label("ai", "a", true),
      label("ai", "b"),
      label("sports", "a"),
      label("sports", "b", true),
    ];
    const labelSet = validateLabelSet({ personas, items, labels: complete });
    expect(labelSet.labels).toHaveLength(4);
    expect(labelSet.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      validateLabelSet({ personas, items, labels: complete.slice(1) }),
    ).toThrow(/incomplete/u);
    expect(() =>
      validateLabelSet({
        personas,
        items,
        labels: [...complete, { ...complete[0]!, model: "other-model" }],
      }),
    ).toThrow(/duplicate pair|more than one model/u);
    expect(() =>
      validateLabelSet({
        personas,
        items,
        labels: complete.map((entry, index) =>
          index === 0 ? { ...entry, promptVersion: "v2" } : entry,
        ),
      }),
    ).toThrow(/more than one model, prompt version, or provisional state/u);
    expect(() =>
      validateLabelSet({
        personas,
        items,
        labels: complete.map((entry, index) =>
          index === 0 ? { ...entry, provisional: true } : entry,
        ),
      }),
    ).toThrow(/provisional state/u);
  });
});
