import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCsv, parseCsv } from "../lib/early-ranking.ts";
import {
  createAgreementDesign,
  scoreAgreement,
  type AgreementPair,
} from "../lib/evaluation-agreement.ts";
import {
  parseLabelJsonLines,
  validateLabelSet,
  type EvaluationLabelItem,
  type EvaluationPersona,
} from "../lib/evaluation-labels.ts";
import {
  parseJsonLines,
  validateSnapshotData,
  type EvaluationSnapshotManifest,
  type SnapshotRow,
} from "../lib/evaluation-snapshot.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const personaPath = resolve(root, "evaluation/personas.json");
const sampleSeed = 6022026;

interface CliOptions {
  command: "export" | "score";
  set: "selection" | "reporting";
  labelsPath?: string;
  provisional: boolean;
}

function parseArguments(args: string[]): CliOptions {
  const command = args[0];
  if (command !== "export" && command !== "score") {
    throw new Error(
      "usage: pnpm eval:agreement export|score --set selection|reporting --labels <file>",
    );
  }
  let set: string | undefined;
  let labelsPath: string | undefined;
  let provisional = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--set" || argument.startsWith("--set=")) {
      set = argument === "--set" ? args[++index] : argument.slice(6);
    } else if (argument === "--labels" || argument.startsWith("--labels=")) {
      labelsPath =
        argument === "--labels"
          ? args[++index]
          : argument.slice("--labels=".length);
    } else if (argument === "--provisional") {
      provisional = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (set !== "selection" && set !== "reporting") {
    throw new Error("--set must be selection or reporting");
  }
  if (command === "score" && !labelsPath) {
    throw new Error("--labels <file> is required when scoring");
  }
  return { command, set, labelsPath, provisional };
}

function artifactDirectory(provisional: boolean): string {
  return resolve(
    root,
    "evaluation/agreement",
    provisional ? "provisional" : ".",
  );
}

async function loadInputs(labelsPath?: string, provisional = false) {
  const snapshotDirectory = resolve(
    root,
    "evaluation/snapshot",
    provisional ? "provisional" : ".",
  );
  const [
    manifestText,
    sourceText,
    itemText,
    meanText,
    personaText,
    labelsText,
  ] = await Promise.all([
    readFile(resolve(snapshotDirectory, "manifest.json"), "utf8"),
    readFile(resolve(snapshotDirectory, "sources.jsonl"), "utf8"),
    readFile(resolve(snapshotDirectory, "items.jsonl"), "utf8"),
    readFile(resolve(snapshotDirectory, "means.jsonl"), "utf8"),
    readFile(personaPath, "utf8"),
    labelsPath
      ? readFile(resolveLabelFile(labelsPath, provisional), "utf8")
      : Promise.resolve(null),
  ]);
  const manifest = JSON.parse(manifestText) as EvaluationSnapshotManifest;
  if (manifest.provisional !== provisional) {
    throw new Error("snapshot provisional state does not match --provisional");
  }
  const sources = parseJsonLines<SnapshotRow>(sourceText, "sources.jsonl");
  const snapshotItems = parseJsonLines<SnapshotRow>(itemText, "items.jsonl");
  const means = parseJsonLines<SnapshotRow>(meanText, "means.jsonl");
  validateSnapshotData({ manifest, sources, items: snapshotItems, means });
  const items = snapshotItems.map((row): EvaluationLabelItem => {
    if (
      typeof row.id !== "string" ||
      typeof row.title !== "string" ||
      typeof row.summary !== "string" ||
      (row.language !== "fi" && row.language !== "en")
    ) {
      throw new Error("snapshot item is missing agreement input fields");
    }
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      language: row.language,
    };
  });
  const personas = JSON.parse(personaText) as EvaluationPersona[];
  if (labelsText === null) {
    return { personas, items, labels: [], labelSet: null };
  }
  const labels = parseLabelJsonLines(labelsText);
  const labelSet = validateLabelSet({ personas, items, labels });
  if (labelSet.provisional !== provisional) {
    throw new Error("label set provisional state does not match the snapshot");
  }
  return { personas, items, labels: labelSet.labels, labelSet };
}

function resolveLabelFile(value: string, provisional: boolean): string {
  if (isAbsolute(value) || value.includes("/") || value.endsWith(".jsonl")) {
    return isAbsolute(value) ? value : resolve(root, value);
  }
  const modelSlug = value.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return resolve(
    root,
    "evaluation/labels",
    `${modelSlug}${provisional ? ".provisional" : ""}.jsonl`,
  );
}

