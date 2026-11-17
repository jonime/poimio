import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { requireProductionUrl } from "../lib/evaluation-snapshot.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "evaluation/ai-generated-descriptions.md");
const pageSize = 500;

export interface DescriptionItem {
  id: string;
  title: string;
  url: string;
  summary: string;
  published_at: string | null;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/([\\`*_{}[\]()#+.!|>~])/gu, "\\$1");
}

export function formatDescriptions(items: readonly DescriptionItem[], exportedAt: string): string {
  const entries = items.map((item, index) => {
    const url = new URL(item.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Invalid article URL for item ${item.id}`);
    }
    const link = url.href.replace(/</gu, "%3C").replace(/>/gu, "%3E");
    return `## ${index + 1}. ${escapeMarkdown(item.title)}\n\nArticle: <${link}>\n\n${escapeMarkdown(item.summary)}\n`;
  });
  return `# AI-generated descriptions\n\nProduction export: ${exportedAt}\n\n${items.length} article descriptions.\n\n${entries.join("\n---\n\n")}`;
}

async function main(): Promise<void> {
  const environment = parseEnv(await readFile(resolve(root, ".env.production.local"), "utf8"));
  const projectUrl = environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) {
    throw new Error(
      "Production Supabase URL and service-role key are required in .env.production.local",
    );
  }
  requireProductionUrl(projectUrl);

  const client = createClient(projectUrl, serviceRoleKey);
  const items: DescriptionItem[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("content_items")
      .select("id,title,url,summary,published_at")
      .eq("type", "article")
      .eq("summary_origin", "ai_generated")
      .eq("enrichment_status", "completed")
      .not("summary", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Loading descriptions failed: ${error.message}`);
    const page: DescriptionItem[] = data ?? [];
    items.push(...page);
    if (page.length < pageSize) break;
  }

  await writeFile(outputPath, formatDescriptions(items, new Date().toISOString()));
  console.log(`Exported ${items.length} descriptions to evaluation/ai-generated-descriptions.md.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
