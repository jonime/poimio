import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EvaluationPersona,
  parseLabelJsonLines,
  validateLabelSet,
} from "../lib/evaluation-labels.ts";
import {
  type EvaluationSnapshotManifest,
  parseJsonLines,
  type SnapshotRow,
  sha256,
  validateSnapshotData,
} from "../lib/evaluation-snapshot.ts";
import { requestInterestSummary } from "../lib/interest-summary.ts";
import { requireDefined } from "../lib/required.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultDirectory = resolve(root, "evaluation/interest-summary");
const samplePath = resolve(resultDirectory, "samples.json");
const resultPath = resolve(resultDirectory, "run.json");
const reviewPath = resolve(resultDirectory, "review.json");
const cases = [
  { id: "ai-software", personas: ["ai-software"] },
  { id: "cars-engineering", personas: ["cars-engineering"] },
  { id: "science-space", personas: ["science-space"] },
  { id: "finnish-sports", personas: ["finnish-sports"] },
  { id: "ai-software-finnish-sports", personas: ["ai-software", "finnish-sports"] },
  { id: "cars-engineering-science-space", personas: ["cars-engineering", "science-space"] },
] as const;

interface SampleCase {
  id: string;
  personas: string[];
  likedItemIds: string[];
  notInterestedItemIds: string[];
}

interface SampleFile {
  snapshotHash: string;
  labelsHash: string;
  cases: SampleCase[];
}

function ciRefused(): void {
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
    throw new Error("Interest summary checking is manual and must not run in CI.");
  }
}

async function validationInputs() {
  const snapshotDirectory = resolve(root, "evaluation/snapshot");
  const [manifestText, sourcesText, itemsText, meansText, personasText, labelsText] =
    await Promise.all([
      readFile(resolve(snapshotDirectory, "manifest.json"), "utf8"),
      readFile(resolve(snapshotDirectory, "sources.jsonl"), "utf8"),
      readFile(resolve(snapshotDirectory, "items.jsonl"), "utf8"),
      readFile(resolve(snapshotDirectory, "means.jsonl"), "utf8"),
      readFile(resolve(root, "evaluation/personas.json"), "utf8"),
      readFile(resolve(root, "evaluation/labels/qwen_qwen3.8-27b.jsonl"), "utf8"),
    ]);
  const manifest = JSON.parse(manifestText) as EvaluationSnapshotManifest;
  const sources = parseJsonLines<SnapshotRow>(sourcesText, "sources.jsonl");
  const allItems = parseJsonLines<SnapshotRow>(itemsText, "items.jsonl");
  const frozenItemIds = new Set(manifest.itemIds);
  const items = allItems.filter((item) => frozenItemIds.has(String(item.id)));
  const means = parseJsonLines<SnapshotRow>(meansText, "means.jsonl");
  validateSnapshotData({ manifest, sources, items, means });
  const personas = JSON.parse(personasText) as EvaluationPersona[];
  const labelItems = items.map((item) => {
    if (
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.summary !== "string" ||
      (item.language !== "fi" && item.language !== "en")
    ) {
      throw new Error("snapshot item is missing label fields");
    }
    return {
      id: item.id,
      title: item.title,
      summary: item.summary,
      language: item.language as "fi" | "en",
    };
  });
  const labels = validateLabelSet({
    personas,
    items: labelItems,
    labels: parseLabelJsonLines(labelsText),
  });
  return {
    manifest,
    items,
    personas,
    labels,
    snapshotHash: sha256(manifestText),
    labelsHash: labels.hash,
  };
}

function newestRelevant(
  itemIds: Set<string>,
  items: SnapshotRow[],
  labels: ReturnType<typeof validationInputs> extends Promise<infer T>
    ? T extends { labels: infer L }
      ? L
      : never
    : never,
  personaId: string,
): SnapshotRow[] {
  const relevant = new Set(
    labels.labels
      .filter((label) => label.personaId === personaId && label.relevant)
      .map((label) => label.itemId),
  );
  return items
    .filter(
      (item) =>
        typeof item.id === "string" &&
        typeof item.published_at === "string" &&
        itemIds.has(item.id) &&
        relevant.has(item.id),
    )
    .sort(
      (left, right) =>
        Date.parse(String(right.published_at)) - Date.parse(String(left.published_at)) ||
        String(left.id).localeCompare(String(right.id)),
    );
}

function titles(rows: SnapshotRow[]): string[] {
  return rows.map((row) => requireDefined(row.title, "sample title")).map(String);
}

