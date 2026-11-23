import { Buffer } from "node:buffer";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_MODEL_VERSION } from "./embeddings.ts";
import { compositePersonas } from "./evaluation-replay.ts";
import { requireDefined } from "./required.ts";

export const PREFERENCE_EMBEDDING_TIMEOUT_MS = 10_000;
export const PREFERENCE_EMBEDDING_MAX_BODY_BYTES = 1_000_000;
export const PREFERENCE_EMBEDDING_MAX_INPUTS = 10;
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const oneSentence = /^[^.!?]+[.]$/u;

export interface HandwrittenPreference {
  personaId: string;
  label: string;
  description_fi: string;
  description_en: string;
}

export interface PreferenceEmbedding {
  personaId: string;
  embedding_fi: number[];
  embedding_en: number[];
}

export interface PreferenceEmbeddingFile {
  model: string;
  preferences: PreferenceEmbedding[];
}

export interface LessSeedResult {
  seed: number;
  missing: boolean;
  baselineBExclusiveCount: number | null;
  treatmentBExclusiveCount: number | null;
  baselineAExclusiveCount: number | null;
  treatmentAExclusiveCount: number | null;
  baselineRelevantCount: number | null;
  treatmentRelevantCount: number | null;
}

export interface LessCaseAssessment {
  met: boolean;
  reason: "missing cell" | "zero baseline share" | "not lower" | null;
  baselineBExclusiveShare: number | null;
  treatmentBExclusiveShare: number | null;
  baselineAExclusiveShare: number | null;
  treatmentAExclusiveShare: number | null;
  baselinePrecisionAt10: number | null;
  treatmentPrecisionAt10: number | null;
}

export interface OrderedLessCase {
  compositeId: string;
  members: [string, string];
  bIndex: 0 | 1;
  bPersonaId: string;
  aPersonaId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function requireSentence(value: unknown, label: string): string {
  const text = requireText(value, label, 200);
  if (!oneSentence.test(text)) {
    throw new Error(`${label} must be one sentence ending in a period`);
  }
  return text;
}

function requireVector(value: unknown, label: string): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== EMBEDDING_DIMENSIONS ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw new Error(`${label} must be a finite ${EMBEDDING_DIMENSIONS}-dimensional vector`);
  }
  return value;
}

export function parsePreferences(
  value: unknown,
  personaIds: readonly string[],
): HandwrittenPreference[] {
  if (!Array.isArray(value)) throw new Error("preferences must be an array");
  const preferences = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`preference ${index + 1} must be an object`);
    return {
      personaId: requireText(entry.personaId, `preference ${index + 1} personaId`, 80),
      label: requireText(entry.label, `preference ${index + 1} label`, 40),
      description_fi: requireSentence(
        entry.description_fi,
        `preference ${index + 1} description_fi`,
      ),
      description_en: requireSentence(
        entry.description_en,
        `preference ${index + 1} description_en`,
      ),
    };
  });
  const ids = new Set(preferences.map((preference) => preference.personaId));
  if (ids.size !== preferences.length || preferences.length !== personaIds.length) {
    throw new Error("preferences must contain exactly one row per persona");
  }
  for (const personaId of personaIds) {
    if (!ids.has(personaId)) throw new Error(`preferences are missing ${personaId}`);
  }
  return preferences;
}

export function parsePreferenceEmbeddings(
  value: unknown,
  personaIds: readonly string[],
): PreferenceEmbeddingFile {
  if (!isRecord(value) || !Array.isArray(value.preferences)) {
    throw new Error("preference embeddings must be an object with a preferences array");
  }
  if (value.model !== EMBEDDING_MODEL_VERSION) {
    throw new Error(`preference embeddings must use ${EMBEDDING_MODEL_VERSION}`);
  }
  const preferences = value.preferences.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`embedding ${index + 1} must be an object`);
    return {
      personaId: requireText(entry.personaId, `embedding ${index + 1} personaId`, 80),
      embedding_fi: requireVector(entry.embedding_fi, `embedding ${index + 1} embedding_fi`),
      embedding_en: requireVector(entry.embedding_en, `embedding ${index + 1} embedding_en`),
    };
  });
  const ids = new Set(preferences.map((preference) => preference.personaId));
  if (ids.size !== preferences.length || preferences.length !== personaIds.length) {
    throw new Error("preference embeddings must contain exactly one row per persona");
  }
  for (const personaId of personaIds) {
    if (!ids.has(personaId)) throw new Error(`preference embeddings are missing ${personaId}`);
  }
  return { model: EMBEDDING_MODEL_VERSION, preferences };
}

export function orderedLessCases(personaIds: readonly string[]): OrderedLessCase[] {
  return compositePersonas([...personaIds]).flatMap((composite) =>
    ([0, 1] as const).map((bIndex) => ({
      compositeId: composite.id,
      members: composite.members,
      bIndex,
      bPersonaId: composite.members[bIndex],
      aPersonaId: composite.members[bIndex === 0 ? 1 : 0],
    })),
  );
}

