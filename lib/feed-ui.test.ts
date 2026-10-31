import { describe, expect, it } from "vitest";
import {
  explanationForFeedItem,
  formatRelativeTime,
  safeHttpUrl,
  type FeedItem,
} from "./feed-ui.ts";

const item: FeedItem = {
  id: "item-1",
  url: "https://example.com/story",
  title: "A useful article",
  summary: null,
  summary_origin: "feed",
  type: "article",
  language: "en",
  thumbnail_url: null,
  published_at: "2026-10-29T11:00:00.000Z",
  source_name: "Example News",
  score: 0.9,
  reason: "similar",
  because_item_id: "liked-1",
  because_title: "A liked article",
};

describe("feed UI helpers", () => {
  it("explains similar and recent recommendations", () => {
    expect(explanationForFeedItem(item)).toBe(
      "Similar to A liked article, which you liked",
    );
    expect(
      explanationForFeedItem({
        ...item,
        reason: "recent",
        because_title: null,
      }),
    ).toBe("Recent from Example News");
  });

  it("allows only absolute HTTP and HTTPS URLs", () => {
    expect(safeHttpUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("//example.com/path")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it("formats relative time for the card", () => {
    const now = new Date("2026-10-29T12:00:00.000Z");
    expect(formatRelativeTime("2026-10-29T11:00:00.000Z", now)).toBe(
      "1 hour ago",
    );
    expect(formatRelativeTime("invalid", now)).toBe("Unknown time");
  });
});
