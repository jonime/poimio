import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  CENTERED_RANKING_METHODS,
  type CenteredJudgingRow,
  type CenteredRankingAnswerKey,
  type CenteredRankingMethod,
  centerEmbeddingsByLanguage,
  type EarlyRankingItem,
  type EarlyRankingMethod,
  encodeCsv,
  parseCsv,
  rankEarlyItems,
} from "../lib/early-ranking.ts";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_VERSION } from "../lib/embeddings.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "evaluation/early-ranking");
const samplePath = resolve(directory, "sample.json");
const personasPath = resolve(directory, "personas.json");
const previousJudgingPath = resolve(directory, "judging.csv");
const judgingPath = resolve(directory, "centered-judging.csv");
const answerKeyPath = resolve(directory, ".centered-answer-key.json");
const seed = 13102026;

interface SampleConfig {
  embeddingModel: string;
  itemIds: string[];
}

interface Persona {
  id: string;
  description: string;
  likedItemIds: string[];
}

interface ContentRow {
  id: string;
  title: string;
  summary: string | null;
  language: "fi" | "en";
  url: string;
  published_at: string;
  embedding: string | number[];
  embedding_model: string;
}

function parseEmbedding(value: string | number[]): number[] {
  const vector = Array.isArray(value) ? value : value.slice(1, -1).split(",").map(Number);
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((entry) => !Number.isFinite(entry))) {
    throw new Error("an item has an invalid embedding vector");
  }
  return vector;
}

function seededShuffle<T>(items: T[], initialSeed: number): T[] {
  const shuffled = [...items];
  let state = initialSeed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const random = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    const swapIndex = Math.floor(random * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function readJudgments(csv: string): CenteredJudgingRow[] {
  const [header, ...records] = parseCsv(csv);
  if (!header) throw new Error("judging.csv is empty");
  const columns = new Map(header.map((name, index) => [name, index]));
  for (const required of ["persona", "url", "relevant"]) {
    if (!columns.has(required)) throw new Error(`judging.csv is missing ${required}`);
  }
  return records.map((record) => ({
    persona: record[columns.get("persona")!] ?? "",
    url: record[columns.get("url")!] ?? "",
    relevant: record[columns.get("relevant")!] ?? "",
  }));
}

async function fetchSampleItems(sample: SampleConfig): Promise<EarlyRankingItem[]> {
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const client = createClient(projectUrl, serviceRoleKey);
  const rows: ContentRow[] = [];
  for (let offset = 0; offset < sample.itemIds.length; offset += 100) {
    const ids = sample.itemIds.slice(offset, offset + 100);
    const { data, error } = await client
      .from("content_items")
      .select("id,title,summary,language,url,published_at,embedding,embedding_model")
      .in("id", ids)
      .not("embedding", "is", null);
    if (error) throw new Error(`loading sample items failed: ${error.message}`);
    rows.push(...((data ?? []) as ContentRow[]));
  }
  if (rows.length !== sample.itemIds.length) {
    throw new Error(`sample expected ${sample.itemIds.length} items, found ${rows.length}`);
  }
  if (rows.some((row) => row.embedding_model !== sample.embeddingModel)) {
    throw new Error("sample contains items with a different embedding model");
  }
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    language: row.language,
    url: row.url,
    publishedAt: row.published_at,
    embedding: parseEmbedding(row.embedding),
  }));
}