async function findCompleteLabelFile(
  personas: EvaluationPersona[],
  items: EvaluationLabelItem[],
  provisional: boolean,
): Promise<string> {
  let names: string[];
  try {
    names = await readdir(resolve(root, "evaluation/labels"));
  } catch {
    throw new Error(
      "no evaluation/labels directory; run pnpm eval:label first",
    );
  }
  const completeFiles: string[] = [];
  for (const name of names.filter(
    (entry) =>
      entry.endsWith(".jsonl") &&
      entry.endsWith(".provisional.jsonl") === provisional,
  )) {
    const path = resolve(root, "evaluation/labels", name);
    const labels = parseLabelJsonLines(await readFile(path, "utf8"));
    try {
      validateLabelSet({ personas, items, labels });
      completeFiles.push(path);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("incomplete") ||
          error.message.includes("missing "))
      ) {
        continue;
      }
      throw error;
    }
  }
  if (completeFiles.length !== 1) {
    throw new Error(
      `selection export needs one complete label set; found ${completeFiles.length}; pass --labels when multiple sets exist`,
    );
  }
  return completeFiles[0]!;
}

interface ExportPair {
  pairId: string;
  personaId: string;
  itemId: string;
  inclusionProbability: number;
}

function csvRows(
  set: ExportPair[],
  personas: EvaluationPersona[],
  items: EvaluationLabelItem[],
): string[][] {
  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  const itemById = new Map(items.map((item) => [item.id, item]));
  return [
    [
      "pair_id",
      "persona_id",
      "persona_description",
      "item_id",
      "title",
      "summary",
      "language",
      "inclusion_probability",
      "relevant",
    ],
    ...set.map((pair) => {
      const persona = personaById.get(pair.personaId)!;
      const item = itemById.get(pair.itemId)!;
      return [
        pair.pairId,
        persona.id,
        persona.description,
        item.id,
        item.title,
        item.summary,
        item.language,
        String(pair.inclusionProbability),
        "",
      ];
    }),
  ];
}

async function exportSet(
  options: CliOptions,
  inputs: Awaited<ReturnType<typeof loadInputs>>,
): Promise<void> {
  const agreementDirectory = artifactDirectory(options.provisional);
  const designPath = resolve(agreementDirectory, "design.json");
  const samplesPath = resolve(agreementDirectory, "sample-pairs.json");
  const csvPath = resolve(agreementDirectory, `${options.set}.csv`);
  await mkdir(agreementDirectory, { recursive: true });
  let exportedPairs: ExportPair[];
  if (options.set === "selection") {
    if (!inputs.labelSet)
      throw new Error("selection export requires primary labels");
    const design = createAgreementDesign({
      personas: inputs.personas,
      items: inputs.items,
      labels: inputs.labels,
      seed: sampleSeed,
    });
    const publicDesign = {
      seed: design.seed,
      provisional: options.provisional,
      labelSetId: inputs.labelSet.id,
      labelSetHash: inputs.labelSet.hash,
      strata: design.strata.map((stratum) => ({
        personaId: stratum.personaId,
        language: stratum.language,
        modelRelevant: stratum.modelRelevant,
        populationSize: stratum.populationSize,
        selectionSampleSize: stratum.selectionSampleSize,
        reportingSampleSize: stratum.reportingSampleSize,
      })),
      sampleSizes: {
        selection: design.sets.selection.length,
        reporting: design.sets.reporting.length,
      },
    };
    const savedPairs = {
      selection: design.sets.selection.map(
        ({ pairId, personaId, itemId, inclusionProbability }) => ({
          pairId,
          personaId,
          itemId,
          inclusionProbability,
        }),
      ),
      reporting: design.sets.reporting.map(
        ({ pairId, personaId, itemId, inclusionProbability }) => ({
          pairId,
          personaId,
          itemId,
          inclusionProbability,
        }),
      ),
    };
    await Promise.all([
      writeFile(designPath, `${JSON.stringify(publicDesign, null, 2)}\n`, {
        flag: "wx",
      }),
      writeFile(samplesPath, `${JSON.stringify(savedPairs, null, 2)}\n`, {
        flag: "wx",
      }),
    ]);
    exportedPairs = savedPairs.selection;
  } else {
    await readFile(resolve(agreementDirectory, "selection.csv"), "utf8");
    const savedPairs = JSON.parse(await readFile(samplesPath, "utf8")) as {
      selection: ExportPair[];
      reporting: ExportPair[];
    };
    if (savedPairs.reporting.length !== inputs.personas.length * 15) {
      throw new Error("saved reporting sample has an invalid size");
    }
    exportedPairs = savedPairs.reporting;
  }
  const csv = encodeCsv(csvRows(exportedPairs, inputs.personas, inputs.items));
  await writeFile(csvPath, csv, { flag: "wx" });
  console.log(
    `Exported ${exportedPairs.length} blind ${options.set} pairs to evaluation/agreement/${options.set}.csv. The CSV contains no model labels.`,
  );
}

function parseHumanLabels(csv: string): Array<{
  personaId: string;
  itemId: string;
  language: "fi" | "en";
  inclusionProbability: number;
  manualRelevant: boolean;
}> {
  const [header, ...records] = parseCsv(csv);
  if (!header) throw new Error("agreement CSV is empty");
  const column = new Map(header.map((value, index) => [value, index]));
  for (const required of [
    "persona_id",
    "item_id",
    "language",
    "inclusion_probability",
    "relevant",
  ]) {
    if (!column.has(required))
      throw new Error(`agreement CSV is missing ${required}`);
  }
  return records.map((record, index) => {
    const get = (name: string) => record[column.get(name)!] ?? "";
    const relevant = get("relevant");
    const probability = Number(get("inclusion_probability"));
    const language = get("language");
    if (
      (relevant !== "0" && relevant !== "1") ||
      !Number.isFinite(probability) ||
      probability <= 0 ||
      probability > 1 ||
      (language !== "fi" && language !== "en")
    ) {
      throw new Error(`agreement CSV row ${index + 2} has invalid values`);
    }
    return {
      personaId: get("persona_id"),
      itemId: get("item_id"),
      language,
      inclusionProbability: probability,
      manualRelevant: relevant === "1",
    };
  });
}

