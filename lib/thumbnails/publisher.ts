import { JSDOM } from "jsdom";
import type { PageFetchResult } from "../enrich/page.ts";
import { imageWidth, MIN_THUMBNAIL_WIDTH } from "../normalize/thumbnail.ts";

export const NASA_RELEASES_FEED_URL = "https://www.nasa.gov/news-release/feed/";

interface PreviewImage {
  url: string;
  width: number | null;
}

export interface PublisherRule {
  articleUrl: (url: URL) => boolean;
  imageUrl: (url: URL) => boolean;
  selectImage: (document: Document, page: URL, current: string | null) => PreviewImage | null;
}

export function approvedHttpsUrl(value: string, base?: URL): URL | null {
  const url = URL.parse(value, base);
  return url && url.protocol === "https:" && !url.port && !url.username && !url.password
    ? url
    : null;
}

function nasaUpload(url: URL): boolean {
  return url.hostname === "www.nasa.gov" && url.pathname.startsWith("/wp-content/uploads/");
}

function nasaImage(url: URL): boolean {
  return (
    nasaUpload(url) ||
    (url.hostname === "images-assets.nasa.gov" && url.pathname.startsWith("/image/"))
  );
}

function genericImage(url: URL): boolean {
  return /(?:^|[-_/])(?:logo|meatball|insignia|placeholder|default)(?=[-_./]|$)/i.test(
    url.pathname,
  );
}

/** NASA serves these WordPress resize variants at the requested dimensions. */
export function nasaStoredThumbnailWidth(value: string | null): number | null {
  const url = value && approvedHttpsUrl(value);
  if (!url || !nasaUpload(url) || url.searchParams.size !== 1) return null;
  const resize = /^(\d+),[1-9]\d*$/.exec(url.searchParams.get("resize") ?? "");
  return imageWidth(resize?.[1] ?? null);
}

export function openGraphImage(document: Document): PreviewImage | null {
  const meta = Array.from(document.querySelectorAll("head meta[property]"));
  const images = meta.filter((element) => element.getAttribute("property") === "og:image");
  const url = images[0]?.getAttribute("content")?.trim();
  // An ambiguous preview gives no reliable association between image and width.
  if (!url || images.length !== 1) return null;
  const width = meta.find((element) => element.getAttribute("property") === "og:image:width");
  return { url, width: imageWidth(width?.getAttribute("content") ?? null) };
}

export const NASA_RELEASES_RULE: PublisherRule = {
  articleUrl: (url) =>
    url.hostname === "www.nasa.gov" &&
    /^\/news-release\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(url.pathname),
  imageUrl: nasaImage,
  selectImage(document, page) {
    const type = document.querySelector('head meta[property="og:type"]')?.getAttribute("content");
    const release = document.querySelector("main article.type-press-release");
    if (type !== "article" || !release) return null;

    const preview = openGraphImage(document);
    const image = preview && approvedHttpsUrl(preview.url, page);
    if (!image || image.search) return null;

    // The body image often includes resize parameters. Require the same asset
    // path and the exact credit in its own media wrapper.
    const matchingMedia = Array.from(release.querySelectorAll(".hds-media-wrapper")).filter(
      (media) =>
        Array.from(media.querySelectorAll(":scope > figure img[src]")).some((element) => {
          const src = approvedHttpsUrl(element.getAttribute("src") ?? "", page);
          return src?.origin === image.origin && src.pathname === image.pathname;
        }),
    );
    if (matchingMedia.length === 0) return null;
    const nasaOnly = matchingMedia.every((media) => {
      const credits = media.querySelectorAll(":scope > figcaption .hds-credits");
      return credits.length === 1 && credits[0]?.textContent?.trim() === "Credit: NASA";
    });
    return nasaOnly ? preview : null;
  },
};

export function publisherAllowsArticle(rule: PublisherRule, value: string): boolean {
  const url = approvedHttpsUrl(value);
  return url !== null && rule.articleUrl(url);
}

export type ThumbnailLookup =
  | { status: "found"; url: string }
  | { status: "no_image" }
  | { status: "fetch_failure" };

export function selectPageThumbnail(
  rule: PublisherRule,
  page: PageFetchResult,
  current: string | null,
): ThumbnailLookup {
  if (page.status === "error") return { status: "fetch_failure" };
  const finalUrl = approvedHttpsUrl(page.finalUrl);
  if (!finalUrl || !rule.articleUrl(finalUrl)) return { status: "fetch_failure" };

  try {
    const dom = new JSDOM(page.html, { url: finalUrl.href });
    try {
      const preview = rule.selectImage(dom.window.document, finalUrl, current);
      const url = preview && approvedHttpsUrl(preview.url, finalUrl);
      if (
        url &&
        (preview.width ?? 0) >= MIN_THUMBNAIL_WIDTH &&
        rule.imageUrl(url) &&
        !genericImage(url)
      ) {
        return { status: "found", url: url.href };
      }
      return { status: "no_image" };
    } finally {
      dom.window.close();
    }
  } catch {
    return { status: "fetch_failure" };
  }
}
