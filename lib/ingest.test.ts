import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EnrichmentDb, EnrichmentItem, IngestDb, Source, SourceStatusPatch } from "./db";
import type { FetchResult } from "./fetch";
import { formatIngestionSummary, type IngestionSummary, runIngestion } from "./ingest";
import type { ParsedItem } from "./normalize/parse";

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
  thumbnails: Array<{ id: string; expected: string | null; thumbnail: string | null }> = [];

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

  async insertItems(_source: Pick<Source, "id" | "language">, items: ParsedItem[]) {
    this.events.push("insert");
    this.inserted.push(items);
    return items.slice(0, this.insertCount ?? items.length).map(({ url }) => ({ id: url, url }));
  }

  async saveThumbnail(id: string, expected: string | null, thumbnail: string | null) {
    this.thumbnails.push({ id, expected, thumbnail });
    return true;
  }

  async updateSource(id: string, patch: SourceStatusPatch): Promise<void> {
    this.updates.push({ id, patch });
  }
}

describe("runIngestion", () => {
  it("excludes Shorts from the YouTube fixture before insertion", async () => {
    const db = new FakeIngestDb([source("youtube", "YouTube")]);
    const body = readFileSync(
      new URL("../test/fixtures/feeds/youtube-engineering-explained.xml", import.meta.url),
      "utf-8",
    );
    const result = await runIngestion(db, "test-key", {
      fetchBatch: async () => [{ status: "ok", body, contentType: "application/atom+xml" }],
    });

    expect(db.inserted[0]).toHaveLength(9);
    expect(
      db.inserted[0]?.every((item) => item.url.startsWith("https://www.youtube.com/watch?v=")),
    ).toBe(true);
    expect(result.sources[0]?.newItems).toBe(9);
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
          body: feedXml.replace("https://example.com/one", url.replaceAll("&", "&amp;")),
          contentType: "application/rss+xml",
        },
      ],
    });

    expect(db.inserted[0]).toHaveLength(count);
    expect(result.sources[0]?.newItems).toBe(count);
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
    expect(db.updates.map(({ id }) => id)).toEqual(["fresh", "unchanged", "failed", "malformed"]);
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

describe("scheduled article thumbnails", () => {
  const feedUrl = "https://www.nasa.gov/news-release/feed/";
  const upload = "https://www.nasa.gov/wp-content/uploads/2026/10/mou10242026.jpg";
  const thumbnailHtml = readFileSync(
    new URL("../test/fixtures/thumbnails/nasa-valid-upload.html", import.meta.url),
    "utf8",
  );
  const releaseUrl = (slug: string) => `https://www.nasa.gov/news-release/${slug}/`;
  const small = `<media:thumbnail width="300" url="${upload}?resize=300,227"/>`;
  const response = (status: number, html = thumbnailHtml) => ({
    status,
    body: new TextEncoder().encode(html),
    headers: { "content-type": "text/html" },
  });
  function feed(items: Array<{ slug: string; day: number; media?: string }>) {
    return [
      {
        status: "ok" as const,
        body: `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>NASA</title>
        ${items
          .map(
            ({ slug, day, media }) => `<item><title>${slug}</title><link>${releaseUrl(slug)}</link>
        <description>Complete feed summary.</description><pubDate>${new Date(Date.UTC(2026, 10, day)).toUTCString()}</pubDate>
        ${media ?? ""}</item>`,
          )
          .join("")}</channel></rss>`,
        contentType: "application/rss+xml",
      },
    ];
  }

  it("spends at most 20 additional requests newest first and reuses enrichment HTML", async () => {
    const db = new FakeIngestDb([{ ...source("nasa", "NASA"), feedUrl }]);
    const cachedUrl = releaseUrl("cached");
    db.enrichmentItems = [
      {
        id: cachedUrl,
        url: cachedUrl,
        title: "cached",
        summary: null,
        language: "en",
        attemptCount: 0,
      },
    ];
    const requested: string[] = [];
    const summary = await runIngestion(db, "key", {
      fetchBatch: async () =>
        feed([
          { slug: "cached", day: 1 },
          { slug: "over-budget", day: 2, media: small },
          ...Array.from({ length: 20 }, (_, index) => ({
            slug: `release-${index + 1}`,
            day: index + 3,
          })),
        ]),
      enrichment: {
        fetchPage: async () => ({
          status: "ok",
          html: `<meta property="og:description" content="Description">${thumbnailHtml}`,
          finalUrl: cachedUrl,
          contentType: "text/html",
        }),
      },
      thumbnailFetch: {
        resolve: async () => [{ address: "1.1.1.1", family: 4 }],
        request: async (url) => {
          requested.push(url.href);
          return response(200);
        },
      },
    });

    expect(summary.sources[0]?.newItems).toBe(22);
    expect(summary.enrichment.succeeded).toBe(1);
    expect(requested).toEqual(
      Array.from({ length: 20 }, (_, index) => releaseUrl(`release-${20 - index}`)),
    );
    expect(db.thumbnails).toHaveLength(21);
    expect(db.thumbnails).toContainEqual({ id: cachedUrl, expected: null, thumbnail: upload });
    expect(db.thumbnails.some(({ id }) => id === releaseUrl("over-budget"))).toBe(false);
  });

  it("omits only confirmed unsuitable thumbnails and skips known good, unknown and duplicate images", async () => {
    const db = new FakeIngestDb([{ ...source("nasa", "NASA"), feedUrl }]);
    db.insertCount = 5;
    const requested: string[] = [];
    const resolved: string[] = [];
    await runIngestion(db, "key", {
      fetchBatch: async () =>
        feed([
          { slug: "confirmed", day: 7, media: small },
          { slug: "transient", day: 7, media: small },
          { slug: "unsafe", day: 7, media: small },
          {
            slug: "good",
            day: 7,
            media: `${small}<media:thumbnail width="960" url="${upload}?resize=960,726"/>`,
          },
          { slug: "unknown", day: 7, media: small.replace('width="300"', "") },
          { slug: "duplicate", day: 7, media: small },
        ]),
      thumbnailFetch: {
        resolve: async (host) => {
          resolved.push(host);
          return [{ address: "1.1.1.1", family: 4 }];
        },
        request: async (url) => {
          requested.push(url.href);
          if (url.href === releaseUrl("transient")) return response(503);
          if (url.href === releaseUrl("unsafe")) {
            return { ...response(302), headers: { location: "https://example.com/redirected" } };
          }
          return response(200, "<html></html>");
        },
      },
    });
    expect(requested).toEqual(["confirmed", "transient", "unsafe"].map(releaseUrl));
    expect(resolved).toEqual(["www.nasa.gov", "www.nasa.gov", "www.nasa.gov"]);
    expect(db.thumbnails).toEqual([
      {
        id: releaseUrl("confirmed"),
        expected: `${upload}?resize=300,227`,
        thumbnail: null,
      },
    ]);
  });
});
