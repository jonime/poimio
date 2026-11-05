import { createClient } from "@supabase/supabase-js";
import {
  addLanguageEmbedding,
  createLanguageMeanAccumulator,
  finishLanguageMeans,
  MIN_LANGUAGE_MEAN_ITEMS,
  parseEmbeddingVector,
  type ContentLanguage,
} from "../lib/language-means.ts";
import { EMBEDDING_MODEL_VERSION } from "../lib/embeddings.ts";

const pageSize = 1000;

interface EmbeddedItemRow {
  language: ContentLanguage;
  embedding: string;
}

async function main(): Promise<void> {
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const client = createClient(projectUrl, serviceRoleKey);
  const accumulator = createLanguageMeanAccumulator();
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("content_items")
      .select("language,embedding")
      .eq("embedding_model", EMBEDDING_MODEL_VERSION)
      .not("embedding", "is", null)
      .order("id")
      .range(offset, offset + pageSize - 1);
    if (error) {
      throw new Error(`loading embedded items failed: ${error.message}`);
    }

    const rows = (data ?? []) as EmbeddedItemRow[];
    for (const row of rows) {
      addLanguageEmbedding(accumulator, row.language, parseEmbeddingVector(row.embedding));
    }
    if (rows.length < pageSize) break;
  }

  const means = finishLanguageMeans(accumulator);
  const rows = means.map(({ language, itemCount, mean }) => ({
    embedding_model: EMBEDDING_MODEL_VERSION,
    language,
    mean: `[${mean.join(",")}]`,
    item_count: itemCount,
    computed_at: new Date().toISOString(),
  }));

  if (rows.length > 0) {
    const { error } = await client
      .from("embedding_language_means")
      .upsert(rows, { onConflict: "embedding_model,language" });
    if (error) {
      throw new Error(`saving language means failed: ${error.message}`);
    }
  }

  const skippedLanguages = (Object.keys(accumulator.counts) as ContentLanguage[]).filter(
    (language) => accumulator.counts[language] < MIN_LANGUAGE_MEAN_ITEMS,
  );
  if (skippedLanguages.length > 0) {
    const { error } = await client
      .from("embedding_language_means")
      .delete()
      .eq("embedding_model", EMBEDDING_MODEL_VERSION)
      .in("language", skippedLanguages);
    if (error) {
      throw new Error(`removing stale language means failed: ${error.message}`);
    }
  }

  for (const language of ["fi", "en"] as const) {
    const count = accumulator.counts[language];
    const status = count >= MIN_LANGUAGE_MEAN_ITEMS ? "saved" : "skipped";
    console.log(`${language}: ${count} items (${status})`);
  }
  console.log(`Computed ${rows.length} language means for ${EMBEDDING_MODEL_VERSION}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
