import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_SUMMARY_INSTRUCTIONS,
  DESCRIPTION_SUMMARY_MODEL,
  SUMMARY_INSTRUCTIONS,
  summarizeArticleText,
} from "../lib/enrich/coordinator.ts";
import { fetchArticleTextForEvaluation } from "../lib/enrich/page.ts";
import {
  assertDescriptionStyleRunAllowed,
  classifyExtractionFailure,
  classifySummaryFailure,
  countDescriptionStyleFailures,
  createDescriptionStyleBlindReview,
  createDescriptionStyleSample,
  type DescriptionStyleBlindKeyEntry,
  type DescriptionStyleItem,
  type DescriptionStyleOutput,
  type DescriptionStyleRun,
  parseDescriptionStyleItems,
  parseNarrationPatterns,
  scoreDescriptionStyleReview,
  validateDescriptionStyleSample,
} from "../lib/evaluation-description-style.ts";
import { hashSnapshotRow, type SnapshotRow, sha256 } from "../lib/evaluation-snapshot.ts";
import { requireDefined } from "../lib/required.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "evaluation/description-style");
const snapshotDirectory = resolve(root, "evaluation/snapshot");
const resultDirectory = resolve(directory, "runs");
const summaryDirectory = resolve(directory, "summaries");

interface CliOptions {
  command: "sample" | "run" | "report";
  seed: number;
  runId: string | null;
}

function parseArguments(args: string[]): CliOptions {
  const command = args[0] === undefined || args[0] === "run" ? "run" : args[0];
  if (command !== "sample" && command !== "run" && command !== "report") {
    throw new Error(
      "usage: pnpm eval:description-style [sample --seed <integer>|run|report --run-id <id>]",
    );
  }
  let seed = 23024;
  let runId: string | null = null;
  for (let index = command === args[0] ? 1 : 0; index < args.length; index += 1) {
    const option = requireDefined(args[index], "CLI option");
    if (
      (option !== "--seed" || command !== "sample") &&
      (option !== "--run-id" || command !== "report")
    ) {
      throw new Error(`Unknown option for ${command}: ${option}`);
    }
    const value = requireDefined(args[++index], `value for ${option}`);
    if (option === "--seed") {
      if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("--seed must be a safe integer");
      }
      seed = Number(value);
    } else {
      if (!/^[A-Za-z0-9_.:-]+$/u.test(value))
        throw new Error("--run-id contains invalid characters");
      runId = value;
    }
  }
  if (command === "report" && runId === null) throw new Error("report requires --run-id <id>");
  return { command, seed, runId };
}

