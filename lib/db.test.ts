import { describe, expect, it } from "vitest";
import {
  createIngestDb,
  patchForOutcome,
  recordSourceOutcome,
  toContentItemRows,
  type IngestDb,
  type Source,
  type SourceStatusPatch,
} from "./db";
import type { ParsedItem } from "./normalize/parse";

function item(overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    url: "https://yle.fi/a/1",
    title: "Test item",
    summary: "A summary",
    type: "article",
    categories: ["Uutiset"],
    thumbnailUrl: null,
    publishedAt: new Date("2026-10-28T08:00:00.000Z"),
    ...overrides,
  };
}

/** In-memory fake of the {@link IngestDb} interface, recording calls. */
class FakeIngestDb implements IngestDb {
  sources: Source[] = [];
  /** URLs already stored by any source; re-inserting one conflicts. */
  existingUrls = new Set<string>();
  insertedUrls = new Set<string>();
  insertCalls: Array<{
    source: Pick<Source, "id" | "language">;
    items: ParsedItem[];
  }> = [];
  updates: Array<{ id: string; patch: SourceStatusPatch }> = [];

  async listUnembeddedItems() {
    return [];
  }

  async saveEmbedding(): Promise<boolean> {
    return false;
  }

  async listActiveSources(): Promise<Source[]> {
    return this.sources.filter((s) => s.isActive);
  }

  async insertItems(
    source: Pick<Source, "id" | "language">,
    items: ParsedItem[],
  ): Promise<number> {
    this.insertCalls.push({ source, items });
    let inserted = 0;
    for (const it of items) {
      if (!this.insertedUrls.has(it.url) && !this.existingUrls.has(it.url)) {
        this.insertedUrls.add(it.url);
        inserted++;
      }
    }
    return inserted;
  }

  async updateSource(id: string, patch: SourceStatusPatch): Promise<void> {
    this.updates.push({ id, patch });
  }
}

describe("patchForOutcome", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");

  it("marks a successful fetch, clearing the error and storing new headers", () => {
    const patch = patchForOutcome(
      {
        kind: "fetched",
        newItems: 3,
        etag: "w/abc",
        lastModified: "Wed, 28 Oct 2026 11:00:00 GMT",
      },
      now,
    );
    expect(patch).toEqual({
      lastFetchedAt: now,
      lastSuccessAt: now,
      lastError: null,
      etag: "w/abc",
      lastModified: "Wed, 28 Oct 2026 11:00:00 GMT",
    });
  });

  it("keeps the stored conditional-GET state when the server sent no headers", () => {
    const patch = patchForOutcome({ kind: "fetched", newItems: 0 }, now);
    expect(patch).toEqual({
      lastFetchedAt: now,
      lastSuccessAt: now,
      lastError: null,
    });
    expect("etag" in patch).toBe(false);
    expect("lastModified" in patch).toBe(false);
  });

  it("treats 304 as a successful fetch without touching the stored headers", () => {
    const patch = patchForOutcome({ kind: "not_modified" }, now);
    expect(patch).toEqual({
      lastFetchedAt: now,
      lastSuccessAt: now,
      lastError: null,
    });
    expect("etag" in patch).toBe(false);
    expect("lastModified" in patch).toBe(false);
  });

  it("records a fetch-phase error but keeps the conditional-GET state and last success", () => {
    const patch = patchForOutcome(
      { kind: "error", phase: "fetch", error: "HTTP 404 Not Found" },
      now,
    );
    expect(patch).toEqual({
      lastFetchedAt: now,
      lastError: "HTTP 404 Not Found",
    });
    expect("etag" in patch).toBe(false);
    expect("lastSuccessAt" in patch).toBe(false);
  });

  it("clears the conditional-GET state on a parse failure so the feed is re-fetched unconditionally", () => {
    const patch = patchForOutcome(
      { kind: "error", phase: "parse", error: "unsupported feed format" },
      now,
    );
    expect(patch).toEqual({
      lastFetchedAt: now,
      lastError: "unsupported feed format",
      etag: null,
      lastModified: null,
    });
    expect("lastSuccessAt" in patch).toBe(false);
  });

  it("uses the current time when no timestamp is given", () => {
    const before = Date.now();
    const patch = patchForOutcome({ kind: "not_modified" });
    const after = Date.now();
    expect(patch.lastFetchedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(patch.lastFetchedAt?.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("recordSourceOutcome", () => {
  it("writes one status update built from the outcome", async () => {
    const db = new FakeIngestDb();
    const now = new Date("2026-10-28T12:00:00.000Z");

    await recordSourceOutcome(
      db,
      "src-1",
      { kind: "error", phase: "fetch", error: "timed out" },
      now,
    );

    expect(db.updates).toEqual([
      {
        id: "src-1",
        patch: { lastFetchedAt: now, lastError: "timed out" },
      },
    ]);
  });
});

describe("toContentItemRows", () => {
  it("maps a parsed item to a content_items row using the source's language", () => {
    const [row] = toContentItemRows({ id: "src-1", language: "fi" }, [
      item({
        url: "https://yle.fi/a/1",
        title: "Test item",
        summary: "A summary",
        type: "video",
        categories: ["Uutiset", "Tiede"],
        thumbnailUrl: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
        publishedAt: new Date("2026-10-28T08:00:00.000Z"),
      }),
    ]);
    expect(row).toEqual({
      source_id: "src-1",
      type: "video",
      url: "https://yle.fi/a/1",
      title: "Test item",
      summary: "A summary",
      summary_origin: "feed",
      enrichment_status: "completed",
      language: "fi",
      categories: ["Uutiset", "Tiede"],
      thumbnail_url: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
      published_at: new Date("2026-10-28T08:00:00.000Z"),
    });
  });

  it("stores an empty summary as null", () => {
    const [row] = toContentItemRows({ id: "src-1", language: "en" }, [
      item({ summary: "" }),
    ]);
    expect(row?.summary).toBeNull();
  });

  it("skips items without a usable http(s) URL", () => {
    const rows = toContentItemRows({ id: "src-1", language: "en" }, [
      item({ url: "" }),
      item({ url: "mailto:someone@example.com" }),
      item({ url: "https://yle.fi/a/2" }),
    ]);
    expect(rows.map((r) => r.url)).toEqual(["https://yle.fi/a/2"]);
  });
});

describe("createIngestDb", () => {
  it("fails fast when both environment variables are missing", () => {
    expect(() => createIngestDb({})).toThrowError(
      /missing environment variables: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  it("names only the missing variable when one is present", () => {
    expect(() =>
      createIngestDb({ NEXT_PUBLIC_SUPABASE_URL: "http://x" }),
    ).toThrowError(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() =>
      createIngestDb({ SUPABASE_SERVICE_ROLE_KEY: "secret" }),
    ).toThrowError(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
