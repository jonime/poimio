import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  EnrichmentDb,
  EnrichmentItem,
  IngestDb,
  Source,
  SourceStatusPatch,
} from "./db";
import type { ParsedItem } from "./normalize/parse";
import type { FetchResult } from "./fetch";
import {
  formatIngestionSummary,
  runIngestion,
  type IngestionSummary,
} from "./ingest";

const feedXml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test</title><link>https://example.com</link>
<description>Test feed</description><item><title>One</title><link>https://example.com/one</link>
<description>Summary</description><pubDate>Tue, 28 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

function source(id: string, name: string): Source {
  return {
    id,
    name,
    feedUrl: `https://example.com/${id}.xml`,
    siteUrl: "https://example.com",
    kind: "rss",
    language: "en",
    isActive: true,
    etag: null,
    lastModified: null,
    lastFetchedAt: null,
    lastSuccessAt: null,
    lastError: null,
    createdAt: "2026-10-28T00:00:00.000Z",
  };
}

class FakeIngestDb implements IngestDb, EnrichmentDb {
  updates: Array<{ id: string; patch: SourceStatusPatch }> = [];
  inserted: ParsedItem[][] = [];
  enrichmentItems: EnrichmentItem[] = [];
  events: string[] = [];
  insertCount: number | null = null;

  constructor(readonly sources: Source[]) {}

  async listActiveSources(): Promise<Source[]> {
    return this.sources;
  }

  async listUnembeddedItems() {
    this.events.push("embeddings");
    return [];
  }

  async listDueEnrichmentItems(limit: number): Promise<EnrichmentItem[]> {
    this.events.push("enrichment");
    return this.enrichmentItems.slice(0, limit);
  }

  async saveEnrichedSummary(): Promise<boolean> {
    return true;
  }

  async saveEnrichmentFailure(): Promise<boolean> {
    return true;
  }

  async saveEmbedding(): Promise<boolean> {
    return false;
  }

  async insertItems(
    _source: Pick<Source, "id" | "language">,
    items: ParsedItem[],
  ) {
    this.events.push("insert");
    this.inserted.push(items);
    return this.insertCount ?? items.length;
  }

  async updateSource(id: string, patch: SourceStatusPatch): Promise<void> {
    this.updates.push({ id, patch });
  }
}