async function requireNewFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite ${relative(root, path)}`);
}

async function loadSnapshot() {
  const [manifestText, itemText] = await Promise.all([
    readFile(resolve(snapshotDirectory, "manifest.json"), "utf8"),
    readFile(resolve(snapshotDirectory, "items.jsonl"), "utf8"),
  ]);
  const manifest: unknown = JSON.parse(manifestText);
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !("itemRowHashes" in manifest) ||
    manifest.itemRowHashes === null ||
    typeof manifest.itemRowHashes !== "object"
  ) {
    throw new Error("Frozen snapshot manifest is invalid");
  }
  const items = parseDescriptionStyleItems(itemText);
  for (const item of items) {
    const expected = (manifest.itemRowHashes as Record<string, unknown>)[item.id];
    if (expected !== hashSnapshotRow(item as SnapshotRow)) {
      throw new Error(`Frozen snapshot hash mismatch for ${item.id}`);
    }
  }
  return { items, manifestHash: sha256(manifestText) };
}

function requireSampleItems(
  sampleItems: ReadonlyArray<{ itemId: string; sourceId: string; language: string }>,
  items: DescriptionStyleItem[],
): DescriptionStyleItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return sampleItems.map((sampleItem) => {
    const item = requireDefined(byId.get(sampleItem.itemId), `snapshot item ${sampleItem.itemId}`);
    if (item.source_id !== sampleItem.sourceId || item.language !== sampleItem.language) {
      throw new Error(`sample metadata mismatch for ${sampleItem.itemId}`);
    }
    return item;
  });
}

async function sampleCommand(seed: number): Promise<void> {
  const { items, manifestHash } = await loadSnapshot();
  const sample = createDescriptionStyleSample({ items, seed, snapshotManifestHash: manifestHash });
  const path = resolve(directory, "sample.json");
  await requireNewFile(path);
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(sample, null, 2)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify(
      {
        path: relative(root, path),
        seed,
        poolCounts: sample.poolCounts,
        selected: sample.items.length,
      },
      null,
      2,
    ),
  );
}

async function priorDigests(sampleHash: string): Promise<Map<string, Set<string>>> {
  let names: string[];
  try {
    names = await readdir(resultDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
    throw error;
  }
  const digests = new Map<string, Set<string>>();
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const value: unknown = JSON.parse(await readFile(resolve(resultDirectory, name), "utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      !("sampleHash" in value) ||
      value.sampleHash !== sampleHash ||
      !("items" in value) ||
      !Array.isArray(value.items)
    ) {
      continue;
    }
    for (const item of value.items) {
      if (
        item !== null &&
        typeof item === "object" &&
        "itemId" in item &&
        typeof item.itemId === "string" &&
        "inputTextDigest" in item &&
        typeof item.inputTextDigest === "string"
      ) {
        const values = digests.get(item.itemId) ?? new Set<string>();
        values.add(item.inputTextDigest);
        digests.set(item.itemId, values);
      }
    }
  }
  return digests;
}

async function summarize(
  articleText: string,
  apiKey: string,
  instructions: string,
): Promise<DescriptionStyleOutput> {
  try {
    const text = await summarizeArticleText(articleText, apiKey, { instructions });
    return { status: "complete", text, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: classifySummaryFailure(error),
      text: null,
      error: message.slice(0, 500),
    };
  }
}

async function runCommand(): Promise<void> {
  const apiKey = assertDescriptionStyleRunAllowed(process.env);
  const [{ items: snapshotItems, manifestHash }, sampleText, patternText] = await Promise.all([
    loadSnapshot(),
    readFile(resolve(directory, "sample.json"), "utf8"),
    readFile(resolve(directory, "narration-patterns.json"), "utf8"),
  ]);
  const sample = validateDescriptionStyleSample(JSON.parse(sampleText), manifestHash);
  parseNarrationPatterns(JSON.parse(patternText));
  const selectedItems = requireSampleItems(sample.items, snapshotItems);
  const sampleHash = sha256(sampleText);
  const previous = await priorDigests(sampleHash);
  const timestamp = new Date().toISOString();
  const runId = `${timestamp.replace(/[-:.]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const runPath = resolve(resultDirectory, `${runId}.json`);
  const reviewPath = resolve(directory, "review.csv");
  const keyPath = resolve(directory, "key.json");
  await Promise.all([requireNewFile(runPath), requireNewFile(reviewPath), requireNewFile(keyPath)]);

  const runItems: DescriptionStyleRun["items"] = [];
  for (const item of selectedItems) {
    const extractionTimestamp = new Date().toISOString();
    let extraction: Awaited<ReturnType<typeof fetchArticleTextForEvaluation>>;
    try {
      extraction = await fetchArticleTextForEvaluation(item.url, item.title, item.language);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      extraction = {
        status: "error",
        error: `article extraction failed: ${message}`.slice(0, 500),
      };
    }
    if (extraction.status === "error") {
      runItems.push({
        itemId: item.id,
        sourceId: item.source_id,
        language: item.language,
        title: item.title,
        url: item.url,
        finalUrl: null,
        extractionTimestamp,
        inputTextDigest: null,
        changedInputDigest: false,
        extractionStatus: classifyExtractionFailure(extraction.error),
        extractionError: extraction.error,
        current: { status: "not_attempted", text: null, error: null },
        candidate: { status: "not_attempted", text: null, error: null },
        pairComplete: false,
      });
      console.log(`${item.id}: ${extraction.error}`);
      continue;
    }
    const inputTextDigest = sha256(extraction.articleText);
    const [current, candidate] = await Promise.all([
      summarize(extraction.articleText, apiKey, SUMMARY_INSTRUCTIONS),
      summarize(extraction.articleText, apiKey, CANDIDATE_SUMMARY_INSTRUCTIONS),
    ]);
    const changedInputDigest = [...(previous.get(item.id) ?? [])].some(
      (digest) => digest !== inputTextDigest,
    );
    runItems.push({
      itemId: item.id,
      sourceId: item.source_id,
      language: item.language,
      title: item.title,
      url: item.url,
      finalUrl: extraction.finalUrl,
      extractionTimestamp,
      inputTextDigest,
      changedInputDigest,
      extractionStatus: "complete",
      extractionError: null,
      current,
      candidate,
      pairComplete: current.status === "complete" && candidate.status === "complete",
    });
    console.log(`${item.id}: ${current.status}/${candidate.status}`);
  }

  const run: DescriptionStyleRun = {
    schemaVersion: 1,
    runId,
    timestamp,
    sampleHash,
    model: DESCRIPTION_SUMMARY_MODEL,
    currentInstructionHash: sha256(SUMMARY_INSTRUCTIONS),
    candidateInstructionHash: sha256(CANDIDATE_SUMMARY_INSTRUCTIONS),
    items: runItems,
  };
  const review = createDescriptionStyleBlindReview(run, sample.seed);
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await Promise.all([
    writeFile(reviewPath, review.csv, { flag: "wx", mode: 0o600 }),
    writeFile(keyPath, `${JSON.stringify(review.key, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  console.log(
    JSON.stringify(
      {
        runId,
        counts: countDescriptionStyleFailures(runItems),
        review: relative(root, reviewPath),
        key: relative(root, keyPath),
      },
      null,
      2,
    ),
  );
}

function parseRun(value: unknown): DescriptionStyleRun {
  if (
    value === null ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("runId" in value) ||
    typeof value.runId !== "string" ||
    !("items" in value) ||
    !Array.isArray(value.items)
  ) {
    throw new Error("Description-style result is invalid");
  }
  return value as DescriptionStyleRun;
}

async function reportCommand(runId: string): Promise<void> {
  const [runText, csv, keyText, patternText] = await Promise.all([
    readFile(resolve(resultDirectory, `${runId}.json`), "utf8"),
    readFile(resolve(directory, "review.csv"), "utf8"),
    readFile(resolve(directory, "key.json"), "utf8"),
    readFile(resolve(directory, "narration-patterns.json"), "utf8"),
  ]);
  const run = parseRun(JSON.parse(runText));
  if (run.runId !== runId) throw new Error("Description-style result run ID mismatch");
  const key = JSON.parse(keyText) as DescriptionStyleBlindKeyEntry[];
  const patterns = parseNarrationPatterns(JSON.parse(patternText));
  const score = scoreDescriptionStyleReview({ csv, key, run, patterns });
  const decisions = [score.overall.decision, score.fi.decision, score.en.decision];
  const decision = decisions.includes("inconclusive")
    ? "inconclusive"
    : decisions.every((value) => value === "meets")
      ? "meets"
      : "misses";
  const summary = {
    schemaVersion: 1,
    runId: run.runId,
    timestamp: run.timestamp,
    sampleHash: run.sampleHash,
    model: run.model,
    currentInstructionHash: run.currentInstructionHash,
    candidateInstructionHash: run.candidateInstructionHash,
    counts: countDescriptionStyleFailures(run.items),
    items: run.items.map((item) => ({
      itemId: item.itemId,
      sourceId: item.sourceId,
      language: item.language,
      finalUrl: item.finalUrl,
      extractionTimestamp: item.extractionTimestamp,
      inputTextDigest: item.inputTextDigest,
      changedInputDigest: item.changedInputDigest,
      extractionStatus: item.extractionStatus,
      currentStatus: item.current.status,
      candidateStatus: item.candidate.status,
      pairComplete: item.pairComplete,
    })),
    score,
    decision,
    activation: "not-approved",
  };
  await mkdir(summaryDirectory, { recursive: true });
  const path = resolve(summaryDirectory, `${runId}.json`);
  await requireNewFile(path);
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ key, summary, path: relative(root, path) }, null, 2));
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "sample") await sampleCommand(options.seed);
  else if (options.command === "run") await runCommand();
  else await reportCommand(requireDefined(options.runId, "report run ID"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Description-style comparison failed");
  process.exitCode = 1;
});
