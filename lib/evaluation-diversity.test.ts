import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type DiversityRule,
  diversityGrid,
  type EvaluatedDiversityConfiguration,
  explorationReport,
  parseDiversityRule,
  selectDiversityWinner,
} from "./evaluation-diversity.ts";
import type { ConfigurationMetrics } from "./evaluation-tuning.ts";

const rule = parseDiversityRule(
  readFileSync(new URL("../evaluation/diversity-rule.json", import.meta.url), "utf8"),
);

function metrics(
  objective: number,
  balancedCoverage: number,
  enFi: number | null = 0.4,
  fiEn: number | null = 0.45,
): ConfigurationMetrics & { distinctSources: number } {
  const directional = (value: number | null) => ({
    value,
    omittedPersonaIds: [],
    availability: [],
  });
  return {
    objective,
    balancedCoverage,
    enFi: directional(enFi),
    fiEn: directional(fiEn),
    distinctSources: 4,
    objectiveAvailability: [],
    coverageAvailability: [],
  };
}

function evaluated(ruleValue: DiversityRule, rows: Record<number, ReturnType<typeof metrics>>) {
  return diversityGrid(ruleValue).flatMap((configuration) => {
    const value = rows[configuration.diversity];
    return value
      ? [{ configuration, metrics: value } satisfies EvaluatedDiversityConfiguration]
      : [];
  });
}

const reference = () => metrics(0.65, 0.5);

describe("diversity rule", () => {
  it("parses the committed grid and includes diversity and exploration in IDs and parameters", () => {
    expect(rule.diversityGrid).toEqual([0, 0.1, 0.2, 0.3, 0.5]);
    const point = diversityGrid(rule)[3];
    expect(point?.id).toContain("diversity0.3");
    expect(point?.id).toContain("explorationfalse");
    expect(point?.parameters).toMatchObject({ diversity: 0.3, exploration: false });
  });

  it("applies every eligibility boundary inclusively", () => {
    const points = evaluated(rule, {
      0: reference(),
      0.1: metrics(0.63, 0.52, 0.35, 0.4),
      0.2: metrics(0.629999, 0.52, 0.35, 0.4),
    });
    const selection = selectDiversityWinner(points, rule);
    const first = selection.rows.find(({ id }) => id === points[1]?.configuration.id);
    const second = selection.rows.find(({ id }) => id === points[2]?.configuration.id);

    expect(first?.constraints).toEqual({
      objectiveOk: true,
      coverageOk: true,
      enFiOk: true,
      fiEnOk: true,
      eligible: true,
    });
    expect(second?.constraints.objectiveOk).toBe(false);
  });

  it("does not constrain a direction with no reference cells", () => {
    const points = evaluated(rule, {
      0: metrics(0.65, 0.5, null, 0.45),
      0.1: metrics(0.64, 0.53, 0, 0.4),
    });
    const candidate = selectDiversityWinner(points, rule).rows[1];
    expect(candidate?.constraints.enFiOk).toBe(true);
  });

  it("selects the eligible smaller objective example as specified by coverage", () => {
    const points = evaluated(rule, {
      0: reference(),
      0.1: metrics(0.665, 0.51),
      0.2: metrics(0.675, 0.53),
    });
    expect(selectDiversityWinner(points, rule).winnerId).toBe(points[2]?.configuration.id);
  });

  it("anchors the near-tie band to the maximum instead of chaining comparisons", () => {
    const points = evaluated(rule, {
      0: reference(),
      0.1: metrics(0.67, 0.55),
      0.2: metrics(0.67, 0.54),
      0.3: metrics(0.67, 0.56),
    });
    const selection = selectDiversityWinner(points, rule);
    expect(selection.bandIds).toEqual([points[1]?.configuration.id, points[3]?.configuration.id]);
    expect(selection.winnerId).toBe(points[1]?.configuration.id);
  });

  it("keeps mu zero when nothing positive is eligible", () => {
    const points = evaluated(rule, {
      0: reference(),
      0.1: metrics(0.62, 0.53),
      0.2: metrics(0.67, 0.51),
    });
    expect(selectDiversityWinner(points, rule).winnerId).toBe(points[0]?.configuration.id);
  });
});

function explorationCell(overrides: Partial<Parameters<typeof explorationReport>[0][number]> = {}) {
  return {
    runType: "standard" as const,
    scope: "headline" as const,
    personaId: "persona",
    seed: 0,
    k: 3,
    status: "complete" as const,
    precisionAt10: 0.5,
    distinctSources: 4,
    position5Exploration: false,
    position5Relevant: null,
    ...overrides,
  };
}

describe("exploration report", () => {
  it("computes signed objective and diversity differences, fill rate, and pooled hit rate", () => {
    const off = [explorationCell(), explorationCell({ seed: 1 })];
    const on = [
      explorationCell({
        precisionAt10: 0.6,
        distinctSources: 5,
        position5Exploration: true,
        position5Relevant: true,
      }),
      explorationCell({
        seed: 1,
        precisionAt10: 0.4,
        distinctSources: 5,
        position5Exploration: false,
      }),
    ];
    expect(explorationReport(off, on)).toEqual({
      runCount: 2,
      objectiveDifference: 0,
      distinctSourcesDifference: 1,
      slotFillRate: 0.5,
      flaggedItemCount: 1,
      relevantFlaggedItemCount: 1,
      hitRate: 1,
    });
  });

  it("returns a null hit rate when no slot is flagged", () => {
    expect(
      explorationReport([explorationCell()], [explorationCell({ precisionAt10: 0.4 })]),
    ).toMatchObject({
      slotFillRate: 0,
      hitRate: null,
    });
  });
});
