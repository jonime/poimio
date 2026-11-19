import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    assertConsistentMissingCells,
    baselineConfigurationId,
    type ConfigurationMetrics,
    configurationId,
    type EvaluatedConfiguration,
    evaluateConstraints,
    type GridConfiguration,
    InsufficientDataError,
    measureConfiguration,
    parseTuningRule,
    selectWinner,
    shortlistForStageTwo,
    stageOneGrid,
    stageTwoGrid,
    type TuningCell,
    type TuningRule,
} from "./evaluation-tuning.ts";

const rule: TuningRule = {
  schemaVersion: 1,
  baseline: { method: "nearest_liked", centered: true, lambda: 0.5, recencyWeight: 0.1 },
  objectiveKs: [3, 5, 10, 20],
  tolerances: { balancedCoverage: 0.05, crosslingualPrecision: 0.05, winnerBand: 0.01 },
  shortlistSize: 2,
  stageOne: {
    interestModels: [
      { method: "nearest_liked", parameters: {} },
      { method: "top_m_mean", parameters: { top_m: 2 } },
    ],
    centered: [true, false],
  },
  stageTwo: { lambda: [0, 0.5], recencyWeight: [0.1, 0.2] },
  simplicity: { methodGroups: [["average_vector", "nearest_liked"], ["top_m_mean"], ["blend"]] },
};
const population = { singles: ["s1", "s2"], composites: ["s1+s2"] };
const everyone = [...population.singles, ...population.composites];

function cell(overrides: Partial<TuningCell>): TuningCell {
  return {
    runType: "standard",
    direction: null,
    scope: "headline",
    personaId: "s1",
    seed: 0,
    k: 3,
    status: "complete",
    precisionAt10: 0.5,
    balancedCoverage: null,
    ...overrides,
  };
}

function cellsFor(
  values: { precision?: number; coverage?: number; enFi?: number; fiEn?: number } = {},
): TuningCell[] {
  const { precision = 0.5, coverage = 0.5, enFi = 0.2, fiEn = 0.3 } = values;
  const cells: TuningCell[] = [];
  for (const personaId of everyone) {
    for (const k of rule.objectiveKs) {
      for (const seed of [0, 1]) {
        const composite = personaId.includes("+");
        cells.push(
          cell({
            personaId,
            k,
            seed,
            precisionAt10: precision,
            balancedCoverage: composite ? coverage : null,
          }),
          cell({
            runType: "crosslingual",
            direction: "en-fi",
            personaId,
            k,
            seed,
            precisionAt10: enFi,
          }),
          cell({
            runType: "crosslingual",
            direction: "fi-en",
            personaId,
            k,
            seed,
            precisionAt10: fiEn,
          }),
        );
      }
    }
  }
  return cells;
}

function metrics(values: {
  objective?: number;
  coverage?: number;
  enFi?: number | null;
  fiEn?: number | null;
}): ConfigurationMetrics {
  const direction = (value: number | null | undefined, fallback: number) => ({
    value: value === undefined ? fallback : value,
    omittedPersonaIds: [],
    availability: [],
  });
  return {
    objective: values.objective ?? 0.5,
    balancedCoverage: values.coverage ?? 0.5,
    enFi: direction(values.enFi, 0.2),
    fiEn: direction(values.fiEn, 0.3),
    objectiveAvailability: [],
    coverageAvailability: [],
  };
}

function grid(
  method: string,
  interest: Record<string, number>,
  centered: boolean,
  gridOrder: number,
  extra: { lambda?: number; recencyWeight?: number; stage?: 1 | 2 } = {},
): GridConfiguration {
  const spec = {
    method,
    interest,
    centered,
    lambda: extra.lambda ?? 0.5,
    recencyWeight: extra.recencyWeight ?? 0.1,
  };
  return { ...spec, id: configurationId(spec), stage: extra.stage ?? 1, gridOrder };
}

function evaluated(
  configuration: GridConfiguration,
  values: Parameters<typeof metrics>[0],
): EvaluatedConfiguration {
  return { configuration, metrics: metrics(values) };
}

