import { describe, expect, it } from "vitest";
import { formatDescriptions } from "./export-ai-descriptions.mts";

describe("formatDescriptions", () => {
  it("includes clickable article URLs and escaped descriptions", () => {
    const report = formatDescriptions(
      [
        {
          id: "item-1",
          title: "A [title]",
          url: "https://example.com/article?source=feed",
          summary: "A description.\nAnother sentence.",
          published_at: "2026-11-16T00:00:00Z",
        },
      ],
      "2026-11-16T12:00:00Z",
    );

    expect(report).toContain("Production export: 2026-11-16T12:00:00Z");
    expect(report).toContain("1 article descriptions.");
    expect(report).toContain("## 1. A \\[title\\]");
    expect(report).toContain("Article: <https://example.com/article?source=feed>");
    expect(report).toContain("A description\\. Another sentence\\.");
  });

  it("rejects unsafe article URL schemes", () => {
    expect(() =>
      formatDescriptions(
        [
          {
            id: "item-1",
            title: "Title",
            url: "javascript:alert(1)",
            summary: "Text",
            published_at: null,
          },
        ],
        "2026-11-16T12:00:00Z",
      ),
    ).toThrow("Invalid article URL for item item-1");
  });
});
