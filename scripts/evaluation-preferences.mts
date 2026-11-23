import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { EMBEDDING_MODEL_VERSION } from "../lib/embeddings.ts";
import {
  type EvaluationLabelItem,
  type EvaluationPersona,
  parseLabelJsonLines,
  validateLabelSet,
} from "../lib/evaluation-labels.ts";
import {
  assessLessCase,
  embedPreferenceDescriptions,
  exclusiveCount,
  type HandwrittenPreference,
  type LessCaseAssessment,
  type LessSeedResult,
  lessTargetMet,
  morePersonaImproved,
  moreTargetMet,
  type OrderedLessCase,
  orderedLessCases,
  parsePreferenceEmbeddings,
  parsePreferences,
} from "../lib/evaluation-preferences.ts";
import {
  candidateScopes,
  compositeFeedbackPrefix,
  createCompositeFeedbackSequence,
  type MemberRelevance,
  nearDuplicateIds,
  precisionAt10,
  type ReplayFeedback,
  type ReplayItem,
} from "../lib/evaluation-replay.ts";
import {
  type EvaluationSnapshotManifest,
  parseJsonLines,
  requireLocalSupabaseUrl,
  type SnapshotRow,
  sha256,
  validateSnapshotData,
} from "../lib/evaluation-snapshot.ts";
import {
  interpretPreferenceRequest,
  PREFERENCE_MODEL,
  PREFERENCE_TUNING_INSTRUCTIONS,
  parsePreferenceRequestFile,
} from "../lib/preference-tuning.ts";
import { requireDefined } from "../lib/required.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preferencesPath = resolve(root, "evaluation/preferences.json");
const embeddingsPath = resolve(root, "evaluation/preference-embeddings.json");
const resultPath = resolve(root, "evaluation/results/preferences-021-check1.json");
const parseResultPath = resolve(root, "evaluation/results/preferences-021-check2.json");
const requestPath = resolve(root, "evaluation/preference-requests.json");
const seeds = Array.from({ length: 10 }, (_, index) => index);
const treatmentParams = {
  lambda: 0.5,
  recency_weight: 0,
  dislike_threshold: 0.4,
  article_half_life_hours: 24,
  video_half_life_hours: 168,
  centered: true,
  diversity: 0,
  exploration: false,
  blend_alpha: 0.5,
};

interface ReplayContentItem extends ReplayItem {
  title: string;
  summary: string;
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
): Promise<string> {
  const directory = resolve(root, "evaluation/labels");
  const complete: string[] = [];
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(".jsonl"))) {
    if (name.endsWith(".provisional.jsonl")) continue;
    const path = resolve(directory, name);
    try {
      validateLabelSet({
        personas,
        items,
        labels: parseLabelJsonLines(await readFile(path, "utf8")),
      });
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
    throw new Error(
      `preference check needs exactly one complete label set; found ${complete.length}`,
    );
  }
  return requireDefined(complete[0], "complete label file");
}

