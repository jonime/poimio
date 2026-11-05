import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFeed } from "./parse";

/**
 * Criterion 4: parse the saved real-feed fixtures (Yle RSS, BBC RSS,
 * The Verge Atom, Hacker News RSS, YouTube Atom) and check title, URL,
 * summary, published date, categories, thumbnail, and type.
 */

const FIXTURES = new URL("../../test/fixtures/feeds/", import.meta.url);

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, FIXTURES)), "utf-8");
}

describe("parseFeed (saved fixtures)", () => {
  it("parses the Yle RSS fixture", async () => {
    const feed = await parseFeed(loadFixture("yle-latest.xml"));
    expect(feed.format).toBe("rss");
    expect(feed.title).toBe("Yle Uutiset | Tuoreimmat");
    expect(feed.items.length).toBeGreaterThan(0);

    const item = feed.items[0];
    assert(item);
    expect(item.title).toBe(
      "Trump soittaa kampanjatilaisuuksissaan Neil Youngin kappaletta, jossa arvostellaan Amerikkaa – haastettiin oikeuteen",
    );
    expect(item.url).toBe("https://yle.fi/a/74-20253769");
    expect(item.summary).toContain("edustaa kaikkea sitä, mitä Donald J. Trump ei edusta");
    expect(item.publishedAt.toISOString()).toBe("2026-10-28T12:32:10.000Z");
    expect(item.categories).toContain("Ulkomaat");
    expect(item.categories).toContain("Donald Trump");
    expect(item.thumbnailUrl).toBeNull();
    expect(item.type).toBe("article");
  });

  it("parses the BBC RSS fixture", async () => {
    const feed = await parseFeed(loadFixture("bbc-world.xml"));
    expect(feed.format).toBe("rss");
    expect(feed.title).toBe("BBC News");
    expect(feed.items.length).toBeGreaterThan(0);

    const item = feed.items[0];
    assert(item);
    expect(item.title).toBe(
      "Luxury cruise passengers stranded in Cambodia due to soaring fuel costs",
    );
    expect(item.url).toBe("https://www.bbc.co.uk/news/articles/cwj342k62exyo");
    expect(item.summary).toContain("temporary living arrangements");
    expect(item.publishedAt.toISOString()).toBe("2026-10-28T10:31:22.000Z");
    expect(item.categories).toEqual([]);
    expect(item.thumbnailUrl).toBe(
      "https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/7eaf/live/69ded4d0-d26f-11f1-a4f1-4fff2e6cf5f3.jpg",
    );
    expect(item.type).toBe("article");
  });

  it("parses The Verge Atom fixture", async () => {
    const feed = await parseFeed(loadFixture("theverge.xml"));
    expect(feed.format).toBe("atom");
    expect(feed.title).toBe("The Verge");
    expect(feed.items.length).toBeGreaterThan(0);

    const item = feed.items[0];
    assert(item);
    expect(item.title).toBe("Almost all of Amazon’s new Echo gear is available now");
    expect(item.url).toBe(
      "https://www.theverge.com/gadgets/1019686/amazon-echo-dot-studio-camera-frame-show-16-buy",
    );
    // Summary comes from the Atom <summary>, never the full <content>.
    expect(item.summary).toContain("Amazon used to blast out dozens of products onstage");
    expect(item.summary).not.toContain("Read the full story at The Verge");
    expect(item.publishedAt.toISOString()).toBe("2026-10-28T12:29:52.000Z");
    expect(item.categories).toEqual([
      "Amazon",
      "Amazon Alexa",
      "Gadgets",
      "Tech",
      "Verge Shopping",
    ]);
    expect(item.thumbnailUrl).toBeNull();
    expect(item.type).toBe("article");
  });

  it("parses the Hacker News RSS fixture with an empty summary", async () => {
    const feed = await parseFeed(loadFixture("hackernews.xml"));
    expect(feed.format).toBe("rss");
    expect(feed.items.length).toBeGreaterThan(0);

    const item = feed.items[0];
    assert(item);
    expect(item.title).toBe(
      "Ten days later, Git on macOS still trusts the compromised eMudhra certificates",
    );
    expect(item.url).toBe("https://emudhra.we-have-a-problem.com/apple.html");
    // HN descriptions are a bare "Comments" link: the summary must be empty.
    expect(item.summary).toBe("");
    expect(item.publishedAt.toISOString()).toBe("2026-10-28T11:03:40.000Z");
    expect(item.categories).toEqual([]);
    expect(item.thumbnailUrl).toBeNull();
    expect(item.type).toBe("article");
  });

  it("parses the YouTube Atom fixture as a video with thumbnail and cleaned summary", async () => {
    const feed = await parseFeed(loadFixture("youtube-engineering-explained.xml"));
    expect(feed.format).toBe("atom");
    expect(feed.title).toBe("Engineering Explained");
    expect(feed.items.length).toBeGreaterThan(0);

    const item = feed.items[0];
    assert(item);
    expect(item.title).toBe("I Fact-Checked Every Stunt in the Tesla Roadster Reveal");
    // The v parameter must survive normalization.
    expect(item.url).toBe("https://www.youtube.com/watch?v=hJSbro3EBnY");
    expect(item.type).toBe("video");
    // The summary comes from media:description with boilerplate removed.
    expect(item.summary).toContain("Tesla has unveiled the new Roadster");
    expect(item.summary).not.toMatch(/subscribe/i);
    expect(item.summary).not.toContain("amzn.to");
    expect(item.summary).not.toContain("goo.gl");
    expect(item.summary).not.toMatch(/related videos/i);
    expect(item.publishedAt.toISOString()).toBe("2026-10-23T14:00:00.000Z");
    expect(item.categories).toEqual([]);
    expect(item.thumbnailUrl).toBe("https://i1.ytimg.com/vi/hJSbro3EBnY/hqdefault.jpg");
  });
});
