import { describe, expect, it, vi } from "vitest";
import type { EnrichmentItem, UnembeddedItem } from "../db.ts";
import { EMBEDDING_DIMENSIONS } from "../embeddings.ts";
import type { EnrichmentBackfillDb } from "./backfill.ts";
import {
  formatBackfillProgress,
  formatBackfillResult,
  parseBackfillArgs,
  runEnrichmentBackfill,
} from "./backfill.ts";
import type { PageFetchResult } from "./page.ts";

const fixedNow = new Date("2026-10-31T12:00:00.000Z");

function item(id: string, attemptCount = 0): EnrichmentItem {
  return {
    id,
    url: `https://${id}.example.com/article`,
    title: `Title ${id}`,
    summary: null,
    language: "fi",
    attemptCount,
  };
}

function metadataPage(): PageFetchResult {
  return {
    status: "ok",
    html: '<meta name="description" content="Recovered description">',
    finalUrl: "https://example.com/article",
    contentType: "text/html",
  };
}

function embeddingFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            index: 0,
            embedding: Array<number>(EMBEDDING_DIMENSIONS).fill(0),
          },
        ],
      }),
      { status: 200 },
    );
}

class FakeBackfillDb implements EnrichmentBackfillDb {
  writes = 0;
  requeuedIds: string[] = [];
  readonly embeddedIds = new Set<string>();
  readonly successes: Array<{ id: string; summary: string; origin: string }> =
    [];
  readonly failures: string[] = [];

  constructor(
    readonly due: EnrichmentItem[] = [],
    readonly exhausted: EnrichmentItem[] = [],
    readonly unembedded: UnembeddedItem[] = [],
  ) {}

  async listDueEnrichmentItems(
    limit: number,
    _now: Date,
    ids?: string[],
  ): Promise<EnrichmentItem[]> {
    const selected = ids
      ? this.due.filter((candidate) => ids.includes(candidate.id))
      : this.due;
    return selected.slice(0, limit);
  }

  async listExhaustedEnrichmentItems(limit: number): Promise<EnrichmentItem[]> {
    return this.exhausted.slice(0, limit);
  }

  async requeueExhaustedEnrichmentItems(ids: string[]): Promise<number> {
    this.writes++;
    this.requeuedIds = ids.filter((id) =>
      this.exhausted.some((candidate) => candidate.id === id),
    );
    this.due.push(
      ...this.exhausted
        .filter((candidate) => this.requeuedIds.includes(candidate.id))
        .map((candidate) => ({ ...candidate, attemptCount: 0 })),
    );
    return this.requeuedIds.length;
  }

  async listUnembeddedItems(): Promise<UnembeddedItem[]> {
    return this.unembedded.filter(
      (candidate) => !this.embeddedIds.has(candidate.id),
    );
  }

  async saveEnrichedSummary(
    id: string,
    _expectedAttemptCount: number,
    summary: string,
    origin: "page_metadata" | "ai_generated",
  ): Promise<boolean> {
    this.writes++;
    this.successes.push({ id, summary, origin });
    this.unembedded.push({
      id,
      title: `Title ${id}`,
      summary,
      summaryOrigin: origin,
    });
    this.due.splice(
      this.due.findIndex((candidate) => candidate.id === id),
      1,
    );
    return true;
  }

  async saveEnrichmentFailure(id: string): Promise<boolean> {
    this.writes++;
    this.failures.push(id);
    return true;
  }

  async saveEmbedding(id: string): Promise<boolean> {
    this.writes++;
    this.embeddedIds.add(id);
    return true;
  }
}

describe("parseBackfillArgs", () => {
  it("parses dry-run, bounded limit, retry-failed, and explicit environment", () => {
    expect(
      parseBackfillArgs([
        "--dry-run",
        "--limit=4",
        "--retry-failed",
        "--env=production",
      ]),
    ).toEqual({
      dryRun: true,
      limit: 4,
      retryFailed: true,
      environment: "production",
    });
    expect(parseBackfillArgs([]).environment).toBe("local");
  });

  it.each([["--limit=0"], ["--limit=21"], ["--other"]])(
    "rejects invalid option %s",
    (argument) => {
      expect(() => parseBackfillArgs([argument])).toThrow();
    },
  );
});

