import { handleSchedule } from "@vercel/schedules";
import { createIngestDb } from "@/lib/db";
import { formatIngestionSummary, runIngestion } from "@/lib/ingest";

const handleIngestion = handleSchedule(async ({ executionId }) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const db = createIngestDb();
  const leaseId = crypto.randomUUID();
  if (!(await db.claimScheduledIngestion(leaseId))) {
    console.info(`Skipping ingestion run ${executionId} because another run is active`);
    return;
  }

  try {
    const result = await runIngestion(db, apiKey);
    console.info(formatIngestionSummary(result));
    if (result.embeddings.failedBatches.length > 0) {
      throw new Error("Scheduled ingestion had failed embedding batches");
    }
  } finally {
    await db.releaseScheduledIngestion(leaseId);
  }
});

export async function POST(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV !== "production") return new Response(null, { status: 404 });
  return handleIngestion(request);
}
