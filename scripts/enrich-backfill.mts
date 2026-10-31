import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createIngestDb } from "../lib/db.ts";
import {
  formatBackfillProgress,
  formatBackfillResult,
  parseBackfillArgs,
  runEnrichmentBackfill,
} from "../lib/enrich/backfill.ts";

function loadSelectedEnvironment(environment: "local" | "production"): void {
  const filePath =
    environment === "production" ? ".env.production.local" : ".env.local";
  let fileEnvironment: ReturnType<typeof parseEnv>;
  try {
    fileEnvironment = parseEnv(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(
      `Could not load the selected environment file: ${filePath}`,
    );
  }

  for (const key of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENAI_API_KEY",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, fileEnvironment);

  let projectUrl: URL;
  try {
    projectUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  } catch {
    throw new Error("The selected environment has no valid Supabase URL.");
  }
  if (
    environment === "local" &&
    (projectUrl.hostname !== "127.0.0.1" || projectUrl.port !== "55321")
  ) {
    throw new Error(
      "The default environment must target local Supabase; use --env production explicitly for hosted credentials.",
    );
  }
  if (
    environment === "production" &&
    (projectUrl.protocol !== "https:" ||
      projectUrl.hostname === "localhost" ||
      projectUrl.hostname === "127.0.0.1")
  ) {
    throw new Error(
      "The production environment must target a hosted HTTPS project.",
    );
  }
}

async function main(): Promise<void> {
  const options = parseBackfillArgs(process.argv.slice(2));
  loadSelectedEnvironment(options.environment);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    throw new Error("Missing OPENAI_API_KEY in the selected environment.");

  const result = await runEnrichmentBackfill(createIngestDb(), apiKey, {
    ...options,
    onProgress: (progress) => console.log(formatBackfillProgress(progress)),
  });
  console.log(formatBackfillResult(result));
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Backfill failed.";
  console.error(`Enrichment backfill failed: ${message}`);
  process.exitCode = 1;
});
