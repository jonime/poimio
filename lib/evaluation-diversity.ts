import type { ConfigurationMetrics } from "./evaluation-tuning.ts";

export interface DiversityRule {
  schemaVersion: 1;
  spec: string;
  fixed: {
    method: string;
    parameters: Record<string, number | boolean>;
    exploration: boolean;
  };
  objectiveKs: number[];
  diversityGrid: number[];
  tolerances: {
    objective: number;
    crosslingualPrecision: number;
    balancedCoverageImprovement: number;
    winnerBand: number;
  };
}

export interface DiversityConfiguration {
  id: string;
  method: string;
  diversity: number;
  exploration: boolean;
  parameters: Record<string, number | boolean>;
  gridOrder: number;
}

export interface EvaluatedDiversityConfiguration {
  configuration: DiversityConfiguration;
  metrics: ConfigurationMetrics & { distinctSources: number };
}

export interface DiversityConstraintResult {
  objectiveOk: boolean;
  coverageOk: boolean;
  enFiOk: boolean;
  fiEnOk: boolean;
  eligible: boolean;
}

export interface DiversitySelection {
  referenceId: string;
  maxCoverage: number | null;
  rows: Array<{ id: string; constraints: DiversityConstraintResult }>;
  bandIds: string[];
  winnerId: string;
}

const epsilon = 1e-9;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseDiversityRule(content: string): DiversityRule {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value)) throw new Error("Diversity rule has an invalid schema");
  const fixed = value.fixed;
  const tolerances = value.tolerances;
  if (
    value.schemaVersion !== 1 ||
    typeof value.spec !== "string" ||
    !isRecord(fixed) ||
    typeof fixed.method !== "string" ||
    !isRecord(fixed.parameters) ||
    Object.values(fixed.parameters).some(
      (parameter) => typeof parameter !== "number" && typeof parameter !== "boolean",
    ) ||
    typeof fixed.exploration !== "boolean" ||
    !Array.isArray(value.objectiveKs) ||
    value.objectiveKs.length === 0 ||
    value.objectiveKs.some((objectiveK) => !Number.isInteger(objectiveK) || objectiveK < 0) ||
    !Array.isArray(value.diversityGrid) ||
    !value.diversityGrid.includes(0) ||
    value.diversityGrid.some(
      (diversity) => !finiteNumber(diversity) || diversity < 0 || diversity > 1,
    ) ||
    !isRecord(tolerances) ||
    [
      tolerances.objective,
      tolerances.crosslingualPrecision,
      tolerances.balancedCoverageImprovement,
      tolerances.winnerBand,
    ].some((tolerance) => !finiteNumber(tolerance) || tolerance < 0)
  ) {
    throw new Error("Diversity rule has an invalid schema");
  }
  return value as unknown as DiversityRule;
}

