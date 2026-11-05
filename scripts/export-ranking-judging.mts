import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EARLY_RANKING_METHODS,
  encodeCsv,
  rankEarlyItems,
  type EarlyRankingItem,
  type EarlyRankingMethod,
  type RankingAnswerKey,
} from "../lib/early-ranking.ts";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_VERSION } from "../lib/embeddings.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "evaluation/early-ranking");
const samplePath = resolve(directory, "sample.json");
const personasPath = resolve(directory, "personas.json");
const judgingPath = resolve(directory, "judging.csv");
const answerKeyPath = resolve(directory, ".answer-key.json");
const seed = 8092026;

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
    throw new Error(
      "sample contains items with a different embedding model; freeze a new sample after task 11",
    );
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
  const sample = JSON.parse(await readFile(samplePath, "utf8")) as SampleConfig;
  const personas = JSON.parse(await readFile(personasPath, "utf8")) as Persona[];
  if (sample.embeddingModel !== EMBEDDING_MODEL_VERSION) {
    throw new Error(`sample uses ${sample.embeddingModel}, expected ${EMBEDDING_MODEL_VERSION}`);
  }
  if (
    await readFile(judgingPath, "utf8").then(
      () => true,
      () => false,
    )
  ) {
    throw new Error("judging.csv already exists; refusing to overwrite judgments");
  }

  const items = await fetchSampleItems(sample);
  const itemById = new Map(items.map((item) => [item.id, item]));
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
  const answerKey: RankingAnswerKey = { personas: {} };

  for (const persona of personas) {
    const likedItems = persona.likedItemIds.map((id) => {
      const item = itemById.get(id);
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
      EARLY_RANKING_METHODS.map((method) => [
        method,
        rankEarlyItems(items, persona.likedItemIds, method).slice(0, 10),
      ]),
    ) as Record<EarlyRankingMethod, EarlyRankingItem[]>;
    const unique = new Map<
      string,
      {
        item: EarlyRankingItem;
        ranks: Partial<Record<EarlyRankingMethod, number>>;
      }
    >();
    for (const method of EARLY_RANKING_METHODS) {
      if (rankedByMethod[method].length !== 10) {
        throw new Error(`${persona.id}/${method} has fewer than 10 candidates`);
      }
      rankedByMethod[method].forEach((item, index) => {
        const entry = unique.get(item.id) ?? { item, ranks: {} };
        entry.ranks[method] = index + 1;
        unique.set(item.id, entry);
      });
    }

    const shuffled = seededShuffle([...unique.values()], seed + persona.id.length);
    const blindIdByItemId = new Map<string, string>();
    shuffled.forEach(({ item }, index) => {
      const blindId = `${persona.id}-${String(index + 1).padStart(3, "0")}`;
      blindIdByItemId.set(item.id, blindId);
      rows.push([
        persona.id,
        persona.description,
        blindId,
        item.title,
        item.summary ?? "",
        item.language,
        item.url,
        "",
      ]);
    });

    answerKey.personas[persona.id] = Object.fromEntries(
      EARLY_RANKING_METHODS.map((method) => [
        method,
        rankedByMethod[method].map((item, index) => ({
          blindId: blindIdByItemId.get(item.id)!,
          rank: index + 1,
        })),
      ]),
    ) as RankingAnswerKey["personas"][string];
  }

  await mkdir(directory, { recursive: true });
  await writeFile(judgingPath, encodeCsv(rows), { flag: "wx" });
  await writeFile(answerKeyPath, `${JSON.stringify(answerKey, null, 2)}\n`);
  console.log(
    `Wrote ${rows.length - 1} shuffled, deduplicated judging rows to evaluation/early-ranking/judging.csv`,
  );
  console.log("The method mapping is kept in the ignored local .answer-key.json file.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
