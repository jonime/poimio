import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCsv } from "../lib/early-ranking.ts";
import {
    type DiversityConfiguration,
    type DiversityRule,
    diversityConfiguration,
    diversityGrid,
    type EvaluatedDiversityConfiguration,
    type ExplorationReplayCell,
    explorationReport,
    parseDiversityRule,
    selectDiversityWinner,
} from "../lib/evaluation-diversity.ts";
import { compositePersonas } from "../lib/evaluation-replay.ts";
import { assertEvaluationRuleHash, normalizeEvaluationRulePath } from "../lib/evaluation-rule.ts";
import { sha256 } from "../lib/evaluation-snapshot.ts";
import {
    assertConsistentMissingCells,
    baselineConfigurationId,
    type ConfigurationMetrics,
    configurationParameters,
    type EvaluatedConfiguration,
    type GridConfiguration,
    measureConfiguration,
    measureDistinctSources,
    parseTuningRule,
    selectWinner,
    shortlistForStageTwo,
    stageOneGrid,
    stageTwoGrid,
    type TuningCell,
} from "../lib/evaluation-tuning.ts";
import { requireDefined } from "../lib/required.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface ReplayResult {
  provenance: {
    snapshotManifestHash: string;
    labelSetId: string;
    labelSetHash: string;
    nearDuplicateThreshold: number;
    tuningRuleHash: string | null;
    methods: { name: string; method: string; parameters: Record<string, unknown> }[];
  };
  cells: Array<TuningCell & ExplorationReplayCell>;
}

interface RunRecord {
  evaluated: EvaluatedConfiguration;
  cells: TuningCell[];
  parameters: Record<string, unknown>;
  resultFile: string;
  resultHash: string;
}