export function diversityConfiguration(
  rule: DiversityRule,
  diversity: number,
  exploration = rule.fixed.exploration,
): DiversityConfiguration {
  const parameters = { ...rule.fixed.parameters, diversity, exploration };
  const orderedParameters = Object.entries(parameters)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${String(value)}`);
  return {
    id: [rule.fixed.method, ...orderedParameters].join("-"),
    method: rule.fixed.method,
    diversity,
    exploration,
    parameters,
    gridOrder: rule.diversityGrid.indexOf(diversity),
  };
}

export function diversityGrid(rule: DiversityRule): DiversityConfiguration[] {
  return rule.diversityGrid.map((value) => diversityConfiguration(rule, value));
}

function directionOk(value: number | null, reference: number | null, tolerance: number): boolean {
  return reference === null || (value !== null && value >= reference - tolerance - epsilon);
}

export function selectDiversityWinner(
  evaluated: EvaluatedDiversityConfiguration[],
  rule: DiversityRule,
): DiversitySelection {
  const reference = evaluated.find(({ configuration }) => configuration.diversity === 0);
  if (!reference) throw new Error("Diversity grid must include the reference mu=0");

  const rows = evaluated.map(({ configuration, metrics }) => {
    const objectiveOk =
      metrics.objective >= reference.metrics.objective - rule.tolerances.objective - epsilon;
    const coverageOk =
      metrics.balancedCoverage >=
      reference.metrics.balancedCoverage + rule.tolerances.balancedCoverageImprovement - epsilon;
    const enFiOk = directionOk(
      metrics.enFi.value,
      reference.metrics.enFi.value,
      rule.tolerances.crosslingualPrecision,
    );
    const fiEnOk = directionOk(
      metrics.fiEn.value,
      reference.metrics.fiEn.value,
      rule.tolerances.crosslingualPrecision,
    );
    return {
      id: configuration.id,
      constraints: {
        objectiveOk,
        coverageOk,
        enFiOk,
        fiEnOk,
        eligible: coverageOk && objectiveOk && enFiOk && fiEnOk,
      },
    };
  });
  const eligible = evaluated.filter(
    ({ configuration }) =>
      configuration.diversity > 0 &&
      rows.find((row) => row.id === configuration.id)?.constraints.eligible,
  );
  if (eligible.length === 0) {
    return {
      referenceId: reference.configuration.id,
      maxCoverage: null,
      rows,
      bandIds: [],
      winnerId: reference.configuration.id,
    };
  }
  const maxCoverage = Math.max(...eligible.map(({ metrics }) => metrics.balancedCoverage));
  const band = eligible
    .filter(
      ({ metrics }) =>
        metrics.balancedCoverage >= maxCoverage - rule.tolerances.winnerBand - epsilon,
    )
    .toSorted((left, right) => left.configuration.diversity - right.configuration.diversity);
  return {
    referenceId: reference.configuration.id,
    maxCoverage,
    rows,
    bandIds: band.map(({ configuration }) => configuration.id),
    winnerId: band[0]?.configuration.id ?? reference.configuration.id,
  };
}

export interface ExplorationReplayCell {
  runType: "standard" | "crosslingual";
  scope: "headline" | "duplicate-inclusive";
  personaId: string;
  seed: number;
  k: number;
  status: "complete" | "missing";
  precisionAt10: number | null;
  distinctSources: number | null;
  position5Exploration: boolean;
  position5Relevant: boolean | null;
}

function completeStandardHeadline(cells: ExplorationReplayCell[]): ExplorationReplayCell[] {
  return cells.filter(
    (cell) =>
      cell.runType === "standard" &&
      cell.scope === "headline" &&
      cell.status === "complete" &&
      cell.precisionAt10 !== null &&
      cell.distinctSources !== null,
  );
}

function explorationKey(cell: ExplorationReplayCell): string {
  return [cell.personaId, cell.seed, cell.k].join("|");
}

export interface ExplorationReport {
  runCount: number;
  objectiveDifference: number;
  distinctSourcesDifference: number;
  slotFillRate: number;
  flaggedItemCount: number;
  relevantFlaggedItemCount: number;
  hitRate: number | null;
}

export function explorationReport(
  offCells: ExplorationReplayCell[],
  onCells: ExplorationReplayCell[],
): ExplorationReport {
  const offByKey = new Map(
    completeStandardHeadline(offCells).map((cell) => [explorationKey(cell), cell]),
  );
  const paired = completeStandardHeadline(onCells).flatMap((on) => {
    const off = offByKey.get(explorationKey(on));
    return off ? [[off, on] as const] : [];
  });
  if (paired.length === 0) {
    throw new Error("Exploration report has no complete paired standard runs");
  }
  const objectiveDifference =
    paired.reduce((sum, [off, on]) => sum + (on.precisionAt10 ?? 0) - (off.precisionAt10 ?? 0), 0) /
    paired.length;
  const distinctSourcesDifference =
    paired.reduce(
      (sum, [off, on]) => sum + (on.distinctSources ?? 0) - (off.distinctSources ?? 0),
      0,
    ) / paired.length;
  const flagged = paired.filter(([, on]) => on.position5Exploration);
  const relevantFlagged = flagged.filter(([, on]) => on.position5Relevant === true);
  return {
    runCount: paired.length,
    objectiveDifference,
    distinctSourcesDifference,
    slotFillRate: flagged.length / paired.length,
    flaggedItemCount: flagged.length,
    relevantFlaggedItemCount: relevantFlagged.length,
    hitRate: flagged.length === 0 ? null : relevantFlagged.length / flagged.length,
  };
}
