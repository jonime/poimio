import { describe, expect, it } from "vitest";
import {
  buildSnapshotManifest,
  hashSnapshotRow,
  parseSnapshotDateRange,
  requireFinalSnapshot,
  requireLocalSupabaseUrl,
  requireProductionUrl,
  validateSnapshotData,
  type SnapshotRow,
} from "./evaluation-snapshot.ts";

const source: SnapshotRow = {
  id: "source-1",
  name: "Feed",
  feed_url: "https://example.test/feed",
  site_url: null,
  kind: "rss",
  language: "en",
  is_active: true,
  etag: null,
  last_modified: null,
  last_fetched_at: null,
  last_success_at: null,
  last_error: null,
  created_at: "2026-10-01T00:00:00.000Z",
};

function item(id: string, publishedAt: string): SnapshotRow {
  return {
    id,
    source_id: source.id,
    type: "article",
    url: `https://example.test/${id}`,
    title: id,
    summary: "Summary",
    summary_origin: "feed",
    enrichment_status: "completed",
    enrichment_attempt_count: 0,
    enrichment_last_attempt_at: null,
    enrichment_next_attempt_at: null,
    enrichment_error: null,
    language: "en",
    categories: [],
    thumbnail_url: null,
    published_at: publishedAt,
    embedding: "[1,0]",
    embedding_model: "test-model",
    created_at: publishedAt,
  };
}

const means: SnapshotRow[] = [
  {
    embedding_model: "test-model",
    language: "en",
    mean: "[0,0]",
    item_count: 50,
    computed_at: "2026-10-01T00:00:00.000Z",
  },
];

const items = [
  item("item-1", "2026-10-01T00:00:00.000Z"),
  item("item-2", "2026-10-08T00:00:00.000Z"),
  item("item-3", "2026-10-16T00:00:00.000Z"),
  item("item-4", "2026-10-20T00:00:00.000Z"),
];

const dateRange = {
  from: "2026-10-01T00:00:00.000Z",
  toExclusive: "2026-11-01T00:00:00.000Z",
};

describe("evaluation snapshot", () => {
  it("hashes objects independent of property order", () => {
    expect(hashSnapshotRow({ id: "item", fields: { a: 1, b: 2 } })).toBe(
      hashSnapshotRow({ fields: { b: 2, a: 1 }, id: "item" }),
    );
  });

  it("builds chronological windows and validates a complete snapshot", () => {
    const manifest = buildSnapshotManifest({
      dateRange,
      sources: [source],
      items,
      means,
      createdAt: "2026-11-02T00:00:00.000Z",
    });

    expect(manifest.windows.feedback.itemIds).toEqual(["item-1", "item-2"]);
    expect(manifest.windows.validation.itemIds).toEqual(["item-3"]);
    expect(manifest.windows.test.itemIds).toEqual(["item-4"]);
    expect(manifest.counts.byLanguage).toEqual({ en: 4 });
    expect(manifest.provisional).toBe(false);
    expect(() =>
      validateSnapshotData({ manifest, sources: [source], items, means }),
    ).not.toThrow();
  });

  it("rejects item hashes, missing columns, and schema mismatches", () => {
    const manifest = buildSnapshotManifest({
      dateRange,
      sources: [source],
      items,
      means,
    });
    const changedItems = [...items];
    changedItems[0] = { ...changedItems[0]!, title: "tampered" };
    expect(() =>
      validateSnapshotData({
        manifest,
        sources: [source],
        items: changedItems,
        means,
      }),
    ).toThrow(/hash mismatch/u);
    expect(() =>
      validateSnapshotData({
        manifest,
        sources: [source],
        items,
        means: [{ ...means[0]!, mean: "[1,0]" }],
      }),
    ).toThrow(/mean-vector hashes/u);
    expect(() =>
      buildSnapshotManifest({
        dateRange,
        sources: [source],
        items: [{ id: "incomplete" }],
        means,
      }),
    ).toThrow(/missing columns/u);
    expect(() =>
      validateSnapshotData({
        manifest: { ...manifest, schemaVersion: 999 },
        sources: [source],
        items,
        means,
      }),
    ).toThrow(/unsupported/u);
  });

  it("requires a two-week range and restricts database URLs by operation", () => {
    expect(() => parseSnapshotDateRange("2026-10-01", "2026-10-14")).toThrow(
      /14 days/u,
    );
    expect(parseSnapshotDateRange("2026-10-01", "2026-10-16").from).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(() => requireProductionUrl("http://127.0.0.1:55321")).toThrow(
      /production URL/u,
    );
    expect(() =>
      requireLocalSupabaseUrl("https://example.supabase.co"),
    ).toThrow(/local Supabase/u);
    expect(requireLocalSupabaseUrl("http://127.0.0.1:55321").port).toBe(
      "55321",
    );
  });

  it("allows a short range only for a marked provisional snapshot", () => {
    const shortRange = {
      from: "2026-10-01T00:00:00.000Z",
      toExclusive: "2026-10-03T00:00:00.000Z",
    };
    expect(() =>
      parseSnapshotDateRange(shortRange.from, shortRange.toExclusive),
    ).toThrow(/14 days/u);
    expect(
      parseSnapshotDateRange(shortRange.from, shortRange.toExclusive, true),
    ).toEqual(shortRange);
    const shortItems = [
      item("short-1", shortRange.from),
      item("short-2", "2026-10-02T00:00:00.000Z"),
    ];
    expect(() =>
      buildSnapshotManifest({
        dateRange: shortRange,
        sources: [source],
        items: shortItems,
        means,
      }),
    ).toThrow(/14 days/u);
    const provisionalManifest = buildSnapshotManifest({
      dateRange: shortRange,
      sources: [source],
      items: shortItems,
      means,
      provisional: true,
    });
    expect(provisionalManifest.provisional).toBe(true);
    expect(() => requireFinalSnapshot(provisionalManifest)).toThrow(
      /non-provisional/u,
    );
    validateSnapshotData({
      manifest: provisionalManifest,
      sources: [source],
      items: shortItems,
      means,
    });
  });
});
