export interface TuningRule {
  schemaVersion: 1;
  baseline: { method: string; centered: boolean; lambda: number; recencyWeight: number };
  objectiveKs: number[];
  tolerances: { balancedCoverage: number; crosslingualPrecision: number; winnerBand: number };
  shortlistSize: number;
  stageOne: {
    interestModels: { method: string; parameters: Record<string, number> }[];
    centered: boolean[];
  };
  stageTwo: { lambda: number[]; recencyWeight: number[] };
  simplicity: { methodGroups: string[][] };
}

export interface TuningCell {
  runType: "standard" | "crosslingual";
  direction: "en-fi" | "fi-en" | null;
  scope: "headline" | "duplicate-inclusive";
  personaId: string;
  seed: number;
  k: number;
  status: "complete" | "missing";
  precisionAt10: number | null;
  balancedCoverage: number | null;
  distinctSources?: number | null;
}

export interface ConfigurationSpec {
  method: string;
  interest: Record<string, number>;
  centered: boolean;
  lambda: number;
  recencyWeight: number;
}

export interface GridConfiguration extends ConfigurationSpec {
  id: string;
  stage: 1 | 2;
  gridOrder: number;
}

export interface Population {
  singles: string[];
  composites: string[];
}

export interface CellAvailability {
  personaId: string;
  k: number;
  completeSeeds: number;
}

export interface MetricValue {
  value: number | null;
  omittedPersonaIds: string[];
  availability: CellAvailability[];
}

export interface ConfigurationMetrics {
  objective: number;
  balancedCoverage: number;
  enFi: MetricValue;
  fiEn: MetricValue;
  objectiveAvailability: CellAvailability[];
  coverageAvailability: CellAvailability[];
}

export interface EvaluatedConfiguration {
  configuration: GridConfiguration;
  metrics: ConfigurationMetrics;
}

export interface ConstraintResult {
  coverageOk: boolean;
  enFiOk: boolean;
  fiEnOk: boolean;
  eligible: boolean;
}

export interface ConstraintRow {
  id: string;
  constraints: ConstraintResult;
}

export class InsufficientDataError extends Error {}

const epsilon = 1e-9;

export function parseTuningRule(content: string): TuningRule {
  const rule = JSON.parse(content) as TuningRule;
  if (rule.schemaVersion !== 1) throw new Error("Unsupported tuning rule schema version");
  return rule;
}

function formatNumber(value: number): string {
  return String(value);
}

export function configurationId(spec: ConfigurationSpec): string {
  return [
    spec.method,
    ...Object.entries(spec.interest).map(([key, value]) => `${key}${formatNumber(value)}`),
    spec.centered ? "centered" : "raw",
    `l${formatNumber(spec.lambda)}`,
    `r${formatNumber(spec.recencyWeight)}`,
  ].join("-");
}

export function configurationParameters(spec: ConfigurationSpec): Record<string, unknown> {
  return {
    ...spec.interest,
    centered: spec.centered,
    lambda: spec.lambda,
    recency_weight: spec.recencyWeight,
  };
}

function gridConfiguration(
  spec: ConfigurationSpec,
  stage: 1 | 2,
  gridOrder: number,
): GridConfiguration {
  return { ...spec, id: configurationId(spec), stage, gridOrder };
}

export function stageOneGrid(rule: TuningRule): GridConfiguration[] {
  const specs = rule.stageOne.interestModels.flatMap((model) =>
    rule.stageOne.centered.map(
      (centered): ConfigurationSpec => ({
        method: model.method,
        interest: model.parameters,
        centered,
        lambda: rule.baseline.lambda,
        recencyWeight: rule.baseline.recencyWeight,
      }),
    ),
  );
  return specs.map((spec, index) => gridConfiguration(spec, 1, index));
}

export function baselineConfigurationId(rule: TuningRule): string {
  const match = stageOneGrid(rule).find(
    (candidate) =>
      candidate.method === rule.baseline.method &&
      candidate.centered === rule.baseline.centered &&
      Object.keys(candidate.interest).length === 0,
  );
  if (!match) throw new Error("The baseline must be one of the stage-1 configurations");
  return match.id;
}