async function loadValidationInputs() {
  const snapshotDirectory = resolve(root, "evaluation/snapshot");
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
  const sources = parseJsonLines<SnapshotRow>(sourceText, "sources.jsonl");
  const itemRows = parseJsonLines<SnapshotRow>(itemText, "items.jsonl");
  const means = parseJsonLines<SnapshotRow>(meanText, "means.jsonl");
  validateSnapshotData({ manifest, sources, items: itemRows, means });
  const items = itemRows.map((row): ReplayContentItem => {
    if (
      typeof row.id !== "string" ||
      typeof row.source_id !== "string" ||
      typeof row.title !== "string" ||
      typeof row.summary !== "string" ||
      (row.language !== "fi" && row.language !== "en")
    ) {
      throw new Error("snapshot item is missing preference-check fields");
    }
    return {
      id: row.id,
      language: row.language,
      sourceId: row.source_id,
      categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
      embedding: parseVector(row.embedding, `item ${row.id}`),
      title: row.title,
      summary: row.summary,
    };
  });
  const personas = JSON.parse(personaText) as EvaluationPersona[];
  const labelItems = items.map(({ id, title, summary, language }) => ({
    id,
    title,
    summary,
    language,
  }));
  const labelFile = await findLabelFile(personas, labelItems);
  const labelSet = validateLabelSet({
    personas,
    items: labelItems,
    labels: parseLabelJsonLines(await readFile(labelFile, "utf8")),
  });
  const model = EMBEDDING_MODEL_VERSION;
  const meanByLanguage = {
    fi: means.find((row) => row.embedding_model === model && row.language === "fi"),
    en: means.find((row) => row.embedding_model === model && row.language === "en"),
  };
  if (!meanByLanguage.fi || !meanByLanguage.en) {
    throw new Error("snapshot is missing a language mean for the active embedding model");
  }
  const config = JSON.parse(configText) as { nearDuplicateThreshold?: number };
  if (
    typeof config.nearDuplicateThreshold !== "number" ||
    config.nearDuplicateThreshold < -1 ||
    config.nearDuplicateThreshold > 1
  ) {
    throw new Error("evaluation/config.json must define nearDuplicateThreshold between -1 and 1");
  }
  const asOf = manifest.windows.validation.lastPublishedAt;
  if (!asOf) throw new Error("validation window is empty");
  return {
    manifest,
    manifestHash: sha256(manifestText),
    items,
    personas,
    labelSet,
    meanByLanguage: {
      fi: parseVector(meanByLanguage.fi.mean, "fi mean"),
      en: parseVector(meanByLanguage.en.mean, "en mean"),
    },
    threshold: config.nearDuplicateThreshold,
    asOf,
  };
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

async function rank(input: {
  client: SupabaseClient;
  candidateIds: string[];
  feedback: ReplayFeedback;
  asOf: string;
  seed: number;
  moreIds?: string[];
  lessIds?: string[];
}): Promise<string[]> {
  const { data, error } = await input.client.rpc("rank_items", {
    p_candidate_ids: input.candidateIds,
    p_liked_ids: input.feedback.likes,
    p_disliked_ids: input.feedback.dislikes,
    p_as_of: input.asOf,
    p_method: "blend",
    p_params: treatmentParams,
    p_seed: input.seed,
    p_limit: 10,
    ...(input.moreIds === undefined ? {} : { p_more_preference_ids: input.moreIds }),
    ...(input.lessIds === undefined ? {} : { p_less_preference_ids: input.lessIds }),
  });
  if (error) throw new Error(`rank_items failed: ${error.message}`);
  return ((data ?? []) as Array<{ item_id: string }>).map((row) => row.item_id);
}

function headlineCandidates(input: {
  candidateWindow: ReplayItem[];
  feedback: ReplayFeedback;
  itemById: Map<string, ReplayItem>;
  meanByLanguage: Record<"fi" | "en", number[]>;
  threshold: number;
}): ReplayItem[] {
  const ratedIds = new Set([...input.feedback.likes, ...input.feedback.dislikes]);
  const signalItems = [...ratedIds].flatMap((id) => {
    const item = input.itemById.get(id);
    return item ? [item] : [];
  });
  const duplicates = nearDuplicateIds({
    candidates: input.candidateWindow.filter((item) => !ratedIds.has(item.id)),
    feedbackItems: signalItems,
    meanByLanguage: input.meanByLanguage,
    threshold: input.threshold,
  });
  return candidateScopes(input.candidateWindow, ratedIds, duplicates).headline;
}

async function embedPreferences(preferences: HandwrittenPreference[]): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to embed preferences");
  const texts = preferences.flatMap((preference) => [
    preference.description_fi,
    preference.description_en,
  ]);
  const vectors = await embedPreferenceDescriptions({ texts, apiKey });
  const file = {
    model: EMBEDDING_MODEL_VERSION,
    preferences: preferences.map((preference, index) => ({
      personaId: preference.personaId,
      embedding_fi: requireDefined(vectors[index * 2], `${preference.personaId} Finnish embedding`),
      embedding_en: requireDefined(
        vectors[index * 2 + 1],
        `${preference.personaId} English embedding`,
      ),
    })),
  };
  await writeFile(embeddingsPath, `${JSON.stringify(file)}\n`);
  console.log(`Wrote ${file.preferences.length} cached preference embeddings.`);
}

