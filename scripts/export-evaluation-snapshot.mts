import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSnapshotManifest,
  meanHashKey,
  parseSnapshotDateRange,
  requireProductionUrl,
  stringifyJsonLines,
  type SnapshotRow,
} from "../lib/evaluation-snapshot.ts";
import { EMBEDDING_MODEL_VERSION } from "../lib/embeddings.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pageSize = 500;

function parseArguments(args: string[]): {
  from?: string;
  toExclusive?: string;
  provisional: boolean;
} {
  const parsed: { from?: string; toExclusive?: string; provisional: boolean } = {
    provisional: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--from" || argument.startsWith("--from=")) {
      parsed.from = argument === "--from" ? args[++index] : argument.slice("--from=".length);
    } else if (argument === "--to" || argument.startsWith("--to=")) {
      parsed.toExclusive = argument === "--to" ? args[++index] : argument.slice("--to=".length);
    } else if (argument === "--provisional") {
      parsed.provisional = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return parsed;
}

function environmentFileValue(content: string, key: string): string | undefined {
  const line = content.split(/\r?\n/u).find((entry) => new RegExp(`^\\s*${key}\\s*=`).test(entry));
  if (!line) return undefined;
  const value = line.slice(line.indexOf("=") + 1).trim();
  return value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const snapshotDirectory = resolve(
    root,
    "evaluation/snapshot",
    arguments_.provisional ? "provisional" : ".",
  );
  const dateRange = parseSnapshotDateRange(
    arguments_.from,
    arguments_.toExclusive,
    arguments_.provisional,
  );
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required; run through pnpm eval:export",
    );
  }
  const productionEnv = await readFile(resolve(root, ".env.production.local"), "utf8");
  const productionUrl = environmentFileValue(productionEnv, "NEXT_PUBLIC_SUPABASE_URL");
  if (!productionUrl || projectUrl !== productionUrl) {
    throw new Error(
      "active Supabase URL must match NEXT_PUBLIC_SUPABASE_URL in .env.production.local",
    );
  }
  requireProductionUrl(projectUrl);

  const client = createClient(projectUrl, serviceRoleKey);
  const items: SnapshotRow[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("content_items")
      .select(
        "id,source_id,type,url,title,summary,summary_origin,enrichment_status,enrichment_attempt_count,enrichment_last_attempt_at,enrichment_next_attempt_at,enrichment_error,language,categories,thumbnail_url,published_at,embedding,embedding_model,created_at",
      )
      .eq("embedding_model", EMBEDDING_MODEL_VERSION)
      .not("embedding", "is", null)
      .eq("enrichment_status", "completed")
      .not("summary", "is", null)
      .gte("published_at", dateRange.from)
      .lt("published_at", dateRange.toExclusive)
      .order("published_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`loading snapshot items failed: ${error.message}`);
    const page = (data ?? []) as SnapshotRow[];
    items.push(...page.filter((row) => String(row.summary).trim().length > 0));
    if (page.length < pageSize) break;
  }

  const { data: meanData, error: meanError } = await client
    .from("embedding_language_means")
    .select("embedding_model,language,mean,item_count,computed_at")
    .order("embedding_model")
    .order("language");
  if (meanError) {
    throw new Error(`loading snapshot language means failed: ${meanError.message}`);
  }
  const allMeans = (meanData ?? []) as SnapshotRow[];
  const itemMeanKeys = new Set(
    items.map((row) => `${String(row.embedding_model)}:${String(row.language)}`),
  );
  const means = allMeans.filter((row) => itemMeanKeys.has(meanHashKey(row)));
  const meanKeys = new Set(means.map(meanHashKey));
  const eligibleItems = items.filter((row) =>
    meanKeys.has(`${String(row.embedding_model)}:${String(row.language)}`),
  );
  const sourceIds = [...new Set(eligibleItems.map((row) => String(row.source_id)))];
  const sources: SnapshotRow[] = [];
  for (let offset = 0; offset < sourceIds.length; offset += 100) {
    const ids = sourceIds.slice(offset, offset + 100);
    const { data, error } = await client
      .from("sources")
      .select(
        "id,name,feed_url,site_url,kind,language,is_active,etag,last_modified,last_fetched_at,last_success_at,last_error,created_at",
      )
      .in("id", ids)
      .order("id");
    if (error) throw new Error(`loading snapshot sources failed: ${error.message}`);
    sources.push(...((data ?? []) as SnapshotRow[]));
  }

  const manifest = buildSnapshotManifest({
    dateRange,
    sources,
    items: eligibleItems,
    means,
    provisional: arguments_.provisional,
  });
  await mkdir(snapshotDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(snapshotDirectory, "sources.jsonl"),
      stringifyJsonLines(
        sources.sort((left, right) => String(left.id).localeCompare(String(right.id))),
      ),
    ),
    writeFile(
      resolve(snapshotDirectory, "items.jsonl"),
      stringifyJsonLines(
        [...eligibleItems].sort(
          (left, right) =>
            String(left.published_at).localeCompare(String(right.published_at)) ||
            String(left.id).localeCompare(String(right.id)),
        ),
      ),
    ),
    writeFile(
      resolve(snapshotDirectory, "means.jsonl"),
      stringifyJsonLines(
        means.sort((left, right) => meanHashKey(left).localeCompare(meanHashKey(right))),
      ),
    ),
    writeFile(
      resolve(snapshotDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
  ]);
  console.log(
    `Exported ${manifest.counts.items} ${manifest.provisional ? "provisional " : ""}items, ${manifest.counts.sources} sources, and ${manifest.counts.means} language means to evaluation/snapshot${manifest.provisional ? "/provisional" : ""}. Production was read only.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
