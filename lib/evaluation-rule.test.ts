import { describe, expect, it } from "vitest";
import { assertEvaluationRuleHash, normalizeEvaluationRulePath } from "./evaluation-rule.ts";

describe("evaluation rule selection", () => {
  it("defaults to the spec-020 rule and accepts an explicit diversity rule", () => {
    expect(normalizeEvaluationRulePath(undefined)).toBe("evaluation/tuning-rule.json");
    expect(normalizeEvaluationRulePath("evaluation/diversity-rule.json")).toBe(
      "evaluation/diversity-rule.json",
    );
  });

  it("rejects paths outside the repository and non-JSON files", () => {
    expect(() => normalizeEvaluationRulePath("../rule.json")).toThrow(/inside the repository/u);
    expect(() => normalizeEvaluationRulePath("/tmp/rule.json")).toThrow(/inside the repository/u);
    expect(() => normalizeEvaluationRulePath("evaluation/rule.txt")).toThrow(/JSON file/u);
  });

  it("rejects a result produced with a different rule hash", () => {
    expect(() =>
      assertEvaluationRuleHash("wrong", "expected", "evaluation/diversity-rule.json"),
    ).toThrow(/evaluation\/diversity-rule\.json/u);
    expect(() =>
      assertEvaluationRuleHash("expected", "expected", "evaluation/diversity-rule.json"),
    ).not.toThrow();
  });
});
