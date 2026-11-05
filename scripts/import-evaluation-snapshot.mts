import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseJsonLines,
  requireLocalSupabaseUrl,
  validateSnapshotData,
  type EvaluationSnapshotManifest,
  type SnapshotRow,
} from "../lib/evaluation-snapshot.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const batchSize = 100;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--provisional")) {
    throw new Error("usage: pnpm eval:import [--provisional]");
  }
  const provisional = args.includes("--provisional");
  const snapshotDirectory = resolve(root, "evaluation/snapshot", provisional ? "provisional" : ".");
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required; run through pnpm eval:import",
    );
  }
  requireLocalSupabaseUrl(projectUrl);

  const [manifestText, sourcesText, itemsText, meansText] = await Promise.all([
    readFile(resolve(snapshotDirectory, "manifest.json"), "utf8"),
    readFile(resolve(snapshotDirectory, "sources.jsonl"), "utf8"),
    readFile(resolve(snapshotDirectory, "items.jsonl"), "utf8"),
    readFile(resolve(snapshotDirectory, "means.jsonl"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as EvaluationSnapshotManifest;
  if (manifest.provisional !== provisional) {
    throw new Error("snapshot provisional state does not match --provisional");
  }
  const sources = parseJsonLines<SnapshotRow>(sourcesText, "sources.jsonl");
  const items = parseJsonLines<SnapshotRow>(itemsText, "items.jsonl");
  const means = parseJsonLines<SnapshotRow>(meansText, "means.jsonl");
  validateSnapshotData({ manifest, sources, items, means });

  const client = createClient(projectUrl, serviceRoleKey);
  const [contentCount, meansCount] = await Promise.all(
    ["content_items", "embedding_language_means"].map(async (table) => {
      const { count, error } = await client.from(table).select("*", { count: "exact", head: true });
      if (error) {
        throw new Error(`checking local ${table} failed: ${error.message}`);
      }
      if (count === null) {
        throw new Error(`could not verify whether local ${table} is empty`);
      }
      return count;
    }),
  );
  if (contentCount !== 0) {
    throw new Error(`local content_items must be empty before import; found ${contentCount} rows`);
  }
  if (meansCount !== 0) {
    throw new Error(
      `local embedding_language_means must be empty before import; found ${meansCount} rows`,
    );
  }
  for (let offset = 0; offset < sources.length; offset += batchSize) {
    const batch = sources.slice(offset, offset + batchSize);
    const { error } = await client.from("sources").upsert(batch, { onConflict: "feed_url" });
    if (error) {
      throw new Error(`inserting sources failed: ${error.message}`);
    }
  }
  for (let offset = 0; offset < means.length; offset += batchSize) {
    const batch = means.slice(offset, offset + batchSize);
    const { error } = await client.from("embedding_language_means").insert(batch);
    if (error) {
      throw new Error(`inserting language means failed: ${error.message}`);
    }
  }
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    const { error } = await client.from("content_items").insert(batch);
    if (error) {
      throw new Error(`inserting content items failed: ${error.message}`);
    }
  }
  console.log(
    `Imported ${items.length} items, ${sources.length} sources, and ${means.length} language means into local Supabase with original UUIDs.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