function parseArguments(args: string[]): string {
  let rulePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = requireDefined(args[index], "CLI argument");
    if (argument === "--window" || argument.startsWith("--window=")) {
      const window = argument === "--window" ? args[++index] : argument.slice("--window=".length);
      if (window !== "validation") {
        throw new Error("eval:tune runs on the validation window only; it refuses --window test");
      }
    } else if (argument === "--rule" || argument.startsWith("--rule=")) {
      rulePath = argument === "--rule" ? args[++index] : argument.slice("--rule=".length);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return normalizeEvaluationRulePath(rulePath);
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function requireCommittedRule(rulePath: string): void {
  try {
    git(["ls-files", "--error-unmatch", rulePath]);
  } catch {
    throw new Error(`${rulePath} must be committed before the first stage-1 run`);
  }
  if (git(["status", "--porcelain", "--", rulePath]).length > 0) {
    throw new Error(`${rulePath} has uncommitted changes; commit the selection rule first`);
  }
}

function runReplay(
  configuration: GridConfiguration,
  directoryName: string,
  rulePath: string,
): { resultName: string; relativePath: string } {
  const resultName = `${directoryName}/${configuration.id}`;
  const parameterArguments = Object.entries(configurationParameters(configuration)).flatMap(
    ([key, value]) => ["--param", `${key}=${JSON.stringify(value)}`],
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/evaluation-replay.mts"),
      "--window",
      "validation",
      "--method",
      configuration.method,
      "--rule",
      rulePath,
      ...parameterArguments,
      "--result-name",
      resultName,
    ],
    { cwd: root, env: process.env, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.status !== 0) {
    throw new Error(`Replay for ${configuration.id} failed with status ${result.status}`);
  }
  return { resultName, relativePath: `evaluation/results/${resultName}.json` };
}

async function runConfiguration(
  configuration: GridConfiguration,
  directoryName: string,
  ruleHash: string,
  population: { singles: string[]; composites: string[] },
  rule: ReturnType<typeof parseTuningRule>,
  rulePath: string,
): Promise<RunRecord> {
  console.log(`Running ${configuration.id} (stage ${configuration.stage})`);
  const { relativePath } = runReplay(configuration, directoryName, rulePath);
  const text = await readFile(resolve(root, relativePath), "utf8");
  const result = JSON.parse(text) as ReplayResult;
  assertEvaluationRuleHash(result.provenance.tuningRuleHash, ruleHash, rulePath);
  const resolved = requireDefined(result.provenance.methods[0], "resolved method");
  for (const [key, value] of Object.entries(configurationParameters(configuration))) {
    if (resolved.parameters[key] !== value) {
      throw new Error(`${configuration.id}: resolved ${key} differs from the requested value`);
    }
  }
  return {
    evaluated: {
      configuration,
      metrics: measureConfiguration(result.cells, rule, population),
    },
    cells: result.cells,
    parameters: resolved.parameters,
    resultFile: relativePath,
    resultHash: sha256(text),
  };
}

function summaryRow(
  record: RunRecord,
  stageOneEligible: boolean | null,
  final: ReturnType<typeof selectWinner>,
) {
  const { configuration, metrics } = record.evaluated;
  const finalRow = requireDefined(
    final.rows.find((row) => row.id === configuration.id),
    `final row for ${configuration.id}`,
  );
  return {
    id: configuration.id,
    stage: configuration.stage,
    gridOrder: configuration.gridOrder,
    method: configuration.method,
    parameters: record.parameters,
    objective: metrics.objective,
    balancedCoverage: metrics.balancedCoverage,
    enFiPrecision: metrics.enFi.value,
    fiEnPrecision: metrics.fiEn.value,
    stageOneEligible,
    finalConstraints: finalRow.constraints,
    withinBand: final.bandIds.includes(configuration.id),
    winner: final.winnerId === configuration.id,
    resultFile: record.resultFile,
    resultHash: record.resultHash,
  };
}

interface DiversityRunRecord {
  evaluated: EvaluatedDiversityConfiguration;
  cells: Array<TuningCell & ExplorationReplayCell>;
  parameters: Record<string, unknown>;
  resultFile: string;
  resultHash: string;
}

function runDiversityReplay(
  configuration: DiversityConfiguration,
  directoryName: string,
  rulePath: string,
): string {
  const relativePath = `evaluation/results/${directoryName}/${configuration.id}.json`;
  const parameterArguments = Object.entries(configuration.parameters).flatMap(([key, value]) => [
    "--param",
    `${key}=${JSON.stringify(value)}`,
  ]);
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/evaluation-replay.mts"),
      "--window",
      "validation",
      "--method",
      configuration.method,
      "--rule",
      rulePath,
      ...parameterArguments,
      "--result-name",
      `${directoryName}/${configuration.id}`,
    ],
    { cwd: root, env: process.env, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.status !== 0) {
    throw new Error(`Replay for ${configuration.id} failed with status ${result.status}`);
  }
  return relativePath;
}

async function runDiversityConfiguration(
  configuration: DiversityConfiguration,
  directoryName: string,
  rulePath: string,
  ruleHash: string,
  rule: DiversityRule,
  population: { singles: string[]; composites: string[] },
): Promise<DiversityRunRecord> {
  console.log(`Running ${configuration.id}`);
  const resultFile = runDiversityReplay(configuration, directoryName, rulePath);
  const text = await readFile(resolve(root, resultFile), "utf8");
  const result = JSON.parse(text) as ReplayResult;
  assertEvaluationRuleHash(result.provenance.tuningRuleHash, ruleHash, rulePath);
  const resolved = requireDefined(result.provenance.methods[0], "resolved method");
  for (const [key, value] of Object.entries(configuration.parameters)) {
    if (resolved.parameters[key] !== value) {
      throw new Error(`${configuration.id}: resolved ${key} differs from the requested value`);
    }
  }
  return {
    evaluated: {
      configuration,
      metrics: {
        ...measureConfiguration(result.cells, rule, population),
        distinctSources: measureDistinctSources(result.cells, rule.objectiveKs, population),
      },
    },
    cells: result.cells,
    parameters: resolved.parameters,
    resultFile,
    resultHash: sha256(text),
  };
}

async function runDiversitySearch(
  rulePath: string,
  ruleText: string,
  rule: DiversityRule,
): Promise<void> {
  const ruleHash = sha256(ruleText);
  const personas = JSON.parse(
    await readFile(resolve(root, "evaluation/personas.json"), "utf8"),
  ) as { id: string }[];
  const singles = personas.map(({ id }) => id);
  const population = {
    singles,
    composites: compositePersonas(singles).map(({ id }) => id),
  };
  const timestamp = new Date().toISOString().replaceAll(":", "-").toLowerCase();
  const directoryName = `diversity-${timestamp}`;
  const records: DiversityRunRecord[] = [];
  for (const configuration of diversityGrid(rule)) {
    records.push(
      await runDiversityConfiguration(
        configuration,
        directoryName,
        rulePath,
        ruleHash,
        rule,
        population,
      ),
    );
  }
  assertConsistentMissingCells(
    records.map(({ evaluated, cells }) => ({ id: evaluated.configuration.id, cells })),
  );
  const selection = selectDiversityWinner(
    records.map(({ evaluated }) => evaluated),
    rule,
  );
  const chosenOff = requireDefined(
    records.find(({ evaluated }) => evaluated.configuration.id === selection.winnerId),
    "chosen diversity configuration",
  );
  const explorationConfiguration = diversityConfiguration(
    rule,
    chosenOff.evaluated.configuration.diversity,
    true,
  );
  const explorationOn = await runDiversityConfiguration(
    explorationConfiguration,
    directoryName,
    rulePath,
    ruleHash,
    rule,
    population,
  );
  const firstResult = JSON.parse(
    await readFile(
      resolve(root, requireDefined(records[0], "first diversity run").resultFile),
      "utf8",
    ),
  ) as ReplayResult;
  const constraintsById = new Map(selection.rows.map((row) => [row.id, row.constraints]));
  const configurations = records.map((record) => ({
    id: record.evaluated.configuration.id,
    method: record.evaluated.configuration.method,
    parameters: record.parameters,
    metrics: record.evaluated.metrics,
    eligibility: constraintsById.get(record.evaluated.configuration.id),
    winner: record.evaluated.configuration.id === selection.winnerId,
    resultFile: record.resultFile,
    resultHash: record.resultHash,
  }));
  const summary = {
    createdAt: new Date().toISOString(),
    window: "validation",
    gitCommit: git(["rev-parse", "HEAD"]),
    rulePath,
    tuningRuleHash: ruleHash,
    snapshotManifestHash: firstResult.provenance.snapshotManifestHash,
    labelSetId: firstResult.provenance.labelSetId,
    labelSetHash: firstResult.provenance.labelSetHash,
    nearDuplicateThreshold: firstResult.provenance.nearDuplicateThreshold,
    population,
    referenceId: selection.referenceId,
    selection: {
      maxCoverage: selection.maxCoverage,
      bandIds: selection.bandIds,
      winnerId: selection.winnerId,
      chosen: {
        method: chosenOff.evaluated.configuration.method,
        parameters: chosenOff.parameters,
      },
    },
    configurations,
    exploration: {
      offResultFile: chosenOff.resultFile,
      offResultHash: chosenOff.resultHash,
      onResultFile: explorationOn.resultFile,
      onResultHash: explorationOn.resultHash,
      report: explorationReport(chosenOff.cells, explorationOn.cells),
    },
  };
  const outputBase = resolve(root, "evaluation/results", directoryName);
  await mkdir(dirname(outputBase), { recursive: true });
  await writeFile(`${outputBase}.json`, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  console.log(`Wrote diversity summary to ${outputBase}.json`);
  console.log("Chosen treatment", summary.selection.chosen);
}

async function main(): Promise<void> {
  const rulePath = parseArguments(process.argv.slice(2));
  requireCommittedRule(rulePath);
  const ruleText = await readFile(resolve(root, rulePath), "utf8");
  const parsedRule = JSON.parse(ruleText) as Record<string, unknown>;
  if (Array.isArray(parsedRule.diversityGrid)) {
    await runDiversitySearch(rulePath, ruleText, parseDiversityRule(ruleText));
    return;
  }
  const ruleHash = sha256(ruleText);
  const rule = parseTuningRule(ruleText);
  const personas = JSON.parse(
    await readFile(resolve(root, "evaluation/personas.json"), "utf8"),
  ) as { id: string }[];
  const singles = personas.map(({ id }) => id);
  const population = {
    singles,
    composites: compositePersonas(singles).map(({ id }) => id),
  };
  const timestamp = new Date().toISOString().replaceAll(":", "-").toLowerCase();
  const directoryName = `tuning-${timestamp}`;

  const stageOne: RunRecord[] = [];
  for (const configuration of stageOneGrid(rule)) {
    stageOne.push(
      await runConfiguration(configuration, directoryName, ruleHash, population, rule, rulePath),
    );
  }
  assertConsistentMissingCells(
    stageOne.map(({ evaluated, cells }) => ({ id: evaluated.configuration.id, cells })),
  );
  const baselineId = baselineConfigurationId(rule);
  const baseline: ConfigurationMetrics = requireDefined(
    stageOne.find(({ evaluated }) => evaluated.configuration.id === baselineId),
    "baseline run",
  ).evaluated.metrics;
  const shortlist = shortlistForStageTwo(
    stageOne.map(({ evaluated }) => evaluated),
    baseline,
    rule,
  );

  const stageTwo: RunRecord[] = [];
  let nextGridOrder = stageOne.length;
  for (const base of shortlist.shortlisted) {
    for (const configuration of stageTwoGrid(rule, base, nextGridOrder)) {
      stageTwo.push(
        await runConfiguration(configuration, directoryName, ruleHash, population, rule, rulePath),
      );
      nextGridOrder += 1;
    }
  }
  const all = [...stageOne, ...stageTwo];
  assertConsistentMissingCells(
    all.map(({ evaluated, cells }) => ({ id: evaluated.configuration.id, cells })),
  );
  const final = selectWinner(
    all.map(({ evaluated }) => evaluated),
    baseline,
    rule,
  );
  const stageOneEligibility = new Map(
    shortlist.rows.map((row) => [row.id, row.constraints.eligible]),
  );
  const rows = all.map((record) =>
    summaryRow(record, stageOneEligibility.get(record.evaluated.configuration.id) ?? null, final),
  );
  const winnerRow = rows.find((row) => row.winner);
  const baselineMetrics = baseline;
  const firstResult = JSON.parse(
    await readFile(resolve(root, requireDefined(all[0], "first run").resultFile), "utf8"),
  ) as ReplayResult;

  const summary = {
    createdAt: new Date().toISOString(),
    window: "validation",
    gitCommit: git(["rev-parse", "HEAD"]),
    rulePath,
    tuningRuleHash: ruleHash,
    snapshotManifestHash: firstResult.provenance.snapshotManifestHash,
    labelSetId: firstResult.provenance.labelSetId,
    labelSetHash: firstResult.provenance.labelSetHash,
    nearDuplicateThreshold: firstResult.provenance.nearDuplicateThreshold,
    population,
    baselineId,
    baseline: {
      objective: baselineMetrics.objective,
      balancedCoverage: baselineMetrics.balancedCoverage,
      enFiPrecision: baselineMetrics.enFi.value,
      fiEnPrecision: baselineMetrics.fiEn.value,
    },
    availability: {
      objectiveCells: baselineMetrics.objectiveAvailability,
      coverageCells: baselineMetrics.coverageAvailability,
      enFi: {
        omittedPersonaIds: baselineMetrics.enFi.omittedPersonaIds,
        notAssessable: baselineMetrics.enFi.value === null,
        cells: baselineMetrics.enFi.availability,
      },
      fiEn: {
        omittedPersonaIds: baselineMetrics.fiEn.omittedPersonaIds,
        notAssessable: baselineMetrics.fiEn.value === null,
        cells: baselineMetrics.fiEn.availability,
      },
    },
    stageOne: {
      maxCoverage: shortlist.maxCoverage,
      shortlisted: shortlist.shortlisted.map(({ id }) => id),
      skippedStageTwoReason: shortlist.skippedReason,
    },
    final: {
      maxCoverage: final.maxCoverage,
      bestObjective: final.bestObjective,
      bandIds: final.bandIds,
      winnerId: final.winnerId,
      decision: winnerRow
        ? "adopt winner as the production default"
        : "no configuration meets the constraints; retain the production default",
      chosen: winnerRow ? { method: winnerRow.method, parameters: winnerRow.parameters } : null,
    },
    configurations: rows,
  };

  const outputBase = resolve(root, "evaluation/results", directoryName);
  await mkdir(dirname(outputBase), { recursive: true });
  await Promise.all([
    writeFile(`${outputBase}.json`, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" }),
    writeFile(
      `${outputBase}.csv`,
      encodeCsv([
        [
          "id",
          "stage",
          "method",
          "parameters",
          "objective",
          "balanced_coverage",
          "en_fi_precision",
          "fi_en_precision",
          "stage_one_eligible",
          "final_eligible",
          "within_band",
          "winner",
          "result_hash",
        ],
        ...rows.map((row) => [
          row.id,
          String(row.stage),
          row.method,
          JSON.stringify(row.parameters),
          String(row.objective),
          String(row.balancedCoverage),
          row.enFiPrecision === null ? "" : String(row.enFiPrecision),
          row.fiEnPrecision === null ? "" : String(row.fiEnPrecision),
          row.stageOneEligible === null ? "" : String(row.stageOneEligible),
          String(row.finalConstraints.eligible),
          String(row.withinBand),
          String(row.winner),
          row.resultHash,
        ]),
      ]),
      { flag: "wx" },
    ),
  ]);
  console.log(`Wrote tuning summary to ${outputBase}.json and ${outputBase}.csv`);
  console.log(summary.final.decision, summary.final.chosen ?? "");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
