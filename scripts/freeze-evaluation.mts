import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVALUATION_FREEZE_SCHEMA_VERSION,
  type FrozenEvaluationParameters,
  frozenParametersHash,
} from "../lib/evaluation-freeze.ts";
import {
  type EvaluationLabelItem,
  type EvaluationPersona,
  parseLabelJsonLines,
  validateLabelSet,
} from "../lib/evaluation-labels.ts";
import {
  type EvaluationSnapshotManifest,
  parseJsonLines,
  requireFinalSnapshot,
  type SnapshotRow,
  sha256,
  validateSnapshotData,
} from "../lib/evaluation-snapshot.ts";
import { requireDefined } from "../lib/required.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotDirectory = resolve(root, "evaluation/snapshot");
const labelsDirectory = resolve(root, "evaluation/labels");
const resultsDirectory = resolve(root, "evaluation/results");
const freezePath = resolve(root, "evaluation/frozen-params.json");
const kValues = [0, 1, 3, 5, 10, 20];
const seeds = Array.from({ length: 10 }, (_, index) => index);

function parseArguments(args: string[]): string | undefined {
  let paramsPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = requireDefined(args[index], "CLI argument");
    if (argument === "--params" || argument.startsWith("--params=")) {
      paramsPath = argument === "--params" ? args[++index] : argument.slice("--params=".length);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return paramsPath;
}

async function findCompleteLabelSet(personas: EvaluationPersona[], items: EvaluationLabelItem[]) {
  const names = await readdir(labelsDirectory);
  const complete: Array<{
    path: string;
    labels: ReturnType<typeof parseLabelJsonLines>;
  }> = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
    if (name.endsWith(".provisional.jsonl")) continue;
    const path = resolve(labelsDirectory, name);
    const labels = parseLabelJsonLines(await readFile(path, "utf8"));
    try {
      validateLabelSet({ personas, items, labels });
      complete.push({ path, labels });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("incomplete") || error.message.includes("missing "))
      ) {
        continue;
      }
      throw error;
    }
  }
  if (complete.length !== 1) {
    throw new Error(`freezing requires exactly one complete label set; found ${complete.length}`);
  }
  const selected = requireDefined(complete[0], "complete label set");
  return {
    ...selected,
    labelSet: validateLabelSet({
      personas,
      items,
      labels: selected.labels,
    }),
  };
}

async function main(): Promise<void> {
  const paramsPath = parseArguments(process.argv.slice(2));
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.trim().length > 0) {
    throw new Error("freeze requires a clean working tree");
  }
  const commitHash = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const [manifestText, sourceText, itemText, meanText, personaText, configText] = await Promise.all(
    [
      readFile(resolve(snapshotDirectory, "manifest.json"), "utf8"),
      readFile(resolve(snapshotDirectory, "sources.jsonl"), "utf8"),
      readFile(resolve(snapshotDirectory, "items.jsonl"), "utf8"),
      readFile(resolve(snapshotDirectory, "means.jsonl"), "utf8"),
      readFile(resolve(root, "evaluation/personas.json"), "utf8"),
      readFile(resolve(root, "evaluation/config.json"), "utf8"),
    ],
  );
  const manifest = JSON.parse(manifestText) as EvaluationSnapshotManifest;
  requireFinalSnapshot(manifest);
  const sources = parseJsonLines<SnapshotRow>(sourceText, "sources.jsonl");
  const itemRows = parseJsonLines<SnapshotRow>(itemText, "items.jsonl");
  const means = parseJsonLines<SnapshotRow>(meanText, "means.jsonl");
  validateSnapshotData({ manifest, sources, items: itemRows, means });
  const items = itemRows.map((row): EvaluationLabelItem => {
    if (
      typeof row.id !== "string" ||
      typeof row.title !== "string" ||
      typeof row.summary !== "string" ||
      (row.language !== "fi" && row.language !== "en")
    ) {
      throw new Error("snapshot item is missing label fields");
    }
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      language: row.language,
    };
  });
  const personas = JSON.parse(personaText) as EvaluationPersona[];
  const { labelSet } = await findCompleteLabelSet(personas, items);
  const config = JSON.parse(configText) as { nearDuplicateThreshold?: number };
  if (
    typeof config.nearDuplicateThreshold !== "number" ||
    config.nearDuplicateThreshold < -1 ||
    config.nearDuplicateThreshold > 1
  ) {
    throw new Error("evaluation/config.json must define a valid nearDuplicateThreshold");
  }
  const parameterOverrides: Record<string, unknown> = {};
  if (paramsPath) {
    const path = isAbsolute(paramsPath) ? paramsPath : resolve(root, paramsPath);
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--params must contain a JSON object");
    }
    Object.assign(parameterOverrides, parsed);
  }
  const frozen: FrozenEvaluationParameters = {
    schemaVersion: EVALUATION_FREEZE_SCHEMA_VERSION,
    parameters: parameterOverrides,
    commitHash,
    snapshotManifestHash: sha256(manifestText),
    labelSetId: labelSet.id,
    labelSetHash: labelSet.hash,
    nearDuplicateThreshold: config.nearDuplicateThreshold,
    configHash: sha256(configText),
    seeds,
    kValues,
    createdAt: new Date().toISOString(),
  };
  await mkdir(resolve(root, "evaluation"), { recursive: true });
  await writeFile(freezePath, `${JSON.stringify(frozen, null, 2)}\n`, {
    flag: "wx",
  });
  await mkdir(resultsDirectory, { recursive: true });
  const experimentId = frozenParametersHash(frozen);
  console.log(`Froze test experiment ${experimentId} at commit ${commitHash}.`);
  console.log(`Freeze file is local-only: ${freezePath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