async function scoreSet(
  options: CliOptions,
  inputs: Awaited<ReturnType<typeof loadInputs>>,
): Promise<void> {
  const agreementDirectory = artifactDirectory(options.provisional);
  const resultDirectory = resolve(agreementDirectory, "results");
  if (!inputs.labelSet)
    throw new Error("scoring requires a complete label set");
  const csvPath = resolve(agreementDirectory, `${options.set}.csv`);
  const designPath = resolve(agreementDirectory, "design.json");
  const csvPairs = parseHumanLabels(await readFile(csvPath, "utf8"));
  const design = JSON.parse(await readFile(designPath, "utf8")) as {
    labelSetHash: string;
    strata: Array<{
      personaId: string;
      language: "fi" | "en";
      modelRelevant: boolean;
      populationSize: number;
      selectionSampleSize: number;
      reportingSampleSize: number;
    }>;
  };
  const labelByPair = new Map(
    inputs.labels.map((label) => [
      `${label.personaId}\u0000${label.itemId}`,
      label,
    ]),
  );
  const seen = new Set<string>();
  const pairs: AgreementPair[] = csvPairs.map((pair) => {
    const key = `${pair.personaId}\u0000${pair.itemId}`;
    const label = labelByPair.get(key);
    if (!label)
      throw new Error(`label set is missing ${pair.personaId}/${pair.itemId}`);
    if (seen.has(key))
      throw new Error("agreement CSV contains duplicate pairs");
    seen.add(key);
    const item = inputs.items.find((candidate) => candidate.id === pair.itemId);
    if (!item || item.language !== pair.language) {
      throw new Error(
        `agreement CSV has an unknown or mismatched item ${pair.itemId}`,
      );
    }
    return {
      pairId: `${pair.personaId}:${pair.itemId}`,
      personaId: pair.personaId,
      itemId: pair.itemId,
      language: pair.language,
      modelRelevant: label.relevant,
      manualRelevant: pair.manualRelevant,
      stratumKey: "",
      stratumSize: 0,
      selectionSampleSize: 0,
      reportingSampleSize: 0,
      inclusionProbability: pair.inclusionProbability,
    };
  });
  const expectedSize = inputs.personas.length * 15;
  if (pairs.length !== expectedSize) {
    throw new Error(`agreement CSV must contain ${expectedSize} labeled pairs`);
  }
  for (const persona of inputs.personas) {
    const personaPairs = pairs.filter((pair) => pair.personaId === persona.id);
    if (
      personaPairs.length !== 15 ||
      personaPairs.filter((pair) => pair.language === "fi").length < 7 ||
      personaPairs.filter((pair) => pair.language === "en").length < 7
    ) {
      throw new Error(`agreement CSV is not balanced for ${persona.id}`);
    }
  }

  const scores = scoreAgreement(pairs);
  await mkdir(resultDirectory, { recursive: true });
  const labelSlug = inputs.labelSet.id.replace(/[^a-zA-Z0-9._-]/gu, "_");
  const resultPath = resolve(
    resultDirectory,
    `${options.set}-${labelSlug}.json`,
  );
  if (options.set === "reporting") {
    const names = await readdir(resultDirectory);
    const selectionScore = resolve(
      resultDirectory,
      `selection-${labelSlug}.json`,
    );
    try {
      await readFile(selectionScore, "utf8");
    } catch {
      throw new Error(
        "score the selection set for this label set before scoring reporting",
      );
    }
    if (
      names.some(
        (name) => name.startsWith("reporting-") && name.endsWith(".json"),
      )
    ) {
      throw new Error("reporting agreement has already been scored");
    }
  }
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        set: options.set,
        provisional: inputs.labelSet.provisional,
        labelSetId: inputs.labelSet.id,
        labelSetHash: inputs.labelSet.hash,
        model: inputs.labelSet.model,
        promptVersion: inputs.labelSet.promptVersion,
        scores,
        stratumCounts: design.strata,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  console.log(`Scored ${options.set} agreement; wrote ${resultPath}`);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  let inputs = await loadInputs(options.labelsPath, options.provisional);
  if (
    options.command === "export" &&
    options.set === "selection" &&
    !options.labelsPath
  ) {
    const labelsPath = await findCompleteLabelFile(
      inputs.personas,
      inputs.items,
      options.provisional,
    );
    inputs = await loadInputs(labelsPath, options.provisional);
  }
  if (options.command === "export") await exportSet(options, inputs);
  else await scoreSet(options, inputs);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