async function prepareSamples() {
  await mkdir(resultDirectory, { recursive: true });
  const input = await validationInputs();
  const feedbackIds = new Set(input.manifest.windows.feedback.itemIds);
  const noneRelevant = input.items
    .filter((item) => {
      if (typeof item.id !== "string" || !feedbackIds.has(item.id)) return false;
      return !input.labels.labels.some((label) => label.itemId === item.id && label.relevant);
    })
    .sort(
      (left, right) =>
        Date.parse(String(right.published_at)) - Date.parse(String(left.published_at)) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(0, 20)
    .map((item) => String(item.id));
  const caseRows = cases.map((sampleCase): SampleCase => {
    const lists = sampleCase.personas.map((persona) =>
      newestRelevant(feedbackIds, input.items, input.labels, persona),
    );
    const liked: SnapshotRow[] = [];
    if (lists.length === 1) {
      liked.push(...requireDefined(lists[0], sampleCase.id).slice(0, 50));
    } else {
      const seen = new Set<string>();
      for (let index = 0; liked.length < 50; index++) {
        let changed = false;
        for (const list of lists) {
          const item = list[index];
          if (item && typeof item.id === "string" && !seen.has(item.id)) {
            seen.add(item.id);
            liked.push(item);
            changed = true;
            if (liked.length === 50) break;
          }
        }
        if (!changed) break;
      }
    }
    for (const persona of sampleCase.personas) {
      if (
        !liked.some((item) =>
          input.labels.labels.some(
            (label) => label.personaId === persona && label.itemId === item.id && label.relevant,
          ),
        )
      ) {
        throw new Error(`${sampleCase.id} does not represent ${persona}`);
      }
    }
    return {
      id: sampleCase.id,
      personas: [...sampleCase.personas],
      likedItemIds: liked.map((item) => String(item.id)),
      notInterestedItemIds: noneRelevant,
    };
  });
  const sample: SampleFile = {
    snapshotHash: input.snapshotHash,
    labelsHash: input.labelsHash,
    cases: caseRows,
  };
  await writeFile(samplePath, `${JSON.stringify(sample, null, 2)}\n`);
  console.log(`Prepared ${caseRows.length} committed-before-run sample cases at ${samplePath}.`);
}

function requireCommittedSample() {
  execFileSync("git", ["ls-files", "--error-unmatch", "evaluation/interest-summary/samples.json"], {
    cwd: root,
    stdio: "ignore",
  });
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--", "evaluation/interest-summary/samples.json"],
    { cwd: root, encoding: "utf8" },
  );
  if (dirty.trim())
    throw new Error("Commit the interest-summary sample before running the prompt.");
}

async function loadSample(input: Awaited<ReturnType<typeof validationInputs>>) {
  const sample = JSON.parse(await readFile(samplePath, "utf8")) as SampleFile;
  if (sample.snapshotHash !== input.snapshotHash || sample.labelsHash !== input.labelsHash) {
    throw new Error("Committed sample does not match the frozen snapshot and label set.");
  }
  return sample;
}

async function runOnce() {
  ciRefused();
  requireCommittedSample();
  let resultExists = true;
  try {
    await readFile(resultPath);
  } catch {
    resultExists = false;
  }
  if (resultExists) throw new Error("Interest summary has already been run; review that result.");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required.");
  const input = await validationInputs();
  const sample = await loadSample(input);
  const itemById = new Map(input.items.map((item) => [String(item.id), item]));
  const review = [];
  const result = [];
  for (const sampleCase of sample.cases) {
    const liked = sampleCase.likedItemIds.map((id) =>
      requireDefined(itemById.get(id), `sample item ${id}`),
    );
    const notInterested = sampleCase.notInterestedItemIds.map((id) =>
      requireDefined(itemById.get(id), `sample item ${id}`),
    );
    const output = await requestInterestSummary({
      apiKey,
      interests: {
        liked: titles(liked),
        not_interested: titles(notInterested),
        more: [],
        less: [],
      },
    });
    if (output.status !== "completed")
      throw new Error(`Case ${sampleCase.id} produced no summary.`);
    const publicRow = {
      id: sampleCase.id,
      personas: sampleCase.personas,
      summary: output.summary.summary,
      topics: output.summary.topics,
      correct: null,
    };
    result.push(publicRow);
    review.push({
      ...publicRow,
      likedTitles: titles(liked),
      notInterestedTitles: titles(notInterested),
    });
  }
  const provenance = {
    snapshotHash: sample.snapshotHash,
    labelsHash: sample.labelsHash,
    model: "gpt-6-luna",
  };
  await Promise.all([
    writeFile(resultPath, `${JSON.stringify({ provenance, cases: result }, null, 2)}\n`),
    writeFile(reviewPath, `${JSON.stringify({ provenance, cases: review }, null, 2)}\n`),
  ]);
  console.log(
    `Wrote ${result.length} summaries. Mark each correct field in review.json, then --score.`,
  );
}

async function scoreReview() {
  const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
    cases: Array<{ id: string; correct: boolean | null }>;
  };
  if (
    review.cases.length !== 6 ||
    review.cases.some((entry) => typeof entry.correct !== "boolean")
  ) {
    throw new Error("Every review case must be marked correct true or false.");
  }
  const correct = review.cases.filter((entry) => entry.correct).length;
  await writeFile(
    resultPath,
    `${JSON.stringify({ ...JSON.parse(await readFile(resultPath, "utf8")), correct, targetMet: correct >= 5 }, null, 2)}\n`,
  );
  if (correct < 5) {
    throw new Error(
      `Only ${correct} of 6 summaries were correct; stop and discuss. No tuning loop.`,
    );
  }
  console.log(`${correct} of 6 summaries were correct; target met.`);
}

const mode = process.argv.slice(2).find((argument) => argument !== "--");
if (mode === "--prepare") await prepareSamples();
else if (mode === "--score") await scoreReview();
else if (mode === undefined) await runOnce();
else throw new Error("Usage: pnpm eval:interest-summary [--prepare|--score]");
