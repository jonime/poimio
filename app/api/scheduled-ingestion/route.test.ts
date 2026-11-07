import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const { createIngestDb, claim, release, runIngestion } = vi.hoisted(() => ({
  createIngestDb: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  runIngestion: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ createIngestDb }));
vi.mock("@/lib/ingest", () => ({
  runIngestion,
  formatIngestionSummary: () => "Ingestion summary",
}));

function scheduledRequest(): Request {
  return new Request("https://poimio.example/api/scheduled-ingestion", {
    method: "POST",
    headers: {
      "ce-specversion": "1.0",
      "ce-type": "com.vercel.schedule.v1beta",
      "ce-source": "/schedule/default/feed-ingestion",
      "ce-id": "schx_test",
      "ce-vssscheduleid": "sch_test",
      "ce-vssschedulename": "feed-ingestion",
      "ce-vssnamespace": "default",
      "ce-vssscheduledat": "2026-11-07T12:00:00.000Z",
      "ce-vssschedulesource": "static",
      "ce-vssexpression": "0 * * * *",
    },
  });
}

describe("scheduled ingestion handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.spyOn(console, "info").mockImplementation(() => {});
    createIngestDb.mockReturnValue({
      claimScheduledIngestion: claim,
      releaseScheduledIngestion: release,
    });
    claim.mockResolvedValue(true);
    runIngestion.mockResolvedValue({ embeddings: { failedBatches: [] } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("runs ingestion under a lease and releases it on success", async () => {
    expect((await POST(scheduledRequest())).status).toBe(200);
    expect(runIngestion).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(claim.mock.calls[0]?.[0]);
  });

  it("skips overlap without releasing the other run's lease", async () => {
    claim.mockResolvedValue(false);
    expect((await POST(scheduledRequest())).status).toBe(200);
    expect(runIngestion).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("releases the lease and reports a failed embedding batch as a failed run", async () => {
    runIngestion.mockResolvedValue({ embeddings: { failedBatches: [{}] } });
    await expect(POST(scheduledRequest())).rejects.toThrow("failed embedding batches");
    expect(release).toHaveBeenCalledWith(claim.mock.calls[0]?.[0]);
  });

  it("releases the lease and propagates an ingestion error", async () => {
    runIngestion.mockRejectedValue(new Error("Ingestion failed"));
    await expect(POST(scheduledRequest())).rejects.toThrow("Ingestion failed");
    expect(release).toHaveBeenCalledWith(claim.mock.calls[0]?.[0]);
  });

  it("rejects requests without schedule metadata and blocks Preview runs", async () => {
    expect((await POST(new Request("https://poimio.example", { method: "POST" }))).status).toBe(
      400,
    );
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await POST(scheduledRequest())).status).toBe(404);
    expect(createIngestDb).not.toHaveBeenCalled();
  });
});