// The stage-1 default point is skipped because stage 1 already ran it.
export function stageTwoGrid(
  rule: TuningRule,
  base: GridConfiguration,
  firstGridOrder: number,
): GridConfiguration[] {
  const grid: GridConfiguration[] = [];
  for (const lambda of rule.stageTwo.lambda) {
    for (const recencyWeight of rule.stageTwo.recencyWeight) {
      if (lambda === base.lambda && recencyWeight === base.recencyWeight) continue;
      grid.push(
        gridConfiguration(
          {
            method: base.method,
            interest: base.interest,
            centered: base.centered,
            lambda,
            recencyWeight,
          },
          2,
          firstGridOrder + grid.length,
        ),
      );
    }
  }
  return grid;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregate(
  cells: TuningCell[],
  personaIds: string[],
  ks: number[],
  select: (cell: TuningCell) => number | null,
): MetricValue {
  const availability: CellAvailability[] = [];
  const personaValues: number[] = [];
  const omittedPersonaIds: string[] = [];
  for (const personaId of personaIds) {
    const kValues: number[] = [];
    for (const k of ks) {
      const values = cells
        .filter((cell) => cell.personaId === personaId && cell.k === k)
        .map(select)
        .filter((value): value is number => value !== null);
      if (values.length === 0) continue;
      kValues.push(mean(values));
      availability.push({ personaId, k, completeSeeds: values.length });
    }
    if (kValues.length === 0) omittedPersonaIds.push(personaId);
    else personaValues.push(mean(kValues));
  }
  return {
    value: personaValues.length === 0 ? null : mean(personaValues),
    omittedPersonaIds,
    availability,
  };
}

export function measureConfiguration(
  cells: TuningCell[],
  rule: Pick<TuningRule, "objectiveKs">,
  population: Population,
): ConfigurationMetrics {
  const complete = cells.filter(
    (cell) =>
      cell.status === "complete" && cell.scope === "headline" && rule.objectiveKs.includes(cell.k),
  );
  const standard = complete.filter((cell) => cell.runType === "standard");
  const crosslingual = complete.filter((cell) => cell.runType === "crosslingual");
  const everyone = [...population.singles, ...population.composites];
  const objective = aggregate(standard, everyone, rule.objectiveKs, (cell) => cell.precisionAt10);
  if (objective.value === null || objective.omittedPersonaIds.length > 0) {
    throw new InsufficientDataError(
      `No available objective cell for: ${objective.omittedPersonaIds.join(", ")}`,
    );
  }
  const coverage = aggregate(
    standard,
    population.composites,
    rule.objectiveKs,
    (cell) => cell.balancedCoverage,
  );
  if (coverage.value === null || coverage.omittedPersonaIds.length > 0) {
    throw new InsufficientDataError(
      `No available balanced-coverage cell for: ${coverage.omittedPersonaIds.join(", ")}`,
    );
  }
  const direction = (name: "en-fi" | "fi-en") =>
    aggregate(
      crosslingual.filter((cell) => cell.direction === name),
      everyone,
      rule.objectiveKs,
      (cell) => cell.precisionAt10,
    );
  return {
    objective: objective.value,
    balancedCoverage: coverage.value,
    enFi: direction("en-fi"),
    fiEn: direction("fi-en"),
    objectiveAvailability: objective.availability,
    coverageAvailability: coverage.availability,
  };
}

function cellSignature(cell: TuningCell): string {
  return [
    cell.runType,
    cell.direction ?? "",
    cell.scope,
    cell.personaId,
    cell.seed,
    cell.k,
    cell.status,
  ].join("|");
}

export function measureDistinctSources(
  cells: TuningCell[],
  objectiveKs: number[],
  population: Population,
): number {
  const complete = cells.filter(
    (cell) =>
      cell.runType === "standard" &&
      cell.status === "complete" &&
      cell.scope === "headline" &&
      objectiveKs.includes(cell.k),
  );
  const value = aggregate(
    complete,
    [...population.singles, ...population.composites],
    objectiveKs,
    (cell) => cell.distinctSources ?? null,
  );
  if (value.value === null || value.omittedPersonaIds.length > 0) {
    throw new InsufficientDataError(
      `No available distinct-source cell for: ${value.omittedPersonaIds.join(", ")}`,
    );
  }
  return value.value;
}

export function assertConsistentMissingCells(
  configurations: { id: string; cells: TuningCell[] }[],
): void {
  const [first, ...rest] = configurations;
  if (!first) return;
  const expected = first.cells.map(cellSignature).toSorted();
  for (const configuration of rest) {
    const actual = configuration.cells.map(cellSignature).toSorted();
    if (actual.length !== expected.length || actual.some((entry, i) => entry !== expected[i])) {
      throw new Error(
        `Missing seed-level cells differ between ${first.id} and ${configuration.id}`,
      );
    }
  }
}

export function evaluateConstraints(
  metrics: ConfigurationMetrics,
  maxCoverage: number,
  baseline: ConfigurationMetrics,
  rule: TuningRule,
): ConstraintResult {
  const coverageOk =
    metrics.balancedCoverage >= maxCoverage - rule.tolerances.balancedCoverage - epsilon;
  const directionOk = (value: number | null, reference: number | null) =>
    reference === null ||
    (value !== null && value >= reference - rule.tolerances.crosslingualPrecision - epsilon);
  const enFiOk = directionOk(metrics.enFi.value, baseline.enFi.value);
  const fiEnOk = directionOk(metrics.fiEn.value, baseline.fiEn.value);
  return { coverageOk, enFiOk, fiEnOk, eligible: coverageOk && enFiOk && fiEnOk };
}

function interestParameterCount(configuration: ConfigurationSpec): number {
  return Object.keys(configuration.interest).length;
}

function changedFromBaseline(configuration: ConfigurationSpec, rule: TuningRule): number {
  return (
    (configuration.lambda === rule.baseline.lambda ? 0 : 1) +
    (configuration.recencyWeight === rule.baseline.recencyWeight ? 0 : 1)
  );
}

function methodRank(method: string, rule: TuningRule): number {
  const index = rule.simplicity.methodGroups.findIndex((group) => group.includes(method));
  return index === -1 ? rule.simplicity.methodGroups.length : index;
}

// Fewer parameters, then simpler interest model, then raw before centered.
function compareSimplicity(
  left: GridConfiguration,
  right: GridConfiguration,
  rule: TuningRule,
): number {
  return (
    interestParameterCount(left) +
      changedFromBaseline(left, rule) -
      (interestParameterCount(right) + changedFromBaseline(right, rule)) ||
    methodRank(left.method, rule) - methodRank(right.method, rule) ||
    Number(left.centered) - Number(right.centered)
  );
}

function maxCoverageOf(evaluated: EvaluatedConfiguration[]): number {
  return Math.max(...evaluated.map(({ metrics }) => metrics.balancedCoverage));
}

function constraintRows(
  evaluated: EvaluatedConfiguration[],
  reference: EvaluatedConfiguration[],
  baseline: ConfigurationMetrics,
  rule: TuningRule,
): ConstraintRow[] {
  const maxCoverage = maxCoverageOf(reference);
  return evaluated.map(({ configuration, metrics }) => ({
    id: configuration.id,
    constraints: evaluateConstraints(metrics, maxCoverage, baseline, rule),
  }));
}

export interface StageOneShortlist {
  maxCoverage: number;
  rows: ConstraintRow[];
  shortlisted: GridConfiguration[];
  skippedReason: string | null;
}

export function shortlistForStageTwo(
  stageOne: EvaluatedConfiguration[],
  baseline: ConfigurationMetrics,
  rule: TuningRule,
): StageOneShortlist {
  const rows = constraintRows(stageOne, stageOne, baseline, rule);
  const qualifying = stageOne.filter(
    ({ configuration }) => rows.find((row) => row.id === configuration.id)?.constraints.eligible,
  );
  const shortlisted = qualifying
    .toSorted(
      (left, right) =>
        (Math.abs(left.metrics.objective - right.metrics.objective) <= 1e-12
          ? 0
          : right.metrics.objective - left.metrics.objective) ||
        compareSimplicity(left.configuration, right.configuration, rule) ||
        left.configuration.gridOrder - right.configuration.gridOrder,
    )
    .slice(0, rule.shortlistSize)
    .map(({ configuration }) => configuration);
  return {
    maxCoverage: maxCoverageOf(stageOne),
    rows,
    shortlisted,
    skippedReason:
      shortlisted.length === 0
        ? "No stage-1 configuration meets the constraints; the production default is retained."
        : null,
  };
}

export interface FinalSelection {
  maxCoverage: number;
  rows: ConstraintRow[];
  bestObjective: number | null;
  bandIds: string[];
  winnerId: string | null;
}

export function selectWinner(
  all: EvaluatedConfiguration[],
  baseline: ConfigurationMetrics,
  rule: TuningRule,
): FinalSelection {
  const rows = constraintRows(all, all, baseline, rule);
  const eligible = all.filter(
    ({ configuration }) => rows.find((row) => row.id === configuration.id)?.constraints.eligible,
  );
  const maxCoverage = maxCoverageOf(all);
  if (eligible.length === 0) {
    return { maxCoverage, rows, bestObjective: null, bandIds: [], winnerId: null };
  }
  const bestObjective = Math.max(...eligible.map(({ metrics }) => metrics.objective));
  const band = eligible
    .filter(
      ({ metrics }) => metrics.objective >= bestObjective - rule.tolerances.winnerBand - epsilon,
    )
    .toSorted(
      (left, right) =>
        compareSimplicity(left.configuration, right.configuration, rule) ||
        right.metrics.objective - left.metrics.objective ||
        left.configuration.gridOrder - right.configuration.gridOrder,
    );
  return {
    maxCoverage,
    rows,
    bestObjective,
    bandIds: band.map(({ configuration }) => configuration.id),
    winnerId: band[0]?.configuration.id ?? null,
  };
}
