import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cacheLife } from "next/cache";
import { readGuestFeed } from "@/lib/guest-feed";
import { GuestPreview } from "./guest-preview";

vi.mock("next/cache", () => ({ cacheLife: vi.fn() }));
vi.mock("@/lib/supabase/anonymous", () => ({ createAnonymousClient: () => ({ public: true }) }));
vi.mock("@/lib/guest-feed", () => ({ readGuestFeed: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it("renders public cards without action controls, personalized explanations, or private fields", async () => {
  vi.mocked(readGuestFeed).mockResolvedValue([{
    id: "public-item", url: "https://example.com/story", title: "A public story",
    summary: "A short summary", summary_origin: "ai_generated", type: "article",
    language: "fi", thumbnail_url: null, published_at: new Date().toISOString(),
    source_name: "Public source",
  }]);
  const html = renderToStaticMarkup(await GuestPreview());
  expect(html).toContain("A public story");
  expect(html).toContain("Public source");
  expect(html).toContain("AI summary");
  expect(html).toContain('href="https://example.com/story"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).not.toMatch(/<button|Rate this item|Similar to|Refresh feed|Load more|source_id/);
  expect(cacheLife).toHaveBeenCalledExactlyOnceWith({ stale: 300, revalidate: 1800, expire: 86400 });
  expect(readGuestFeed).toHaveBeenCalledWith({ public: true }, expect.any(String));
});

it.each(["empty", "failure"])("shows an unavailable state for %s data", async (kind) => {
  if (kind === "empty") vi.mocked(readGuestFeed).mockResolvedValue([]);
  else vi.mocked(readGuestFeed).mockRejectedValue(new Error("private provider detail"));
  const html = renderToStaticMarkup(await GuestPreview());
  expect(html).toContain("Preview temporarily unavailable.");
  expect(html).toContain("Sign in to open your feed.");
  expect(html).not.toContain("private provider detail");
});