describe("tuning grids", () => {
  it("builds the committed 16-configuration stage-1 grid with the baseline inside it", () => {
    const committed = parseTuningRule(
      readFileSync(new URL("../evaluation/tuning-rule.json", import.meta.url), "utf8"),
    );
    const grid = stageOneGrid(committed);

    expect(grid).toHaveLength(16);
    expect(new Set(grid.map(({ id }) => id)).size).toBe(16);
    expect(grid.map(({ gridOrder }) => gridOrder)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(baselineConfigurationId(committed)).toBe("nearest_liked-centered-l0.5-r0.1");
  });

  it("skips the stage-1 default point in each stage-2 grid", () => {
    const base = grid("top_m_mean", { top_m: 2 }, false, 3);
    const stageTwo = stageTwoGrid(rule, base, 10);

    expect(stageTwo).toHaveLength(3);
    expect(stageTwo.map(({ gridOrder }) => gridOrder)).toEqual([10, 11, 12]);
    expect(stageTwo.every(({ stage }) => stage === 2)).toBe(true);
    expect(
      stageTwo.some(({ lambda, recencyWeight }) => lambda === 0.5 && recencyWeight === 0.1),
    ).toBe(false);
  });
});

describe("measureConfiguration", () => {
  it("averages seeds, then k cells, then personas with equal weights", () => {
    const cells = [
      // s1: one k cell with 1 seed.
      cell({ personaId: "s1", k: 3, seed: 0, precisionAt10: 1 }),
      // s2: two k cells with unequal seed counts: mean(mean(0, 0), 0.6) = 0.3.
      cell({ personaId: "s2", k: 3, seed: 0, precisionAt10: 0 }),
      cell({ personaId: "s2", k: 3, seed: 1, precisionAt10: 0 }),
      cell({ personaId: "s2", k: 5, seed: 0, precisionAt10: 0.6 }),
      // Composite: one k cell.
      cell({ personaId: "s1+s2", k: 10, seed: 0, precisionAt10: 0.5, balancedCoverage: 1 }),
      cell({ personaId: "s1+s2", k: 10, seed: 1, precisionAt10: 0.5, balancedCoverage: 0 }),
    ];
    const result = measureConfiguration(cells, rule, population);

    expect(result.objective).toBeCloseTo((1 + 0.3 + 0.5) / 3, 12);
    expect(result.balancedCoverage).toBeCloseTo(0.5, 12);
    expect(result.objectiveAvailability).toContainEqual({
      personaId: "s2",
      k: 3,
      completeSeeds: 2,
    });
    expect(result.enFi).toEqual({ value: null, omittedPersonaIds: everyone, availability: [] });
  });

  it("ignores diagnostic cells, duplicate-inclusive cells, and missing cells", () => {
    const base = cellsFor();
    const noisy = [
      ...base,
      cell({ personaId: "s1", k: 1, precisionAt10: 0 }),
      cell({ personaId: "s1", k: 0, precisionAt10: 0 }),
      cell({ personaId: "s1", scope: "duplicate-inclusive", precisionAt10: 0 }),
      cell({ personaId: "s1", seed: 5, status: "missing", precisionAt10: null }),
      cell({
        runType: "crosslingual",
        direction: "en-fi",
        personaId: "s1",
        scope: "duplicate-inclusive",
        precisionAt10: 1,
      }),
    ];

    expect(measureConfiguration(noisy, rule, population)).toEqual(
      measureConfiguration(base, rule, population),
    );
  });

  it("throws an insufficient-data error when a persona has no objective cell", () => {
    const cells = cellsFor().filter(
      (entry) => !(entry.runType === "standard" && entry.personaId === "s2"),
    );

    expect(() => measureConfiguration(cells, rule, population)).toThrow(InsufficientDataError);
    expect(() => measureConfiguration(cells, rule, population)).toThrow("s2");
  });

  it("throws an insufficient-data error when a composite has no coverage cell", () => {
    const cells = cellsFor().map((entry) =>
      entry.personaId === "s1+s2" ? { ...entry, balancedCoverage: null } : entry,
    );

    expect(() => measureConfiguration(cells, rule, population)).toThrow(InsufficientDataError);
  });

  it("omits cross-lingual personas without cells and reports a direction with none as null", () => {
    const withoutS2 = cellsFor().filter(
      (entry) => !(entry.direction === "en-fi" && entry.personaId === "s2"),
    );
    const partial = measureConfiguration(withoutS2, rule, population);
    expect(partial.enFi.omittedPersonaIds).toEqual(["s2"]);
    expect(partial.enFi.value).toBeCloseTo(0.2, 12);

    const withoutDirection = cellsFor().filter((entry) => entry.direction !== "fi-en");
    const none = measureConfiguration(withoutDirection, rule, population);
    expect(none.fiEn.value).toBeNull();
    expect(none.fiEn.omittedPersonaIds).toEqual(everyone);
  });
});

describe("assertConsistentMissingCells", () => {
  it("accepts identical cell availability and rejects differing missing cells", () => {
    const first = { id: "first", cells: cellsFor({ precision: 0.1 }) };
    const same = { id: "same", cells: cellsFor({ precision: 0.9 }) };
    expect(() => assertConsistentMissingCells([first, same])).not.toThrow();

    const differing = {
      id: "differing",
      cells: cellsFor().map((entry, index) =>
        index === 0 ? { ...entry, status: "missing" as const, precisionAt10: null } : entry,
      ),
    };
    expect(() => assertConsistentMissingCells([first, differing])).toThrow(
      "Missing seed-level cells differ between first and differing",
    );

    const partialSeeds = { id: "partial", cells: cellsFor().slice(1) };
    expect(() => assertConsistentMissingCells([first, partialSeeds])).toThrow("partial");
  });
});

describe("evaluateConstraints", () => {
  const baseline = metrics({ coverage: 0.7, enFi: 0.3, fiEn: 0.4 });

  it("accepts values exactly 0.05 below and rejects values beyond", () => {
    const boundary = evaluateConstraints(
      metrics({ coverage: 0.7, enFi: 0.25, fiEn: 0.35 }),
      0.75,
      baseline,
      rule,
    );
    expect(boundary).toEqual({ coverageOk: true, enFiOk: true, fiEnOk: true, eligible: true });

    expect(evaluateConstraints(metrics({ coverage: 0.69 }), 0.75, baseline, rule).coverageOk).toBe(
      false,
    );
    expect(evaluateConstraints(metrics({ enFi: 0.249 }), 0.5, baseline, rule).enFiOk).toBe(false);
    expect(evaluateConstraints(metrics({ fiEn: 0.349 }), 0.5, baseline, rule).fiEnOk).toBe(false);
  });

  it("does not constrain a direction that is not assessable", () => {
    const result = evaluateConstraints(metrics({ enFi: null }), 0.5, metrics({ enFi: null }), rule);
    expect(result.enFiOk).toBe(true);
  });
});

describe("shortlistForStageTwo", () => {
  const baselineMetrics = metrics({ coverage: 0.5 });

  it("takes the two best qualifying configurations using stage-1 constraints only", () => {
    const stageOne = [
      evaluated(grid("nearest_liked", {}, true, 0), { objective: 0.6 }),
      evaluated(grid("nearest_liked", {}, false, 1), { objective: 0.7 }),
      evaluated(grid("top_m_mean", { top_m: 2 }, true, 2), { objective: 0.9, coverage: 0.2 }),
      evaluated(grid("top_m_mean", { top_m: 2 }, false, 3), { objective: 0.65 }),
    ];
    const result = shortlistForStageTwo(stageOne, baselineMetrics, rule);

    expect(result.shortlisted.map(({ gridOrder }) => gridOrder)).toEqual([1, 3]);
    expect(result.maxCoverage).toBe(0.5);
    expect(result.skippedReason).toBeNull();
    expect(
      result.rows.find(({ id }) => id === stageOne[2]?.configuration.id)?.constraints.eligible,
    ).toBe(false);
  });

  it("breaks exact objective ties by simplicity, then grid order", () => {
    const stageOne = [
      evaluated(grid("top_m_mean", { top_m: 2 }, false, 0), { objective: 0.7 }),
      evaluated(grid("nearest_liked", {}, true, 1), { objective: 0.7 }),
      evaluated(grid("nearest_liked", {}, false, 2), { objective: 0.7 }),
    ];
    const result = shortlistForStageTwo(stageOne, baselineMetrics, rule);

    expect(result.shortlisted.map(({ gridOrder }) => gridOrder)).toEqual([2, 1]);
  });

  it("tunes one configuration when only one qualifies", () => {
    const stageOne = [
      evaluated(grid("nearest_liked", {}, true, 0), { objective: 0.6, coverage: 0.5 }),
      evaluated(grid("nearest_liked", {}, false, 1), { objective: 0.9, enFi: 0.1 }),
    ];
    const result = shortlistForStageTwo(stageOne, baselineMetrics, rule);

    expect(result.shortlisted.map(({ gridOrder }) => gridOrder)).toEqual([0]);
  });

  it("skips stage 2 when no configuration qualifies", () => {
    const stageOne = [
      evaluated(grid("nearest_liked", {}, true, 0), { enFi: 0.1 }),
      evaluated(grid("nearest_liked", {}, false, 1), { enFi: 0.1 }),
    ];
    const result = shortlistForStageTwo(stageOne, baselineMetrics, rule);

    expect(result.shortlisted).toEqual([]);
    expect(result.skippedReason).toContain("production default is retained");
  });
});

describe("selectWinner", () => {
  const baselineMetrics = metrics({ coverage: 0.5 });
  const nearestCentered = grid("nearest_liked", {}, true, 0);
  const nearestRaw = grid("nearest_liked", {}, false, 1);
  const topM = grid("top_m_mean", { top_m: 2 }, true, 2);

  it("anchors the 0.01 band to the best configuration that meets the constraints", () => {
    const result = selectWinner(
      [
        evaluated(nearestCentered, { objective: 0.8 }),
        evaluated(nearestRaw, { objective: 0.795 }),
        evaluated(topM, { objective: 0.95, coverage: 0.1 }),
      ],
      baselineMetrics,
      rule,
    );

    expect(result.bestObjective).toBe(0.8);
    expect(result.bandIds).toEqual([nearestRaw.id, nearestCentered.id]);
    expect(result.winnerId).toBe(nearestRaw.id);
  });

  it("includes configurations exactly 0.01 below and excludes values just beyond", () => {
    const result = selectWinner(
      [
        evaluated(topM, { objective: 0.8 }),
        evaluated(nearestCentered, { objective: 0.79 }),
        evaluated(nearestRaw, { objective: 0.7899 }),
      ],
      baselineMetrics,
      rule,
    );

    expect(result.bandIds).toEqual([nearestCentered.id, topM.id]);
    expect(result.winnerId).toBe(nearestCentered.id);
  });

  it("prefers fewer changed parameters, then higher objective, then grid order", () => {
    const tuned = grid("nearest_liked", {}, true, 5, { lambda: 0.25, stage: 2 });
    const result = selectWinner(
      [evaluated(tuned, { objective: 0.805 }), evaluated(nearestCentered, { objective: 0.8 })],
      baselineMetrics,
      rule,
    );
    expect(result.winnerId).toBe(nearestCentered.id);

    const tie = selectWinner(
      [
        evaluated(grid("nearest_liked", {}, true, 7), { objective: 0.8 }),
        evaluated(grid("average_vector", {}, true, 6), { objective: 0.805 }),
      ],
      baselineMetrics,
      rule,
    );
    expect(tie.winnerId).toBe(grid("average_vector", {}, true, 6).id);

    const equal = selectWinner(
      [
        evaluated(grid("nearest_liked", {}, true, 9), { objective: 0.8 }),
        evaluated(grid("average_vector", {}, true, 8), { objective: 0.8 }),
      ],
      baselineMetrics,
      rule,
    );
    expect(equal.winnerId).toBe(grid("average_vector", {}, true, 8).id);
  });

  it("recomputes constraints across both stages so a shortlisted configuration can lose eligibility", () => {
    const stageOneWinner = evaluated(nearestRaw, { objective: 0.9, coverage: 0.5 });
    const stageTwoHighCoverage = evaluated(
      grid("nearest_liked", {}, false, 20, { lambda: 0, stage: 2 }),
      { objective: 0.85, coverage: 0.6 },
    );
    const stageOneOnly = shortlistForStageTwo([stageOneWinner], baselineMetrics, rule);
    expect(stageOneOnly.shortlisted).toHaveLength(1);

    const result = selectWinner([stageOneWinner, stageTwoHighCoverage], baselineMetrics, rule);
    expect(result.maxCoverage).toBe(0.6);
    expect(result.rows.find(({ id }) => id === nearestRaw.id)?.constraints.coverageOk).toBe(false);
    expect(result.winnerId).toBe(stageTwoHighCoverage.configuration.id);
  });

  it("keeps the production default when no configuration meets the constraints", () => {
    const result = selectWinner(
      [evaluated(nearestCentered, { fiEn: 0.1 }), evaluated(nearestRaw, { enFi: 0.1 })],
      baselineMetrics,
      rule,
    );

    expect(result.winnerId).toBeNull();
    expect(result.bestObjective).toBeNull();
    expect(result.bandIds).toEqual([]);
  });
});