describe("runEnrichmentBackfill", () => {
  it("dry-run selects work without writes, fetching, or model calls", async () => {
    const db = new FakeBackfillDb(
      [item("pending")],
      [item("exhausted", 3)],
      [
        {
          id: "vector",
          title: "Vector title",
          summary: "Existing description",
          summaryOrigin: "ai_generated",
        },
      ],
    );
    const fetchPage = vi.fn(async () => metadataPage());
    const summarize = vi.fn(async () => "A generated summary");
    const result = await runEnrichmentBackfill(db, "test-key", {
      dryRun: true,
      retryFailed: true,
      limit: 3,
      now: () => fixedNow,
      enrichment: { fetchPage, summarize },
      embedding: { fetch: embeddingFetch() },
    });

    expect(result).toMatchObject({
      dryRun: true,
      processed: 0,
      skipped: 3,
      unresolved: 2,
      succeeded: 0,
      failed: 0,
      byOrigin: { ai_generated: 1 },
    });
    expect(db.writes).toBe(0);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("respects a limited run and resumes the remaining candidates", async () => {
    const db = new FakeBackfillDb([item("first"), item("second")]);
    const fetchPage = vi.fn(async () => metadataPage());
    const first = await runEnrichmentBackfill(db, "test-key", {
      limit: 1,
      now: () => fixedNow,
      enrichment: { fetchPage },
      embedding: { fetch: embeddingFetch() },
    });

    expect(first).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(db.due.map((candidate) => candidate.id)).toEqual(["second"]);

    const second = await runEnrichmentBackfill(db, "test-key", {
      limit: 1,
      now: () => fixedNow,
      enrichment: { fetchPage },
      embedding: { fetch: embeddingFetch() },
    });
    expect(second.succeeded).toBe(1);
    expect(db.due).toEqual([]);
    expect(db.embeddedIds).toEqual(new Set(["first", "second"]));
  });

  it("explicitly requeues exhausted items only when requested", async () => {
    const db = new FakeBackfillDb([], [item("exhausted", 3)]);
    const result = await runEnrichmentBackfill(db, "test-key", {
      retryFailed: true,
      limit: 1,
      now: () => fixedNow,
      enrichment: { fetchPage: async () => metadataPage() },
      embedding: { fetch: embeddingFetch() },
    });

    expect(db.requeuedIds).toEqual(["exhausted"]);
    expect(result.succeeded).toBe(1);
  });

  it("recovers a saved description after embedding failure without refetching", async () => {
    const db = new FakeBackfillDb([item("interrupted")]);
    const fetchPage = vi.fn(async () => metadataPage());
    const summarize = vi.fn(async () => "Should not be called for metadata");
    const first = await runEnrichmentBackfill(db, "test-key", {
      limit: 1,
      now: () => fixedNow,
      enrichment: { fetchPage, summarize },
      embedding: {
        fetch: async () =>
          new Response(JSON.stringify({ error: { message: "temporary" } }), {
            status: 500,
          }),
      },
    });
    expect(first.failed).toBe(1);
    expect(db.successes).toEqual([
      {
        id: "interrupted",
        summary: "Recovered description",
        origin: "page_metadata",
      },
    ]);

    const second = await runEnrichmentBackfill(db, "test-key", {
      limit: 1,
      now: () => fixedNow,
      enrichment: {
        fetchPage: async () => {
          throw new Error("must not refetch a completed description");
        },
        summarize: async () => {
          throw new Error("must not summarize a completed description");
        },
      },
      embedding: { fetch: embeddingFetch() },
    });

    expect(second.succeeded).toBe(1);
    expect(second.byOrigin.page_metadata).toBe(1);
    expect(db.embeddedIds.has("interrupted")).toBe(true);
    expect(db.failures).toEqual([]);
  });

  it("reports outcome and provenance counts", () => {
    const text = formatBackfillResult({
      dryRun: false,
      processed: 3,
      skipped: 0,
      succeeded: 2,
      unresolved: 1,
      failed: 0,
      summaryRequests: 1,
      embedded: 2,
      embeddingFailures: [],
      byOrigin: { feed: 1, page_metadata: 1, ai_generated: 1 },
    });
    expect(text).toContain("Processed: 3");
    expect(text).toContain("Succeeded: 2");
    expect(text).toContain(
      "Provenance: feed 1, page metadata 1, AI generated 1",
    );
  });

  it("reports per-item and embedding progress without content or identifiers", async () => {
    const db = new FakeBackfillDb([item("private-id")]);
    const progress: string[] = [];

    await runEnrichmentBackfill(db, "test-key", {
      limit: 1,
      now: () => fixedNow,
      enrichment: { fetchPage: async () => metadataPage() },
      embedding: { fetch: embeddingFetch() },
      onProgress: (event) => progress.push(formatBackfillProgress(event)),
    });

    expect(progress).toEqual([
      "Selected 1 item(s): 1 due, 0 exhausted, 0 embedding recovery.",
      "Description 1/1: processing.",
      "Description 1/1: saved (page metadata).",
      "Embedding 1 item(s).",
      "Embedding complete: 1 saved, 0 batch failure(s).",
    ]);
    const output = progress.join("\n");
    expect(output).not.toContain("private-id");
    expect(output).not.toContain("example.com");
    expect(output).not.toContain("Recovered description");
  });
});