async function parsePreferenceChecks(): Promise<void> {
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--", "evaluation/preference-requests.json"],
    { cwd: root, encoding: "utf8" },
  );
  if (status.trim() !== "") {
    throw new Error(
      "Commit evaluation/preference-requests.json before the first preference parse run.",
    );
  }
  let resultExists = true;
  try {
    await access(parseResultPath);
  } catch {
    resultExists = false;
  }
  if (resultExists) {
    throw new Error("Preference parse result already exists; do not run the check twice.");
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to parse preference requests");
  const requestText = await readFile(requestPath, "utf8");
  const requests = parsePreferenceRequestFile(JSON.parse(requestText));
  const outputs = [];
  for (const request of requests) {
    const interpreted = await interpretPreferenceRequest({ text: request.text, apiKey });
    outputs.push({
      id: request.id,
      language: request.language,
      kind: request.kind,
      intent: request.intent,
      status: interpreted.status,
      preferences: interpreted.preferences,
    });
    console.error(`${request.id}: ${interpreted.status} ${interpreted.preferences.length}`);
  }
  const result = {
    provenance: {
      createdAt: new Date().toISOString(),
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      requestsHash: sha256(requestText),
      model: PREFERENCE_MODEL,
      instructionsHash: sha256(PREFERENCE_TUNING_INSTRUCTIONS),
    },
    requests: outputs,
  };
  await writeFile(parseResultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote ${outputs.length} preference parse outputs to ${parseResultPath}`);
  console.log("Mark each output before counting the 10 of 12 target. Do not tune the prompt yet.");
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--parse") {
    await parsePreferenceChecks();
    return;
  }
  if (mode !== "--embed" && mode !== "--rank") {
    throw new Error("Usage: pnpm eval:preferences --embed | --rank | --parse");
  }
  const personaText = await readFile(resolve(root, "evaluation/personas.json"), "utf8");
  const personaIds = (JSON.parse(personaText) as EvaluationPersona[]).map((persona) => persona.id);
  const preferenceText = await readFile(preferencesPath, "utf8");
  const preferences = parsePreferences(JSON.parse(preferenceText), personaIds);
  if (mode === "--embed") {
    await embedPreferences(preferences);
    return;
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const projectUrl = requireLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const embeddingText = await readFile(embeddingsPath, "utf8");
  const embeddings = parsePreferenceEmbeddings(JSON.parse(embeddingText), personaIds);
  const snapshot = await loadValidationInputs();
  const client = createClient(projectUrl.toString(), process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const created = await client.auth.admin.createUser({
    email: `preferences-check-${randomUUID()}@poimio.invalid`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(
      `Creating the preference check user failed: ${created.error?.message ?? "missing user"}`,
    );
  }
  const userId = created.data.user.id;
  let runError: unknown;
  try {
    const embeddingByPersona = new Map(
      embeddings.preferences.map((preference) => [preference.personaId, preference]),
    );
    const rows = preferences.flatMap((preference) => {
      const embedding = requireDefined(
        embeddingByPersona.get(preference.personaId),
        `embedding for ${preference.personaId}`,
      );
      return (["more", "less"] as const).map((direction) => ({
        user_id: userId,
        label: preference.label,
        direction,
        description_fi: preference.description_fi,
        description_en: preference.description_en,
        embedding_fi: vectorLiteral(embedding.embedding_fi),
        embedding_en: vectorLiteral(embedding.embedding_en),
        embedding_model: EMBEDDING_MODEL_VERSION,
      }));
    });
    const inserted = await client
      .from("feed_preferences")
      .insert(rows)
      .select("id,label,direction");
    if (inserted.error || !inserted.data) {
      throw new Error(`Inserting preferences failed: ${inserted.error?.message ?? "rows missing"}`);
    }
    const preferenceId = (label: string, direction: "more" | "less") =>
      requireDefined(
        inserted.data.find((row) => row.label === label && row.direction === direction)?.id,
        `${direction} preference ${label}`,
      );
    const labelByPersona = new Map(
      snapshot.personas.map((persona) => [
        persona.id,
        new Set(
          snapshot.labelSet.labels
            .filter((label) => label.personaId === persona.id && label.relevant)
            .map((label) => label.itemId),
        ),
      ]),
    );
    const validationIds = new Set(snapshot.manifest.windows.validation.itemIds);
    const feedbackIds = new Set(snapshot.manifest.windows.feedback.itemIds);
    const candidateWindow = snapshot.items.filter((item) => validationIds.has(item.id));
    const feedbackItems = snapshot.items.filter((item) => feedbackIds.has(item.id));
    const itemById = new Map(snapshot.items.map((item) => [item.id, item]));
    const emptyFeedback = { likes: [], dislikes: [] };
    const coldCandidates = headlineCandidates({
      candidateWindow,
      feedback: emptyFeedback,
      itemById,
      meanByLanguage: snapshot.meanByLanguage,
      threshold: snapshot.threshold,
    });
    const coldIds = coldCandidates.map((item) => item.id);
    const more: Array<{
      personaId: string;
      coldPrecisionAt10: number | null;
      morePrecisionAt10: number | null;
      improved: boolean;
      coldTop10ItemIds: string[];
      moreTop10ItemIds: string[];
    }> = [];
    for (const preference of preferences) {
      const relevantIds = requireDefined(
        labelByPersona.get(preference.personaId),
        preference.personaId,
      );
      const coldRank = await rank({
        client,
        candidateIds: coldIds,
        feedback: emptyFeedback,
        asOf: snapshot.asOf,
        seed: 0,
      });
      const moreRank = await rank({
        client,
        candidateIds: coldIds,
        feedback: emptyFeedback,
        asOf: snapshot.asOf,
        seed: 0,
        moreIds: [preferenceId(preference.label, "more")],
      });
      const coldPrecision = precisionAt10(coldRank, coldIds, relevantIds);
      const morePrecision = precisionAt10(moreRank, coldIds, relevantIds);
      more.push({
        personaId: preference.personaId,
        coldPrecisionAt10: coldPrecision,
        morePrecisionAt10: morePrecision,
        improved: morePersonaImproved(coldPrecision, morePrecision),
        coldTop10ItemIds: coldRank,
        moreTop10ItemIds: moreRank,
      });
      console.error(
        `${preference.personaId}: cold ${coldPrecision ?? "missing"} -> more ${morePrecision ?? "missing"}`,
      );
    }
    const less: Array<OrderedLessCase & LessCaseAssessment & { seeds: LessSeedResult[] }> = [];
    for (const lessCase of orderedLessCases(snapshot.personas.map((persona) => persona.id))) {
      const first = requireDefined(labelByPersona.get(lessCase.members[0]), lessCase.members[0]);
      const second = requireDefined(labelByPersona.get(lessCase.members[1]), lessCase.members[1]);
      const pair: MemberRelevance = [first, second];
      const relevantIds = new Set([...first, ...second]);
      const bSet = requireDefined(labelByPersona.get(lessCase.bPersonaId), lessCase.bPersonaId);
      const aSet = requireDefined(labelByPersona.get(lessCase.aPersonaId), lessCase.aPersonaId);
      const preference = requireDefined(
        preferences.find((entry) => entry.personaId === lessCase.bPersonaId),
        `preference for ${lessCase.bPersonaId}`,
      );
      const seedResults = [];
      for (const seed of seeds) {
        const feedback = compositeFeedbackPrefix(
          createCompositeFeedbackSequence({
            items: feedbackItems,
            relevance: pair,
            startMember: seed % 2 === 0 ? 0 : 1,
            seed,
            compositeId: lessCase.compositeId,
          }),
          10,
        );
        if (!feedback) {
          seedResults.push({
            seed,
            missing: true,
            baselineBExclusiveCount: null,
            treatmentBExclusiveCount: null,
            baselineAExclusiveCount: null,
            treatmentAExclusiveCount: null,
            baselineRelevantCount: null,
            treatmentRelevantCount: null,
          });
          continue;
        }
        const candidates = headlineCandidates({
          candidateWindow,
          feedback,
          itemById,
          meanByLanguage: snapshot.meanByLanguage,
          threshold: snapshot.threshold,
        });
        const candidateIds = candidates.map((item) => item.id);
        if (!candidateIds.some((id) => relevantIds.has(id))) {
          seedResults.push({
            seed,
            missing: true,
            baselineBExclusiveCount: null,
            treatmentBExclusiveCount: null,
            baselineAExclusiveCount: null,
            treatmentAExclusiveCount: null,
            baselineRelevantCount: null,
            treatmentRelevantCount: null,
          });
          continue;
        }
        const baselineRank = await rank({
          client,
          candidateIds,
          feedback,
          asOf: snapshot.asOf,
          seed,
        });
        const treatmentRank = await rank({
          client,
          candidateIds,
          feedback,
          asOf: snapshot.asOf,
          seed,
          lessIds: [preferenceId(preference.label, "less")],
        });
        seedResults.push({
          seed,
          missing: false,
          baselineBExclusiveCount: exclusiveCount(baselineRank, bSet, aSet),
          treatmentBExclusiveCount: exclusiveCount(treatmentRank, bSet, aSet),
          baselineAExclusiveCount: exclusiveCount(baselineRank, aSet, bSet),
          treatmentAExclusiveCount: exclusiveCount(treatmentRank, aSet, bSet),
          baselineRelevantCount: baselineRank.slice(0, 10).filter((id) => relevantIds.has(id))
            .length,
          treatmentRelevantCount: treatmentRank.slice(0, 10).filter((id) => relevantIds.has(id))
            .length,
        });
      }
      const assessment = assessLessCase(seedResults);
      less.push({ ...lessCase, ...assessment, seeds: seedResults });
      console.error(
        `${lessCase.compositeId} less ${lessCase.bPersonaId}: ${assessment.reason ?? "lower"} ` +
          `(${assessment.baselineBExclusiveShare ?? "n/a"} -> ${assessment.treatmentBExclusiveShare ?? "n/a"})`,
      );
    }
    const moreMetCount = more.filter((entry) => entry.improved).length;
    const lessMetCount = less.filter((entry) => entry.met).length;
    const result = {
      provenance: {
        createdAt: new Date().toISOString(),
        window: "validation",
        gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        snapshotManifestHash: snapshot.manifestHash,
        labelSetId: snapshot.labelSet.id,
        labelSetHash: snapshot.labelSet.hash,
        preferencesHash: sha256(preferenceText),
        preferenceEmbeddingsHash: sha256(embeddingText),
        seeds,
        treatment: { method: "blend", parameters: treatmentParams },
      },
      more,
      moreImprovedCount: moreMetCount,
      moreTargetMet: moreTargetMet(moreMetCount, more.length),
      less,
      lessMetCount,
      lessTargetMet: lessTargetMet(lessMetCount, less.length),
    };
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      `More improved ${moreMetCount}/4 (target 3). Less lowered B-exclusive share in ${lessMetCount}/12 (target 10).`,
    );
    console.log(`Wrote ${resultPath}`);
    if (!result.moreTargetMet || !result.lessTargetMet) {
      throw new Error("Preference ranking check missed a target; stop and discuss, do not tune.");
    }
  } catch (error) {
    runError = error;
  } finally {
    const deleted = await client.auth.admin.deleteUser(userId);
    if (deleted.error) {
      const message = `Deleting the preference check user failed: ${deleted.error.message}`;
      if (runError === undefined) runError = new Error(message);
      else console.error(message);
    }
  }
  if (runError) throw runError;
}

await main();
