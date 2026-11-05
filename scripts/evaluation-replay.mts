import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { encodeCsv } from "../lib/early-ranking.ts";
import { parseFrozenParameters, validateTestRun } from "../lib/evaluation-freeze.ts";
import {
  type EvaluationLabelItem,
  type EvaluationPersona,
  parseLabelJsonLines,
  validateLabelSet,
} from "../lib/evaluation-labels.ts";
import {
  candidateScopes,
  createFeedbackSequence,
  feedbackPrefix,
  jaccard,
  nearDuplicateIds,
  pairedDifferenceStatistics,
  precisionAt10,
  type ReplayItem,
  seedStatistics,
  top10Diversity,
} from "../lib/evaluation-replay.ts";
import {
  type EvaluationSnapshotManifest,
  parseJsonLines,
  requireFinalSnapshot,
  requireLocalSupabaseUrl,
  type SnapshotRow,
  sha256,
  validateSnapshotData,
} from "../lib/evaluation-snapshot.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const labelsDirectory = resolve(root, "evaluation/labels");
const methods = [
  { method: "nearest_liked", name: "nearest_liked", params: {} },
  {
    method: "nearest_liked",
    name: "nearest_liked_raw",
    params: { centered: false },
  },
  { method: "average_vector", name: "average_vector", params: {} },
  { method: "newest_first", name: "newest_first", params: {} },
  { method: "random", name: "random", params: {} },
] as const;
const seeds = Array.from({ length: 10 }, (_, index) => index);
const kValues = [0, 1, 3, 5, 10, 20];

interface ReplayContentItem extends ReplayItem {
  title: string;
  summary: string;
  publishedAt: string;
  url: string;
}

interface ReplayCell {
  window: "validation" | "test";
  runType: "standard" | "crosslingual";
  direction: "en-fi" | "fi-en" | null;
  scope: "headline" | "duplicate-inclusive";
  personaId: string;
  seed: number;
  k: number;
  method: string;
  candidateCount: number;
  relevantCandidateCount: number;
  status: "complete" | "missing";
  missingReason: string | null;
  precisionAt10: number | null;
  distinctSources: number | null;
  distinctCategories: number | null;
  top10ItemIds: string[];
}

interface ReplayOptions {
  window: "validation" | "test";
  provisional: boolean;
  labelsPath?: string;
  paramsPath?: string;
  newExperimentReason?: string;
}

function parseArguments(args: string[]): ReplayOptions {
  let window: string | undefined;
  let paramsPath: string | undefined;
  let labelsPath: string | undefined;
  let newExperimentReason: string | undefined;
  let provisional = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--window" || argument.startsWith("--window=")) {
      window = argument === "--window" ? args[++index] : argument.slice(9);
    } else if (argument === "--params" || argument.startsWith("--params=")) {
      paramsPath = argument === "--params" ? args[++index] : argument.slice("--params=".length);
    } else if (argument === "--labels" || argument.startsWith("--labels=")) {
      labelsPath = argument === "--labels" ? args[++index] : argument.slice("--labels=".length);
    } else if (argument === "--new-experiment" || argument.startsWith("--new-experiment=")) {
      newExperimentReason =
        argument === "--new-experiment"
          ? args[++index]
          : argument.slice("--new-experiment=".length);
    } else if (argument === "--provisional") {
      provisional = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (window !== "validation" && window !== "test") {
    throw new Error("--window must be validation or test");
  }
  if (newExperimentReason !== undefined && newExperimentReason.trim().length === 0) {
    throw new Error("--new-experiment requires a non-empty reason");
  }
  if (window === "validation" && newExperimentReason) {
    throw new Error("--new-experiment is only valid for --window test");
  }
  if (window === "test" && provisional) {
    throw new Error("test replay refuses provisional snapshots");
  }
  return { window, paramsPath, labelsPath, newExperimentReason, provisional };
}

function parseVector(value: unknown, label: string): number[] {
  const vector = Array.isArray(value)
    ? value.map(Number)
    : typeof value === "string"
      ? value.slice(1, -1).split(",").map(Number)
      : [];
  if (vector.length !== 512 || vector.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`${label} has an invalid 512-dimensional vector`);
  }
  return vector;
}

