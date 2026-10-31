import type { IngestDb, UnembeddedItem } from "./db.ts";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 512;
export const EMBEDDING_MODEL_VERSION = `${EMBEDDING_MODEL}@${EMBEDDING_DIMENSIONS}`;
export const EMBEDDING_BATCH_SIZE = 100;
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
  error?: { message?: string };
}

export interface EmbeddingBatchFailure {
  itemIds: string[];
  error: string;
}

export interface EmbeddingRunResult {
  embedded: number;
  failedBatches: EmbeddingBatchFailure[];
}

export interface EmbeddingOptions {
  fetch?: typeof fetch;
  itemIds?: string[];
  limit?: number;
}

function embeddingInput(item: UnembeddedItem): string {
  return `${item.title}\n\n${item.summary?.trim() ?? ""}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestEmbeddings(
  items: UnembeddedItem[],
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  const response = await fetchImpl(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      input: items.map(embeddingInput),
    }),
  });

  const payload = (await response.json()) as EmbeddingResponse;
  if (!response.ok) {
    throw new Error(
      payload.error?.message ??
        `OpenAI embeddings request failed: HTTP ${response.status}`,
    );
  }
  if (!Array.isArray(payload.data) || payload.data.length !== items.length) {
    throw new Error(
      "OpenAI embeddings response did not include every requested item",
    );
  }

  const ordered = new Array<number[]>(items.length);
  for (const result of payload.data) {
    if (
      !Number.isInteger(result.index) ||
      result.index < 0 ||
      result.index >= items.length ||
      ordered[result.index] !== undefined ||
      !Array.isArray(result.embedding) ||
      result.embedding.length !== EMBEDDING_DIMENSIONS ||
      !result.embedding.every(Number.isFinite)
    ) {
      throw new Error("OpenAI embeddings response contained an invalid vector");
    }
    ordered[result.index] = result.embedding;
  }
  return ordered;
}

/** Embed all currently unembedded items; failed API batches remain retryable. */
export async function embedPendingItems(
  db: Pick<IngestDb, "listUnembeddedItems" | "saveEmbedding">,
  apiKey: string,
  options: EmbeddingOptions = {},
): Promise<EmbeddingRunResult> {
  const fetchImpl = options.fetch ?? fetch;
  const allowedIds =
    options.itemIds === undefined ? null : new Set(options.itemIds);
  const eligible = (await db.listUnembeddedItems()).filter(
    (item) =>
      Boolean(item.summary?.trim()) &&
      (allowedIds === null || allowedIds.has(item.id)),
  );
  const pending = eligible.slice(
    0,
    Math.max(0, options.limit ?? eligible.length),
  );
  const result: EmbeddingRunResult = { embedded: 0, failedBatches: [] };

  for (
    let offset = 0;
    offset < pending.length;
    offset += EMBEDDING_BATCH_SIZE
  ) {
    const batch = pending.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    let vectors: number[][];
    try {
      vectors = await requestEmbeddings(batch, apiKey, fetchImpl);
    } catch (error) {
      result.failedBatches.push({
        itemIds: batch.map((item) => item.id),
        error: describeError(error),
      });
      continue;
    }

    for (const [index, item] of batch.entries()) {
      if (
        await db.saveEmbedding(
          item.id,
          vectors[index]!,
          EMBEDDING_MODEL_VERSION,
        )
      ) {
        result.embedded++;
      }
    }
  }

  return result;
}
