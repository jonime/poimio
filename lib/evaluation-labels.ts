import { createHash } from "node:crypto";

export const EVALUATION_LABEL_PROMPT_VERSION = "relevance-v1";
export const EVALUATION_LABEL_BATCH_SIZE = 20;

export interface EvaluationPersona {
  id: string;
  description: string;
}

export interface EvaluationLabelItem {
  id: string;
  title: string;
  summary: string;
  language: "fi" | "en";
}

export interface EvaluationLabel {
  personaId: string;
  itemId: string;
  model: string;
  promptVersion: string;
  relevant: boolean;
}

export interface LabelSet {
  id: string;
  hash: string;
  model: string;
  promptVersion: string;
  labels: EvaluationLabel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function chunkItems<T>(
  items: T[],
  size = EVALUATION_LABEL_BATCH_SIZE,
): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("Batch size must be a positive integer");
  }
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}

export function labelCacheKey(
  personaId: string,
  itemId: string,
  model: string,
  promptVersion: string,
): string {
  return JSON.stringify([personaId, itemId, model, promptVersion]);
}

export function parseLabelResponse(
  content: string,
  expectedItemIds: string[],
): Map<string, boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Label response is not valid JSON");
  }
  if (
    !isRecord(parsed) ||
    !Object.hasOwn(parsed, "labels") ||
    !Array.isArray(parsed.labels)
  ) {
    throw new Error("Label response must contain a labels array");
  }

  const labels = new Map<string, boolean>();
  for (const entry of parsed.labels) {
    if (
      !isRecord(entry) ||
      typeof entry.item_id !== "string" ||
      typeof entry.relevant !== "boolean"
    ) {
      throw new Error(
        "Each label requires a string item_id and boolean relevant",
      );
    }
    if (!expectedItemIds.includes(entry.item_id)) {
      throw new Error(
        `Label response contains unexpected item ${entry.item_id}`,
      );
    }
    if (labels.has(entry.item_id)) {
      throw new Error(`Label response repeats item ${entry.item_id}`);
    }
    labels.set(entry.item_id, entry.relevant);
  }
  if (
    labels.size !== expectedItemIds.length ||
    expectedItemIds.some((id) => !labels.has(id))
  ) {
    throw new Error(
      "Label response must label every requested item exactly once",
    );
  }
  return labels;
}

export function parseLabelJsonLines(content: string): EvaluationLabel[] {
  return content
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Label cache has invalid JSON on line ${index + 1}`);
      }
      if (
        !isRecord(parsed) ||
        typeof parsed.personaId !== "string" ||
        typeof parsed.itemId !== "string" ||
        typeof parsed.model !== "string" ||
        typeof parsed.promptVersion !== "string" ||
        typeof parsed.relevant !== "boolean"
      ) {
        throw new Error(`Label cache row ${index + 1} has an invalid schema`);
      }
      return {
        personaId: parsed.personaId,
        itemId: parsed.itemId,
        model: parsed.model,
        promptVersion: parsed.promptVersion,
        relevant: parsed.relevant,
      };
    });
}

export function validateLabelSet(input: {
  personas: EvaluationPersona[];
  items: EvaluationLabelItem[];
  labels: EvaluationLabel[];
}): LabelSet {
  const { personas, items, labels } = input;
  if (labels.length === 0) throw new Error("Label set is empty");
  const model = labels[0]!.model;
  const promptVersion = labels[0]!.promptVersion;
  if (
    labels.some(
      (label) => label.model !== model || label.promptVersion !== promptVersion,
    )
  ) {
    throw new Error("Label set contains more than one model or prompt version");
  }

  const personaIds = new Set(personas.map((persona) => persona.id));
  const itemIds = new Set(items.map((item) => item.id));
  const pairs = new Set<string>();
  for (const label of labels) {
    if (!personaIds.has(label.personaId) || !itemIds.has(label.itemId)) {
      throw new Error("Label set contains an unknown persona or item");
    }
    const key = labelCacheKey(
      label.personaId,
      label.itemId,
      label.model,
      label.promptVersion,
    );
    if (pairs.has(key)) throw new Error("Label set contains a duplicate pair");
    pairs.add(key);
  }
  const expectedCount = personas.length * items.length;
  if (pairs.size !== expectedCount) {
    throw new Error(
      `Label set is incomplete: expected ${expectedCount} persona-item pairs, found ${pairs.size}`,
    );
  }
  for (const persona of personas) {
    for (const item of items) {
      if (
        !pairs.has(labelCacheKey(persona.id, item.id, model, promptVersion))
      ) {
        throw new Error(`Label set is missing ${persona.id}/${item.id}`);
      }
    }
  }

  const sortedLabels = [...labels].sort(
    (left, right) =>
      left.personaId.localeCompare(right.personaId) ||
      left.itemId.localeCompare(right.itemId),
  );
  const hash = createHash("sha256")
    .update(JSON.stringify(sortedLabels))
    .digest("hex");
  return {
    id: `${model}:${promptVersion}:${hash.slice(0, 16)}`,
    hash,
    model,
    promptVersion,
    labels: sortedLabels,
  };
}