export function exclusiveCount(
  rankedIds: readonly string[],
  own: ReadonlySet<string>,
  other: ReadonlySet<string>,
): number {
  return rankedIds.slice(0, 10).filter((id) => own.has(id) && !other.has(id)).length;
}

export function morePersonaImproved(
  coldPrecision: number | null,
  morePrecision: number | null,
): boolean {
  return coldPrecision !== null && morePrecision !== null && morePrecision > coldPrecision;
}

export function moreTargetMet(improvedCount: number, personaCount: number): boolean {
  if (personaCount !== 4) throw new Error("the more check covers the four evaluation personas");
  return improvedCount >= 3;
}

function meanCount(values: Array<number | null>, seedCount: number): number | null {
  if (values.some((value) => value === null)) return null;
  const total = values.reduce<number>((sum, value) => sum + requireDefined(value, "seed count"), 0);
  return total / (seedCount * 10);
}

export function assessLessCase(seeds: readonly LessSeedResult[]): LessCaseAssessment {
  const missing = seeds.some((seed) => seed.missing);
  const baselineBExclusiveShare = meanCount(
    seeds.map((seed) => seed.baselineBExclusiveCount),
    seeds.length,
  );
  const treatmentBExclusiveShare = meanCount(
    seeds.map((seed) => seed.treatmentBExclusiveCount),
    seeds.length,
  );
  const baselineAExclusiveShare = meanCount(
    seeds.map((seed) => seed.baselineAExclusiveCount),
    seeds.length,
  );
  const treatmentAExclusiveShare = meanCount(
    seeds.map((seed) => seed.treatmentAExclusiveCount),
    seeds.length,
  );
  const baselinePrecisionAt10 = meanCount(
    seeds.map((seed) => seed.baselineRelevantCount),
    seeds.length,
  );
  const treatmentPrecisionAt10 = meanCount(
    seeds.map((seed) => seed.treatmentRelevantCount),
    seeds.length,
  );
  if (missing) {
    return {
      met: false,
      reason: "missing cell",
      baselineBExclusiveShare,
      treatmentBExclusiveShare,
      baselineAExclusiveShare,
      treatmentAExclusiveShare,
      baselinePrecisionAt10,
      treatmentPrecisionAt10,
    };
  }
  if (baselineBExclusiveShare === 0) {
    return {
      met: false,
      reason: "zero baseline share",
      baselineBExclusiveShare,
      treatmentBExclusiveShare,
      baselineAExclusiveShare,
      treatmentAExclusiveShare,
      baselinePrecisionAt10,
      treatmentPrecisionAt10,
    };
  }
  const lower =
    treatmentBExclusiveShare !== null &&
    baselineBExclusiveShare !== null &&
    treatmentBExclusiveShare < baselineBExclusiveShare;
  return {
    met: lower,
    reason: lower ? null : "not lower",
    baselineBExclusiveShare,
    treatmentBExclusiveShare,
    baselineAExclusiveShare,
    treatmentAExclusiveShare,
    baselinePrecisionAt10,
    treatmentPrecisionAt10,
  };
}

export function lessTargetMet(metCount: number, caseCount: number): boolean {
  if (caseCount !== 12) throw new Error("the less check covers 12 ordered composite cases");
  return metCount >= 10;
}

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  error?: { message?: string };
}

export async function embedPreferenceDescriptions(input: {
  texts: readonly string[];
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<number[][]> {
  const { texts, apiKey, fetchImpl = fetch, timeoutMs = PREFERENCE_EMBEDDING_TIMEOUT_MS } = input;
  if (texts.length < 1 || texts.length > PREFERENCE_EMBEDDING_MAX_INPUTS) {
    throw new Error(
      `Preference embedding accepts 1 to ${PREFERENCE_EMBEDDING_MAX_INPUTS} descriptions`,
    );
  }
  const body = JSON.stringify({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    input: [...texts],
  });
  if (Buffer.byteLength(body) > PREFERENCE_EMBEDDING_MAX_BODY_BYTES) {
    throw new Error("Preference embedding request exceeds 1 MB");
  }
  const response = await fetchImpl(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json()) as EmbeddingResponse;
  if (!response.ok || !Array.isArray(payload.data) || payload.data.length !== texts.length) {
    throw new Error(`OpenAI embeddings request failed: HTTP ${response.status}`);
  }
  const ordered = new Array<number[]>(texts.length);
  for (const result of payload.data) {
    if (
      result.index === undefined ||
      !Number.isInteger(result.index) ||
      result.index < 0 ||
      result.index >= texts.length ||
      ordered[result.index] !== undefined ||
      !Array.isArray(result.embedding) ||
      result.embedding.length !== EMBEDDING_DIMENSIONS ||
      result.embedding.some((entry) => !Number.isFinite(entry))
    ) {
      throw new Error("OpenAI embeddings response contained an invalid vector");
    }
    ordered[result.index] = result.embedding;
  }
  return ordered;
}
