import { createIngestDb } from "../lib/db.ts";
import { formatIngestionSummary, runIngestion } from "../lib/ingest.ts";

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("missing environment variable: OPENAI_API_KEY (see .env.example)");
  }

  const result = await runIngestion(createIngestDb(), apiKey);
  console.log(formatIngestionSummary(result));
  if (result.embeddings.failedBatches.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Ingestion failed: ${message}`);
  process.exitCode = 1;
});
