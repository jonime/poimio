import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDING_MODEL_VERSION } from "../lib/embeddings.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samplePath = resolve(root, "evaluation/early-ranking/sample.json");
const personasPath = resolve(root, "evaluation/early-ranking/personas.json");
const sampleSize = 300;
const pageSize = 1000;

interface SampleRow {
  id: string;
  language: "fi" | "en";
  embedding_model: string | null;
}

interface PersonaConfig {
  likedItemIds: string[];
}

async function main(): Promise<void> {
  try {
    await readFile(samplePath);
    throw new Error(`${samplePath} already exists; refusing to replace the frozen sample`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const client = createClient(projectUrl, serviceRoleKey);
  const rows: SampleRow[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("content_items")
      .select("id,language,embedding_model")
      .not("embedding", "is", null)
      .order("published_at", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`loading embedded items failed: ${error.message}`);
    const page = (data ?? []) as SampleRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  if (rows.length < sampleSize) {
    throw new Error(`need at least ${sampleSize} embedded items; found ${rows.length}`);
  }
  const personas = JSON.parse(await readFile(personasPath, "utf8")) as PersonaConfig[];
  const pinnedIds = [...new Set(personas.flatMap((persona) => persona.likedItemIds))];
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const missingPinnedId = pinnedIds.find((id) => !rowById.has(id));
  if (missingPinnedId) {
    throw new Error(`persona seed ${missingPinnedId} is not embedded in Supabase`);
  }
  const pinnedSet = new Set(pinnedIds);
  const pinnedRows = pinnedIds.map((id) => rowById.get(id)!);
  const remaining = rows.filter((row) => !pinnedSet.has(row.id));
  const selected = [...pinnedRows, ...remaining.slice(0, sampleSize - pinnedRows.length)];
  if (selected.length !== sampleSize) {
    throw new Error("could not create the requested sample size");
  }
  if (
    !selected.some((row) => row.language === "fi") ||
    !selected.some((row) => row.language === "en")
  ) {
    throw new Error("the frozen sample must include both Finnish and English items");
  }
  const wrongModel = selected.find((row) => row.embedding_model !== EMBEDDING_MODEL_VERSION);
  if (wrongModel) {
    throw new Error(`item ${wrongModel.id} does not use ${EMBEDDING_MODEL_VERSION}`);
  }

  await mkdir(dirname(samplePath), { recursive: true });
  await writeFile(
    samplePath,
    `${JSON.stringify(
      {
        frozenAt: new Date().toISOString(),
        embeddingModel: EMBEDDING_MODEL_VERSION,
        itemIds: selected.map((row) => row.id),
        languageCounts: {
          fi: selected.filter((row) => row.language === "fi").length,
          en: selected.filter((row) => row.language === "en").length,
        },
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  console.log(
    `Froze ${selected.length} items (${selected.filter((row) => row.language === "fi").length} fi, ${selected.filter((row) => row.language === "en").length} en) to evaluation/early-ranking/sample.json`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