async function findLabelFile(
  personas: EvaluationPersona[],
  items: EvaluationLabelItem[],
  provisional: boolean,
  labelsPath?: string,
): Promise<string> {
  if (labelsPath) {
    return isAbsolute(labelsPath) ? labelsPath : resolve(root, labelsPath);
  }
  const names = await readdir(labelsDirectory);
  const complete: string[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
    if (name.endsWith(".provisional.jsonl") !== provisional) continue;
    const path = resolve(labelsDirectory, name);
    const labels = parseLabelJsonLines(await readFile(path, "utf8"));
    try {
      validateLabelSet({ personas, items, labels });
      complete.push(path);
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
    throw new Error(`replay needs exactly one complete label set; found ${complete.length}`);
  }
  return complete[0]!;
}

async function loadSnapshot(provisional: boolean, testWindow: boolean, labelsPath?: string) {
  const snapshotDirectory = resolve(root, "evaluation/snapshot", provisional ? "provisional" : ".");
  const [manifestText, sourceText, itemText, meanText, personaText] = await Promise.all([
    readFile(resolve(snapshotDirectory, "manifest.json"), "utf8"),
    readFile(resolve(snapshotDirectory, "sources.jsonl"), "utf8"),
    readFile(resolve(snapshotDirectory, "items.jsonl"), "utf8"),
    readFile(resolve(snapshotDirectory, "means.jsonl"), "utf8"),
    readFile(resolve(root, "evaluation/personas.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as EvaluationSnapshotManifest;
  if (testWindow) requireFinalSnapshot(manifest);
  if (manifest.provisional !== provisional) {
    throw new Error("snapshot provisional state does not match --provisional");
  }
  const sourceRows = parseJsonLines<SnapshotRow>(sourceText, "sources.jsonl");
  const itemRows = parseJsonLines<SnapshotRow>(itemText, "items.jsonl");
  const meanRows = parseJsonLines<SnapshotRow>(meanText, "means.jsonl");
  validateSnapshotData({
    manifest,
    sources: sourceRows,
    items: itemRows,
    means: meanRows,
  });
  const items = itemRows.map((row): ReplayContentItem => {
    if (
      typeof row.id !== "string" ||
      typeof row.source_id !== "string" ||
      typeof row.title !== "string" ||
      typeof row.summary !== "string" ||
      typeof row.published_at !== "string" ||
      typeof row.url !== "string" ||
      !Array.isArray(row.categories) ||
      (row.language !== "fi" && row.language !== "en")
    ) {
      throw new Error("snapshot item is missing replay input fields");
    }
    return {
      id: row.id,
      language: row.language,
      sourceId: row.source_id,
      categories: row.categories.map(String),
      embedding: parseVector(row.embedding, `item ${row.id}`),
      title: row.title,
      summary: row.summary,
      publishedAt: row.published_at,
      url: row.url,
    };
  });
  const meanRowsByLanguage = new Map(
    meanRows.map((row) => [
      `${String(row.embedding_model)}:${String(row.language)}`,
      parseVector(row.mean, `mean ${String(row.embedding_model)}:${String(row.language)}`),
    ]),
  );
  const models = new Set(itemRows.map((row) => String(row.embedding_model)));
  if (models.size !== 1) throw new Error("replay snapshot must use one embedding model");
  const model = [...models][0]!;
  const meanByLanguage = {
    fi: meanRowsByLanguage.get(`${model}:fi`),
    en: meanRowsByLanguage.get(`${model}:en`),
  };
  if (!meanByLanguage.fi || !meanByLanguage.en) {
    throw new Error("replay snapshot is missing a language mean");
  }
  const personas = JSON.parse(personaText) as EvaluationPersona[];
  const labelFile = await findLabelFile(
    personas,
    items.map(({ id, title, summary, language }) => ({
      id,
      title,
      summary,
      language,
    })),
    provisional,
    labelsPath,
  );
  const labelRows = parseLabelJsonLines(await readFile(labelFile, "utf8"));
  const labelSet = validateLabelSet({
    personas,
    items: items.map(({ id, title, summary, language }) => ({
      id,
      title,
      summary,
      language,
    })),
    labels: labelRows,
  });
  if (labelSet.provisional !== provisional) {
    throw new Error("label set provisional state does not match the snapshot");
  }
  return {
    manifest,
    manifestHash: sha256(manifestText),
    sourceRows,
    items,
    meanByLanguage: meanByLanguage as Record<"fi" | "en", number[]>,
    personas,
    labelSet,
  };
}

function windowItems(
  snapshot: Awaited<ReturnType<typeof loadSnapshot>>,
  window: "validation" | "test",
): ReplayContentItem[] {
  const ids = new Set(snapshot.manifest.windows[window].itemIds);
  return snapshot.items.filter((item) => ids.has(item.id));
}

async function parameterOverrides(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) return {};
  const resolvedPath = resolve(root, path);
  const text = await readFile(resolvedPath, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--params must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function pAsOf(
  snapshot: Awaited<ReturnType<typeof loadSnapshot>>,
  window: "validation" | "test",
): string {
  const boundary = snapshot.manifest.windows[window].lastPublishedAt;
  if (!boundary) throw new Error(`${window} window is empty`);
  return boundary;
}

async function runRanking(input: {
  client: SupabaseClient;
  candidateIds: string[];
  likes: string[];
  dislikes: string[];
  asOf: string;
  method: (typeof methods)[number];
  params: Record<string, unknown>;
  seed: number;
}): Promise<string[]> {
  const { data, error } = await input.client.rpc("rank_items", {
    p_candidate_ids: input.candidateIds,
    p_liked_ids: input.likes,
    p_disliked_ids: input.dislikes,
    p_as_of: input.asOf,
    p_method: input.method.method,
    p_params: { ...input.params, ...input.method.params },
    p_seed: input.seed,
    p_limit: 10,
  });
  if (error) throw new Error(`rank_items ${input.method.name} failed: ${error.message}`);
  return ((data ?? []) as Array<{ item_id: string }>).map((row) => row.item_id);
}

function missingCell(
  input: Omit<
    ReplayCell,
    | "status"
    | "missingReason"
    | "precisionAt10"
    | "distinctSources"
    | "distinctCategories"
    | "top10ItemIds"
  >,
  reason: string,
): ReplayCell {
  return {
    ...input,
    status: "missing",
    missingReason: reason,
    precisionAt10: null,
    distinctSources: null,
    distinctCategories: null,
    top10ItemIds: [],
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const resultsDirectory = resolve(
    root,
    "evaluation/results",
    options.provisional ? "provisional" : ".",
  );
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const projectUrl = requireLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const client = createClient(projectUrl.toString(), process.env.SUPABASE_SERVICE_ROLE_KEY);
  const snapshot = await loadSnapshot(
    options.provisional,
    options.window === "test",
    options.labelsPath,
  );
  const configPath = resolve(
    root,
    "evaluation",
    options.provisional ? "config.provisional.json" : "config.json",
  );
  const configText = await readFile(configPath, "utf8");
  const config = JSON.parse(configText) as {
    nearDuplicateThreshold?: number;
    provisional?: boolean;
    snapshotManifestHash?: string;
  };
  if (
    options.provisional &&
    (config.provisional !== true || config.snapshotManifestHash !== snapshot.manifestHash)
  ) {
    throw new Error("provisional config does not match the provisional snapshot");
  }
  if (!options.provisional && config.provisional === true) {
    throw new Error("final replay cannot use a provisional near-duplicate config");
  }
  let threshold = config.nearDuplicateThreshold;
  if (typeof threshold !== "number" || threshold < -1 || threshold > 1) {
    throw new Error("evaluation/config.json must define nearDuplicateThreshold between -1 and 1");
  }
  let params: Record<string, unknown>;
  let seedsToRun = seeds;
  let kValuesToRun = kValues;
  let experimentId: string | null = null;
  let newExperimentReason: string | null = null;
  await mkdir(resultsDirectory, { recursive: true });
  if (options.window === "test") {
    const frozen = parseFrozenParameters(
      await readFile(resolve(root, "evaluation/frozen-params.json"), "utf8"),
    );
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    });
    const existingTestResults = (await readdir(resultsDirectory)).filter((name) =>
      name.startsWith("test-"),
    );
    const guard = validateTestRun(frozen, {
      currentCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      workingTreeClean: status.trim().length === 0,
      snapshotManifestHash: snapshot.manifestHash,
      labelSetId: snapshot.labelSet.id,
      labelSetHash: snapshot.labelSet.hash,
      configHash: sha256(configText),
      paramsProvided: options.paramsPath !== undefined,
      existingTestResults,
      newExperimentReason: options.newExperimentReason,
    });
    threshold = frozen.nearDuplicateThreshold;
    params = frozen.parameters;
    seedsToRun = frozen.seeds;
    kValuesToRun = frozen.kValues;
    experimentId = guard.experimentId;
    newExperimentReason = guard.newExperimentReason;
  } else {
    params = await parameterOverrides(options.paramsPath);
  }
  const candidateWindow = windowItems(snapshot, options.window);
  const feedbackWindow = snapshot.manifest.windows.feedback.itemIds;
  const feedbackItems = snapshot.items.filter((item) => feedbackWindow.includes(item.id));
  const candidateById = new Map(candidateWindow.map((item) => [item.id, item]));
  const itemById = new Map(snapshot.items.map((item) => [item.id, item]));
  const labelsByPersona = new Map<string, Map<string, boolean>>();
  for (const persona of snapshot.personas) {
    labelsByPersona.set(
      persona.id,
      new Map(
        snapshot.labelSet.labels
          .filter((label) => label.personaId === persona.id)
          .map((label) => [label.itemId, label.relevant]),
      ),
    );
  }
  const cells: ReplayCell[] = [];
  const top10ByPersona = new Map<string, string[]>();

  for (const persona of snapshot.personas) {
    const relevance = labelsByPersona.get(persona.id)!;
    const relevantFeedbackIds = feedbackItems
      .filter((item) => relevance.get(item.id) === true)
      .map((item) => item.id);
    const standardSequenceItems: ReplayItem[] = feedbackItems;
    for (const seed of seedsToRun) {
      const standardSequence = createFeedbackSequence({
        items: standardSequenceItems,
        relevantItemIds: relevantFeedbackIds,
        seed,
        personaId: persona.id,
      });
      for (const k of kValuesToRun) {
        const feedback = feedbackPrefix(standardSequence, k);
        for (const method of methods) {
          for (const scope of ["headline", "duplicate-inclusive"] as const) {
            const base = {
              window: options.window,
              runType: "standard" as const,
              direction: null,
              scope,
              personaId: persona.id,
              seed,
              k,
              method: method.name,
              candidateCount: 0,
              relevantCandidateCount: 0,
            };
            if (!feedback) {
              cells.push(missingCell(base, "insufficient feedback-window labels"));
              continue;
            }
            const ratedIds = new Set([...feedback.likes, ...feedback.dislikes]);
            const baseCandidates = candidateWindow.filter((item) => !ratedIds.has(item.id));
            const signalItems = [...feedback.likes, ...feedback.dislikes]
              .map((id) => itemById.get(id))
              .filter((item): item is ReplayContentItem => item !== undefined);
            const duplicates = nearDuplicateIds({
              candidates: baseCandidates,
              feedbackItems: signalItems,
              meanByLanguage: snapshot.meanByLanguage,
              threshold,
            });
            const pools = candidateScopes(candidateWindow, ratedIds, duplicates);
            const candidates = scope === "headline" ? pools.headline : pools.duplicateInclusive;
            const relevantIds = new Set(
              candidates.filter((item) => relevance.get(item.id) === true).map((item) => item.id),
            );
            const filled = {
              ...base,
              candidateCount: candidates.length,
              relevantCandidateCount: relevantIds.size,
            };
            if (relevantIds.size === 0) {
              cells.push(missingCell(filled, "candidate pool has no relevant item"));
              continue;
            }
            const candidateIds = candidates.map((item) => item.id);
            const rankedIds = await runRanking({
              client,
              candidateIds,
              likes: feedback.likes,
              dislikes: feedback.dislikes,
              asOf: pAsOf(snapshot, options.window),
              method,
              params,
              seed,
            });
            const diversity = top10Diversity(rankedIds, candidateById);
            cells.push({
              ...filled,
              status: "complete",
              missingReason: null,
              precisionAt10: precisionAt10(rankedIds, candidateIds, relevantIds),
              distinctSources: diversity.distinctSources,
              distinctCategories: diversity.distinctCategories,
              top10ItemIds: rankedIds,
            });
            if (k === 10 && scope === "headline") {
              top10ByPersona.set(`${method.name}:${seed}:${persona.id}`, rankedIds);
            }
          }
        }
      }
    }

    for (const direction of [
      {
        name: "en-fi" as const,
        feedbackLanguage: "en" as const,
        targetLanguage: "fi" as const,
      },
      {
        name: "fi-en" as const,
        feedbackLanguage: "fi" as const,
        targetLanguage: "en" as const,
      },
    ]) {
      const targetCandidates = candidateWindow.filter(
        (item) => item.language === direction.targetLanguage,
      );
      const languageFeedback = feedbackItems.filter(
        (item) => item.language === direction.feedbackLanguage,
      );
      const relevantLanguageIds = languageFeedback
        .filter((item) => relevance.get(item.id) === true)
        .map((item) => item.id);
      for (const seed of seedsToRun) {
        const sequence = createFeedbackSequence({
          items: languageFeedback,
          relevantItemIds: relevantLanguageIds,
          seed,
          personaId: persona.id,
          language: direction.feedbackLanguage,
        });
        for (const k of kValuesToRun) {
          const feedback = feedbackPrefix(sequence, k);
          for (const method of methods) {
            for (const scope of ["headline", "duplicate-inclusive"] as const) {
              const base = {
                window: options.window,
                runType: "crosslingual" as const,
                direction: direction.name,
                scope,
                personaId: persona.id,
                seed,
                k,
                method: method.name,
                candidateCount: 0,
                relevantCandidateCount: 0,
              };
              if (!feedback) {
                cells.push(missingCell(base, "insufficient same-language feedback"));
                continue;
              }
              const rated = new Set([...feedback.likes, ...feedback.dislikes]);
              const baseCandidates = targetCandidates.filter((item) => !rated.has(item.id));
              const signalItems = [...feedback.likes, ...feedback.dislikes]
                .map((id) => itemById.get(id))
                .filter((item): item is ReplayContentItem => item !== undefined);
              const duplicates = nearDuplicateIds({
                candidates: baseCandidates,
                feedbackItems: signalItems,
                meanByLanguage: snapshot.meanByLanguage,
                threshold,
              });
              const pools = candidateScopes(targetCandidates, rated, duplicates);
              const candidates = scope === "headline" ? pools.headline : pools.duplicateInclusive;
              const relevantIds = new Set(
                candidates.filter((item) => relevance.get(item.id) === true).map((item) => item.id),
              );
              const filled = {
                ...base,
                candidateCount: candidates.length,
                relevantCandidateCount: relevantIds.size,
              };
              if (relevantIds.size === 0) {
                cells.push(
                  missingCell(filled, "target-language candidate pool has no relevant item"),
                );
                continue;
              }
              const candidateIds = candidates.map((item) => item.id);
              const rankedIds = await runRanking({
                client,
                candidateIds,
                likes: feedback.likes,
                dislikes: feedback.dislikes,
                asOf: pAsOf(snapshot, options.window),
                method,
                params,
                seed,
              });
              const diversity = top10Diversity(rankedIds, candidateById);
              cells.push({
                ...filled,
                status: "complete",
                missingReason: null,
                precisionAt10: precisionAt10(rankedIds, candidateIds, relevantIds),
                distinctSources: diversity.distinctSources,
                distinctCategories: diversity.distinctCategories,
                top10ItemIds: rankedIds,
              });
            }
          }
        }
      }
    }
  }

  const groupBy = (cell: ReplayCell) =>
    [cell.runType, cell.direction, cell.scope, cell.personaId, cell.k, cell.method].join("|");
  const groups = new Map<string, ReplayCell[]>();
  for (const cell of cells.filter((entry) => entry.status === "complete")) {
    const group = groups.get(groupBy(cell)) ?? [];
    group.push(cell);
    groups.set(groupBy(cell), group);
  }
  const summary = [...groups].map(([key, rows]) => {
    const values = rows.map((row) => row.precisionAt10!);
    const stats = seedStatistics(values)!;
    const avgRows = rows;
    const [runType, direction, scope, personaId, kString, method] = key.split("|");
    const averageKey = [runType, direction, scope, personaId, kString, "average_vector"].join("|");
    const paired = pairedDifferenceStatistics(
      new Map(rows.map((row) => [row.seed, row.precisionAt10!])),
      new Map((groups.get(averageKey) ?? avgRows).map((row) => [row.seed, row.precisionAt10!])),
    );
    return {
      runType,
      direction,
      scope,
      personaId,
      k: Number(kString),
      method,
      precisionAt10: stats,
      pairedDifferenceToAverageVector: paired,
      completeSeeds: rows.length,
    };
  });
  const overlap = [];
  for (const method of methods) {
    for (const seed of seedsToRun) {
      for (let left = 0; left < snapshot.personas.length; left += 1) {
        for (let right = left + 1; right < snapshot.personas.length; right += 1) {
          const leftPersona = snapshot.personas[left]!.id;
          const rightPersona = snapshot.personas[right]!.id;
          const leftIds = top10ByPersona.get(`${method.name}:${seed}:${leftPersona}`);
          const rightIds = top10ByPersona.get(`${method.name}:${seed}:${rightPersona}`);
          if (leftIds && rightIds) {
            overlap.push({
              method: method.name,
              seed,
              personaA: leftPersona,
              personaB: rightPersona,
              jaccard: jaccard(leftIds, rightIds),
            });
          }
        }
      }
    }
  }
  const provenance = {
    createdAt: new Date().toISOString(),
    provisional: snapshot.manifest.provisional,
    window: options.window,
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    snapshotManifestHash: snapshot.manifestHash,
    labelSetId: snapshot.labelSet.id,
    labelSetHash: snapshot.labelSet.hash,
    nearDuplicateThreshold: threshold,
    configHash: sha256(configText),
    seeds: seedsToRun,
    kValues: kValuesToRun,
    parameters: params,
    experimentId,
    newExperimentReason,
  };
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const resultName =
    options.window === "test"
      ? `test-${experimentId}`
      : `${options.provisional ? "provisional-" : ""}validation-${timestamp}`;
  const jsonPath = resolve(resultsDirectory, `${resultName}.json`);
  const csvPath = resolve(resultsDirectory, `${resultName}.csv`);
  await mkdir(resultsDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      jsonPath,
      `${JSON.stringify({ provenance, cells, summary, top10PersonaOverlap: overlap }, null, 2)}\n`,
      { flag: "wx" },
    ),
    writeFile(
      csvPath,
      encodeCsv([
        [
          "run_type",
          "direction",
          "scope",
          "persona_id",
          "seed",
          "k",
          "method",
          "candidate_count",
          "relevant_candidate_count",
          "status",
          "missing_reason",
          "precision_at_10",
          "distinct_sources",
          "distinct_categories",
          "top10_item_ids",
        ],
        ...cells.map((cell) => [
          cell.runType,
          cell.direction ?? "",
          cell.scope,
          cell.personaId,
          String(cell.seed),
          String(cell.k),
          cell.method,
          String(cell.candidateCount),
          String(cell.relevantCandidateCount),
          cell.status,
          cell.missingReason ?? "",
          cell.precisionAt10 === null ? "" : String(cell.precisionAt10),
          cell.distinctSources === null ? "" : String(cell.distinctSources),
          cell.distinctCategories === null ? "" : String(cell.distinctCategories),
          cell.top10ItemIds.join(" "),
        ]),
      ]),
      { flag: "wx" },
    ),
  ]);
  console.log(`Wrote ${cells.length} replay cells to ${jsonPath} and ${csvPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
