import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFeed } from "../normalize/parse.ts";
import { imageWidth, selectFeedThumbnail } from "../normalize/thumbnail.ts";
import {
  approvedHttpsUrl,
  NASA_RELEASES_RULE,
  nasaStoredThumbnailWidth,
  openGraphImage,
  type PublisherRule,
  publisherAllowsArticle,
  selectPageThumbnail,
} from "./publisher.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/thumbnails/${name}`, import.meta.url), "utf8");

const nasaRelease =
  "https://www.nasa.gov/news-release/nasa-invites-media-to-northrop-grumman-crs-25-station-resupply-launch/";
const nasaImage = "https://images-assets.nasa.gov/image/iss075e0189493/iss075e0189493~large.jpg";

function page(html: string, finalUrl = nasaRelease) {
  return { status: "ok" as const, html, finalUrl, contentType: "text/html" };
}

describe("feed thumbnails", () => {
  it("chooses the smallest preferred variant and preserves order between images", async () => {
    const xml = fixture("feed-variants.xml");
    const variants = await parseFeed(xml);
    expect(variants.items[0]).toMatchObject({
      thumbnailUrl: "https://publisher.example/photo.jpg?w=960",
      thumbnailWidth: 960,
    });

    const smaller = await parseFeed(
      xml
        .replace('width="1600"', 'width="800"')
        .replace(
          'width="960" url="https://publisher.example/photo',
          'width="700" url="https://publisher.example/photo',
        ),
    );
    expect(smaller.items[0]?.thumbnailWidth).toBe(800);
  });

  it("reads Atom image enclosures and keeps an unknown thumbnail over a known small one", async () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
      <title>Example</title><entry><title>Story</title><link href="https://publisher.example/story"/>
      <media:thumbnail url="https://publisher.example/small.jpg" width="240"/>
      <media:thumbnail url="https://publisher.example/unknown.jpg"/>
      <link rel="enclosure" type="image/jpeg" href="https://publisher.example/large.jpg" width="980"/>
      </entry></feed>`;
    expect((await parseFeed(atom)).items[0]?.thumbnailUrl).toBe(
      "https://publisher.example/large.jpg",
    );
    expect(
      (await parseFeed(atom.replace('width="980"', 'width="620"'))).items[0]?.thumbnailUrl,
    ).toBe("https://publisher.example/unknown.jpg");
  });

  it("finds no thumbnails in the sampled NASA feed entries", async () => {
    const { items } = await parseFeed(fixture("nasa-missing.xml"));
    expect(items.map((item) => item.thumbnailUrl)).toEqual([null, null, null]);
    expect(items.every((item) => !publisherAllowsArticle(NASA_RELEASES_RULE, item.url))).toBe(true);
  });
});

describe("article-page thumbnails", () => {
  it("selects eligible previews from both NASA image hosts", () => {
    expect(selectPageThumbnail(NASA_RELEASES_RULE, page(fixture("nasa-valid.html")), null)).toEqual(
      {
        status: "found",
        url: nasaImage,
      },
    );
    const upload = fixture("nasa-valid-upload.html").replaceAll(
      "https://www.nasa.gov/wp-content/",
      "/wp-content/",
    );
    expect(selectPageThumbnail(NASA_RELEASES_RULE, page(upload), null)).toEqual({
      status: "found",
      url: "https://www.nasa.gov/wp-content/uploads/2026/10/mou10242026.jpg",
    });
  });

  it.each([
    ["a generic logo", () => fixture("nasa-logo.html")],
    ["a missing credit", () => fixture("nasa-no-credit.html")],
    [
      "a SpaceX credit",
      () => fixture("nasa-third-party.html").replace("type-post", "type-press-release"),
    ],
    [
      "a shared credit",
      () => fixture("nasa-valid.html").replace("Credit: NASA", "Credit: NASA/Johns Hopkins APL"),
    ],
    [
      "a credit on a different photo",
      () =>
        fixture("nasa-valid.html").replace(
          `src="${nasaImage}`,
          'src="https://images-assets.nasa.gov/image/another.jpg',
        ),
    ],
    [
      "an unapproved image host",
      () => fixture("nasa-valid.html").replaceAll("images-assets.nasa.gov", "images.example"),
    ],
    [
      "credentials in the image URL",
      () =>
        fixture("nasa-valid.html").replaceAll(
          "https://images-assets",
          "https://user:pass@images-assets",
        ),
    ],
    [
      "an undersized preview",
      () => fixture("nasa-valid.html").replace('content="1920"', 'content="639"'),
    ],
    [
      "a preview without known dimensions",
      () => fixture("nasa-valid.html").replace('property="og:image:width"', 'property="unknown"'),
    ],
    [
      "a regular NASA post",
      () => fixture("nasa-valid.html").replace("type-press-release", "type-post"),
    ],
  ])("rejects %s", (_label, html) => {
    expect(selectPageThumbnail(NASA_RELEASES_RULE, page(html()), null)).toEqual({
      status: "no_image",
    });
  });

  it("rejects a final article URL outside the rule", () => {
    expect(
      selectPageThumbnail(
        NASA_RELEASES_RULE,
        page(fixture("nasa-valid.html"), "https://science.nasa.gov/image-article/apod/"),
        null,
      ),
    ).toEqual({ status: "fetch_failure" });
  });

  it("recognizes verified legacy size URLs without guessing at other parameters", () => {
    expect(
      nasaStoredThumbnailWidth("https://www.nasa.gov/wp-content/uploads/photo.jpg?resize=300,227"),
    ).toBe(300);
    expect(nasaStoredThumbnailWidth(`${nasaImage}?w=400`)).toBeNull();
    expect(
      nasaStoredThumbnailWidth(
        "https://another.example/wp-content/uploads/photo.jpg?resize=300,227",
      ),
    ).toBeNull();
  });

  it("selects the BBC's larger advertised variant of the same photo with a fixture-only rule", async () => {
    const photoKey = (url: URL) => url.pathname.replace(/^\/ace\/standard\/\d+\//, "");
    const bbc: PublisherRule = {
      articleUrl: (url) =>
        url.hostname === "www.bbc.co.uk" && url.pathname.startsWith("/news/articles/"),
      imageUrl: (url) =>
        url.hostname === "ichef.bbci.co.uk" && url.pathname.startsWith("/ace/standard/"),
      selectImage(document, article, current) {
        const original = current === null ? null : approvedHttpsUrl(current);
        if (!original || !bbc.imageUrl(original)) return null;
        const srcset = document.querySelector("article img[srcset]")?.getAttribute("srcset") ?? "";
        const variants = srcset.split(",").flatMap((entry) => {
          const [value, size] = entry.trim().split(/\s+/);
          const url = value && approvedHttpsUrl(value, article);
          return url && bbc.imageUrl(url) && photoKey(url) === photoKey(original)
            ? [{ url: url.href, width: imageWidth(size?.replace(/w$/, "") ?? null) }]
            : [];
        });
        return selectFeedThumbnail(variants);
      },
    };
    const item = (await parseFeed(fixture("bbc-small.xml"))).items[0];
    if (!item?.thumbnailUrl) throw new Error("Missing BBC fixture item");
    expect(item.thumbnailWidth).toBe(240);
    expect(publisherAllowsArticle(NASA_RELEASES_RULE, item.url)).toBe(false);
    expect(
      selectPageThumbnail(bbc, page(fixture("bbc-article.html"), item.url), item.thumbnailUrl),
    ).toEqual({
      status: "found",
      url: item.thumbnailUrl.replace("/240/", "/976/"),
    });
  });

  it("rejects the Yle roundup even with its hosts approved in the fixture rule", () => {
    const yle: PublisherRule = {
      articleUrl: (url) => url.hostname === "yle.fi" && url.pathname.startsWith("/a/"),
      imageUrl: (url) => url.hostname === "img.img-cdn.yle.fi",
      selectImage(document) {
        // Treat the multiple story headings in this fixture as a roundup.
        if (document.querySelectorAll("article h2").length > 1) return null;
        const image = openGraphImage(document);
        const width = image?.url.match(/crop_fill,w_(\d+),h_/)?.[1];
        return image && { ...image, width: imageWidth(width ?? null) };
      },
    };
    const url = "https://yle.fi/a/74-20255658";
    const roundup = fixture("yle-roundup.html");
    expect(selectPageThumbnail(yle, page(roundup, url), null)).toEqual({ status: "no_image" });
    const singleStory = roundup.replace(/<h2.*<\/h2>\s*/, "");
    expect(selectPageThumbnail(yle, page(singleStory, url), null).status).toBe("found");
  });
});