async function main(): Promise<void> {
  if (
    await readFile(judgingPath, "utf8").then(
      () => true,
      () => false,
    )
  ) {
    throw new Error("centered-judging.csv already exists; refusing to overwrite judgments");
  }
  if (
    await readFile(answerKeyPath, "utf8").then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(".centered-answer-key.json already exists; refusing to overwrite it");
  }

  const sample = JSON.parse(await readFile(samplePath, "utf8")) as SampleConfig;
  const personas = JSON.parse(await readFile(personasPath, "utf8")) as Persona[];
  if (sample.embeddingModel !== EMBEDDING_MODEL_VERSION) {
    throw new Error(`sample uses ${sample.embeddingModel}, expected ${EMBEDDING_MODEL_VERSION}`);
  }

  const previousJudgments = readJudgments(await readFile(previousJudgingPath, "utf8"));
  const previouslyJudged = new Set(
    previousJudgments.map((row) => `${row.persona}\u0000${row.url}`),
  );
  if (previouslyJudged.size !== previousJudgments.length) {
    throw new Error("judging.csv contains duplicate persona/URL judgments");
  }
  if (previousJudgments.some((row) => row.relevant !== "0" && row.relevant !== "1")) {
    throw new Error("judging.csv contains incomplete or invalid judgments");
  }

  const items = await fetchSampleItems(sample);
  const centered = centerEmbeddingsByLanguage(items);
  const rawById = new Map(items.map((item) => [item.id, item]));
  const rankingInputs: Record<
    CenteredRankingMethod,
    { items: EarlyRankingItem[]; method: EarlyRankingMethod }
  > = {
    "nearest-liked-raw": { items, method: "nearest-liked" },
    "average-vector-raw": { items, method: "average-vector" },
    "nearest-liked-centered": {
      items: centered.items,
      method: "nearest-liked",
    },
    "average-vector-centered": {
      items: centered.items,
      method: "average-vector",
    },
    "newest-first": { items, method: "newest-first" },
  };
  const rows = [
    [
      "persona",
      "persona_description",
      "blind_id",
      "title",
      "summary",
      "language",
      "url",
      "relevant",
    ],
  ];
  const answerKey: CenteredRankingAnswerKey = {
    languageMeans: centered.means,
    personas: {},
  };

  for (const persona of personas) {
    const likedItems = persona.likedItemIds.map((id) => {
      const item = rawById.get(id);
      if (!item)
        throw new Error(
          `persona ${persona.id} likes item ${id}, which is not in the frozen sample`,
        );
      return item;
    });
    if (likedItems.length !== 5 || !likedItems.some((item) => item.language === "fi")) {
      throw new Error(
        `${persona.id} must have five liked items including at least one Finnish item`,
      );
    }

    const rankedByMethod = Object.fromEntries(
      CENTERED_RANKING_METHODS.map((method) => {
        const input = rankingInputs[method];
        return [
          method,
          rankEarlyItems(input.items, persona.likedItemIds, input.method).slice(0, 10),
        ];
      }),
    ) as Record<CenteredRankingMethod, EarlyRankingItem[]>;
    const answerMethods = Object.fromEntries(
      CENTERED_RANKING_METHODS.map((method) => {
        const rankedItems = rankedByMethod[method];
        if (rankedItems.length !== 10) {
          throw new Error(`${persona.id}/${method} has fewer than 10 candidates`);
        }
        return [
          method,
          rankedItems.map((item, index) => ({
            url: item.url,
            rank: index + 1,
          })),
        ];
      }),
    ) as CenteredRankingAnswerKey["personas"][string];
    answerKey.personas[persona.id] = answerMethods;

    const unjudgedByUrl = new Map<string, EarlyRankingItem>();
    for (const method of CENTERED_RANKING_METHODS) {
      for (const item of rankedByMethod[method]) {
        if (!previouslyJudged.has(`${persona.id}\u0000${item.url}`)) {
          unjudgedByUrl.set(item.url, item);
        }
      }
    }
    const shuffled = seededShuffle([...unjudgedByUrl.values()], seed + persona.id.length);
    shuffled.forEach((item, index) => {
      rows.push([
        persona.id,
        persona.description,
        `${persona.id}-r-${String(index + 1).padStart(3, "0")}`,
        item.title,
        item.summary ?? "",
        item.language,
        item.url,
        "",
      ]);
    });
  }

  await mkdir(directory, { recursive: true });
  await writeFile(judgingPath, encodeCsv(rows), { flag: "wx" });
  await writeFile(answerKeyPath, `${JSON.stringify(answerKey, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    `Wrote ${rows.length - 1} previously unjudged items to evaluation/early-ranking/centered-judging.csv`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
