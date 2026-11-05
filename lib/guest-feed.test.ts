import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guestFeedColumns, readGuestFeed, selectGuestFeed } from "./guest-feed";

function row(id: string, source = id, language = "fi", published = "2026-11-03T10:00:00Z") {
  return {
    id,
    source_id: source,
    url: `https://example.com/${id}`,
    title: id,
    summary: "A summary",
    summary_origin: "feed",
    type: "article",
    language,
    thumbnail_url: null,
    published_at: published,
    sources: { id: source, name: source },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("public feed selection", () => {
  it("alternates languages, caps at twelve, and strips non-presentation fields", () => {
    const rows = Array.from({ length: 8 }, (_, i) => [
      { ...row(`fi-${i}`), embedding: "secret", user_id: "private" },
      row(`en-${i}`, `en-${i}`, "en"),
    ])
      .flat()
      .reverse();
    const items = selectGuestFeed(rows);
    expect(items).toHaveLength(12);
    expect(items.map((item) => item.language)).toEqual(Array(6).fill(["fi", "en"]).flat());
    const firstItem = items[0];
    assert(firstItem, "Public feed must contain an item");
    expect(Object.keys(firstItem).sort()).toEqual(
      [
        "id",
        "url",
        "title",
        "summary",
        "summary_origin",
        "type",
        "language",
        "thumbnail_url",
        "published_at",
        "source_name",
      ].sort(),
    );
    expect(selectGuestFeed([...rows].reverse())).toEqual(items);
  });

  it("takes one item per source before a second and breaks source ties by source ID", () => {
    const items = selectGuestFeed([
      row("newest-a", "a", "fi", "2026-11-03T11:00:00Z"),
      row("second-a", "a"),
      row("b", "b"),
      row("c", "c"),
    ]);
    expect(items.map((item) => item.id)).toEqual(["newest-a", "b", "c", "second-a"]);
  });

  it("fills language shortages and removes duplicate IDs", () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(`en-${i}`, "en", "en"));
    const duplicate = rows[0];
    assert(duplicate, "Duplicate fixture row must exist");
    const items = selectGuestFeed([row("fi"), ...rows, duplicate]);
    expect(items).toHaveLength(12);
    expect(items.filter((item) => item.language === "fi")).toHaveLength(1);
    expect(new Set(items.map((item) => item.id)).size).toBe(12);
    expect(selectGuestFeed([])).toEqual([]);
  });

  it("sorts same-source timestamp ties by item ID and allows HTTP links", () => {
    const items = selectGuestFeed([
      row("b", "same"),
      { ...row("a", "same"), url: "http://example.com/a" },
    ]);
    expect(items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(items[0]?.url).toBe("http://example.com/a");
  });

  it("discards unsafe article URLs and removes unsafe thumbnails", () => {
    const items = selectGuestFeed([
      { ...row("bad"), url: "javascript:alert(1)" },
      { ...row("good"), thumbnail_url: "data:text/html,bad" },
    ]);
    expect(items.map((item) => item.id)).toEqual(["good"]);
    expect(items[0]?.thumbnail_url).toBeNull();
  });

  it.each([
    null,
    {},
    { ...row("x"), sources: null },
    { ...row("x"), language: "de" },
    { ...row("x"), summary: null },
    { ...row("x"), summary_origin: "unknown" },
    { ...row("x"), published_at: "invalid" },
    { ...row("x"), thumbnail_url: {} },
  ])("rejects malformed data rather than rendering partial private rows", (value) => {
    expect(() => selectGuestFeed([value])).toThrow("Malformed public feed data");
  });
});

describe("public feed reader", () => {
  function client() {
    return createClient("http://127.0.0.1:55321", "public-test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  it("reads all pages with a stable ordering and fixed upper publication bound", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(Array.from({ length: 500 }, (_, i) => row(`fi-${i}`)))),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([row("en", "en", "en")])));
    vi.stubGlobal("fetch", fetch);
    const items = await readGuestFeed(client(), "2026-11-03T12:00:00Z");
    expect(items.some((item) => item.id === "en")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [index, call] of fetch.mock.calls.entries()) {
      const url = new URL(String(call[0]));
      expect(url.searchParams.get("select")).toBe(guestFeedColumns);
      expect(url.searchParams.get("order")).toBe("published_at.desc,id.asc");
      expect(url.searchParams.get("published_at")).toBe("lte.2026-11-03T12:00:00Z");
      expect(url.searchParams.get("offset")).toBe(String(index * 500));
      expect(url.searchParams.get("limit")).toBe("500");
    }
  });

  it("handles an empty response and masks provider failure details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]")));
    expect(await readGuestFeed(client(), "2026-11-03T12:00:00Z")).toEqual([]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: "private database detail" }), { status: 403 }),
        ),
    );
    await expect(readGuestFeed(client(), "2026-11-03T12:00:00Z")).rejects.toThrow(
      "Public feed could not be loaded",
    );
  });
});
