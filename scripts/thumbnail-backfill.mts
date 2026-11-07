import { readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import { createIngestDb } from "../lib/db.ts";
import { parseThumbnailCursor, runThumbnailBackfill } from "../lib/thumbnails/backfill.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      cursor: { type: "string" },
    },
  });
  const cursor = values.cursor === undefined ? undefined : parseThumbnailCursor(values.cursor);
  const production = process.execArgv.includes("--env-file=.env.production.local");
  const envFile = production ? ".env.production.local" : ".env.local";
  const env = parseEnv(readFileSync(envFile, "utf8"));
  const target = URL.parse(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (production) {
    if (target?.protocol !== "https:" || !target.hostname.endsWith(".supabase.co")) {
      throw new Error(
        "The .env.production.local Supabase URL must target a hosted Supabase project.",
      );
    }
  } else if (env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:55321") {
    throw new Error("The .env.local Supabase URL must target http://127.0.0.1:55321.");
  }
  console.log(production ? "Target: hosted Supabase" : "Target: local Supabase");

  const result = await runThumbnailBackfill(createIngestDb(env), {
    dryRun: values["dry-run"] ?? false,
    ...(cursor ? { cursor } : {}),
  });
  if (values["dry-run"]) {
    for (const candidate of result.candidates) {
      const url = new URL(candidate.url);
      console.log(`${candidate.id} ${candidate.publishedAt} ${url.origin}${url.pathname}`);
    }
  }
  console.log(
    `Candidates: ${result.candidates.length}, found: ${result.found}, upgraded: ${result.upgraded}, omitted: ${result.omitted}, fetch failures: ${result.fetchFailures}, concurrent changes: ${result.concurrentChanges}`,
  );
  console.log(result.cursor ? `Continue with --cursor ${result.cursor}` : "No continuation.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Thumbnail backfill failed.");
  process.exitCode = 1;
});
