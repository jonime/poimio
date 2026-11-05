import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./url";

describe("normalizeUrl", () => {
  it("drops the Yle ?origin=rss tracking parameter", () => {
    expect(normalizeUrl("https://yle.fi/a/74-20253769?origin=rss")).toBe(
      "https://yle.fi/a/74-20253769",
    );
  });

  it("drops the BBC ?at_medium=RSS&at_campaign=rss tracking parameters", () => {
    expect(
      normalizeUrl(
        "https://www.bbc.co.uk/news/articles/cwj342k62exyo?at_medium=RSS&at_campaign=rss",
      ),
    ).toBe("https://www.bbc.co.uk/news/articles/cwj342k62exyo");
  });

  it("drops utm_* parameters regardless of name suffix", () => {
    expect(
      normalizeUrl(
        "https://example.com/story?utm_source=rss&utm_medium=referral&utm_campaign=launch&utm_id=7&id=5",
      ),
    ).toBe("https://example.com/story?id=5");
  });

  it("drops fbclid and gclid", () => {
    expect(normalizeUrl("https://example.com/x?fbclid=IwAR1&gclid=abc123&keep=1")).toBe(
      "https://example.com/x?keep=1",
    );
  });

  it("strips the fragment", () => {
    expect(normalizeUrl("https://example.com/x?keep=1#section-2")).toBe(
      "https://example.com/x?keep=1",
    );
  });

  it("keeps the YouTube v parameter", () => {
    expect(normalizeUrl("https://www.youtube.com/watch?v=hJSbro3EBnY&t=10s")).toBe(
      "https://www.youtube.com/watch?v=hJSbro3EBnY&t=10s",
    );
  });

  it("keeps all other query parameters in their original order", () => {
    expect(normalizeUrl("https://example.com/x?foo=bar&baz=1&origin=rss")).toBe(
      "https://example.com/x?foo=bar&baz=1",
    );
  });

  it("lowercases the scheme and host but not the path", () => {
    expect(normalizeUrl("HTTPS://Example.COM/Path/Story#top")).toBe(
      "https://example.com/Path/Story",
    );
  });

  it("returns non-URL input trimmed but unchanged", () => {
    expect(normalizeUrl("  not a url  ")).toBe("not a url");
  });

  it("returns non-http(s) schemes unchanged", () => {
    expect(normalizeUrl("ftp://example.com/file?origin=rss")).toBe(
      "ftp://example.com/file?origin=rss",
    );
  });
});
