import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUMMARY_MAX_LENGTH,
  decodeEntities,
  htmlToText,
  isLinkOnly,
  truncateSummary,
} from "./text";

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("R&amp;D &#8212; a &#x201C;test&#x201D; &hellip;")).toBe(
      "R&D — a “test” …",
    );
  });

  it("leaves unknown named entities as-is", () => {
    expect(decodeEntities("a &notanentity; b")).toBe("a &notanentity; b");
  });
});

describe("htmlToText", () => {
  it("strips tags, decodes entities, and collapses whitespace", () => {
    expect(htmlToText("  Hello&nbsp;world,   <b>bold</b>\ttext.  ")).toBe(
      "Hello world, bold text.",
    );
  });

  it("turns block-level markup into newlines and drops empty lines", () => {
    expect(htmlToText("<p>One.</p><p>Two.</p><p>   </p><br>Three")).toBe("One.\nTwo.\nThree");
  });

  it("discards script and style content", () => {
    expect(htmlToText('Text <script>var x = "evil";</script><style>.a{}</style> after')).toBe(
      "Text after",
    );
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("isLinkOnly", () => {
  it("detects the Hacker News Comments-only description", () => {
    expect(isLinkOnly('<a href="https://news.ycombinator.com/item?id=50271640">Comments</a>')).toBe(
      true,
    );
  });

  it("is false when there is real text alongside a link", () => {
    expect(isLinkOnly('Some text <a href="x">link</a> more')).toBe(false);
  });

  it("is false for plain text without links", () => {
    expect(isLinkOnly("Just a description.")).toBe(false);
  });
});

describe("truncateSummary", () => {
  it("keeps short summaries unchanged", () => {
    expect(truncateSummary("Short and sweet.")).toBe("Short and sweet.");
  });

  it("keeps summaries at exactly the limit unchanged", () => {
    const atLimit = "a".repeat(DEFAULT_SUMMARY_MAX_LENGTH);
    expect(truncateSummary(atLimit)).toBe(atLimit);
  });

  it("truncates long summaries at a word boundary with an ellipsis", () => {
    const long = "word ".repeat(250).trim(); // 1245 chars
    const out = truncateSummary(long);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_SUMMARY_MAX_LENGTH + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toMatch(/word…$/);
    expect(out).not.toContain("…word");
  });

  it("respects a custom limit", () => {
    expect(truncateSummary("aaaa bbbb cccc", 10)).toBe("aaaa bbbb…");
  });
});