describe("runIngestion", () => {
  it("excludes Shorts from the YouTube fixture before insertion", async () => {
    const db = new FakeIngestDb([source("youtube", "YouTube")]);
    const body = readFileSync(
      new URL(
        "../test/fixtures/feeds/youtube-engineering-explained.xml",
        import.meta.url,
      ),
      "utf-8",
    );
    const result = await runIngestion(db, "test-key", {
      fetchBatch: async () => [
        { status: "ok", body, contentType: "application/atom+xml" },
      ],
    });

    expect(db.inserted[0]).toHaveLength(9);
    expect(
      db.inserted[0].every((item) =>
        item.url.startsWith("https://www.youtube.com/watch?v="),
      ),
    ).toBe(true);
    expect(result.sources[0].newItems).toBe(9);
  });

  it.each([
    ["https://youtube.com/shorts/abc", 0],
    ["https://m.youtube.com/shorts/abc?feature=share", 0],
    ["https://example.com/shorts/abc", 1],
    ["https://notyoutube.com/shorts/abc", 1],
    ["https://youtube.com/watch?v=abc", 1],
  ])("ingests %s as %i items", async (url, count) => {
    const db = new FakeIngestDb([source("test", "Test")]);
    const result = await runIngestion(db, "test-key", {
      fetchBatch: async () => [
        {
          status: "ok",
          body: feedXml.replace(
            "https://example.com/one",
            url.replaceAll("&", "&amp;"),
          ),
          contentType: "application/rss+xml",
        },
      ],
    });

    expect(db.inserted[0]).toHaveLength(count);
    expect(result.sources[0].newItems).toBe(count);
  });

  it("summarizes fetched, unchanged, failed, and malformed sources independently", async () => {
    const sources = [
      source("fresh", "Fresh"),
      source("unchanged", "Unchanged"),
      source("failed", "Failed"),
      source("malformed", "Malformed"),
    ];
    const db = new FakeIngestDb(sources);
    const result = await runIngestion(db, "test-key", {
      fetchBatch: async () => [
        {
          status: "ok",
          body: feedXml,
          contentType: "application/rss+xml",
          etag: "tag-1",
        },
        { status: "not_modified" },
        { status: "error", error: "HTTP 404 Not Found" },
        {
          status: "ok",
          body: "<html>not a feed</html>",
          contentType: "text/html",
        },
      ],
      now: () => new Date("2026-10-28T12:00:00.000Z"),
    });

    expect(result.sources).toEqual([
      { name: "Fresh", fetched: 1, newItems: 1, skipped: 0, errors: [] },
      { name: "Unchanged", fetched: 0, newItems: 0, skipped: 1, errors: [] },
      {
        name: "Failed",
        fetched: 0,
        newItems: 0,
        skipped: 0,
        errors: ["HTTP 404 Not Found"],
      },
      {
        name: "Malformed",
        fetched: 1,
        newItems: 0,
        skipped: 0,
        errors: ["unsupported feed format: expected RSS 2.0 or Atom"],
      },
    ]);
    expect(db.inserted).toHaveLength(1);
    expect(db.updates.map(({ id }) => id)).toEqual([
      "fresh",
      "unchanged",
      "failed",
      "malformed",
    ]);
    expect(result.embeddings).toEqual({ embedded: 0, failedBatches: [] });
  });

  it("retries due stored items after 304, feed errors, and duplicate-only feeds", async () => {
    const outcomes: Array<{
      name: string;
      result: FetchResult;
      insertCount: number | null;
    }> = [
      {
        name: "not modified",
        result: { status: "not_modified" },
        insertCount: null,
      },
      {
        name: "feed error",
        result: { status: "error", error: "HTTP 503" },
        insertCount: null,
      },
      {
        name: "duplicate-only feed",
        result: {
          status: "ok",
          body: feedXml,
          contentType: "application/rss+xml",
        },
        insertCount: 0,
      },
    ];

    for (const outcome of outcomes) {
      const db = new FakeIngestDb([source(outcome.name, outcome.name)]);
      db.insertCount = outcome.insertCount;
      db.enrichmentItems = [
        {
          id: "stored-unresolved",
          url: "https://example.com/stored-unresolved",
          title: "Previously stored item",
          summary: null,
          language: "en",
          attemptCount: 0,
        },
      ];
      const result = await runIngestion(db, "test-key", {
        fetchBatch: async () => [outcome.result],
        now: () => new Date("2026-10-31T12:00:00.000Z"),
        enrichment: {
          fetchPage: async () => ({
            status: "ok",
            html: '<meta name="description" content="Recovered summary">',
            finalUrl: "https://example.com/stored-unresolved",
            contentType: "text/html",
          }),
        },
      });

      expect(result.enrichment.succeeded).toBe(1);
      expect(db.events.slice(-2)).toEqual(["enrichment", "embeddings"]);
      if (outcome.name === "duplicate-only feed") {
        expect(result.sources[0]?.newItems).toBe(0);
      }
    }
  });
});

describe("formatIngestionSummary", () => {
  it("prints per-source counts and embedding batch failures", () => {
    const summary: IngestionSummary = {
      sources: [
        { name: "Feed A", fetched: 1, newItems: 2, skipped: 0, errors: [] },
        {
          name: "Feed B",
          fetched: 0,
          newItems: 0,
          skipped: 0,
          errors: ["HTTP 503"],
        },
      ],
      enrichment: {
        selected: 0,
        processed: 0,
        skipped: 0,
        succeeded: 0,
        unresolved: 0,
        failed: 0,
        summaryRequests: 0,
        succeededIds: [],
        byOrigin: { page_metadata: 0, ai_generated: 0 },
      },
      embeddings: {
        embedded: 2,
        failedBatches: [{ itemIds: ["item-3"], error: "temporary failure" }],
      },
    };

    expect(formatIngestionSummary(summary)).toBe(
      [
        "Ingestion summary",
        "Source | fetched | new | skipped | errors",
        "Feed A | 1 | 2 | 0 | 0",
        "Feed B | 0 | 0 | 0 | 1 (HTTP 503)",
        "Enrichment: 0 processed, 0 succeeded, 0 unresolved, 0 skipped, 0 failed (page metadata 0, AI 0, requests 0)",
        "Embedded: 2",
        "Embedding error (1 items): temporary failure",
      ].join("\n"),
    );
  });
});
