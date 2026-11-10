import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import {
  DEFAULT_SUMMARY_MAX_LENGTH,
  htmlToText,
  isLinkOnly,
  truncateSummary,
} from "../normalize/text.ts";

import {
  fetchPublicUrl,
  type HostResolver,
  HttpFetchError,
  type HttpTransport,
  headerValue,
  MAX_REDIRECTS,
} from "../public-http.ts";

export type {
  HttpResponse as PageResponse,
  HttpTransport as PageTransport,
  HttpTransportOptions as PageTransportOptions,
  PinnedLookup,
} from "../public-http.ts";

export const PAGE_FETCH_TIMEOUT_MS = 8_000;
export const PAGE_FETCH_MAX_BYTES = 1_000_000;
export const PAGE_FETCH_MAX_REDIRECTS = MAX_REDIRECTS;
export const PAGE_FETCH_CONCURRENCY = 3;
export const MAX_ARTICLE_TEXT_LENGTH = 24_000;
export const SITE_WIDE_DESCRIPTIONS = ["Uutiset nopeasti ja luotettavasti."];

export interface PageFetchOptions {
  resolve?: HostResolver;
  request?: HttpTransport;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  allowUrl?: (url: URL) => boolean;
}

export interface PageFetchBatchOptions extends PageFetchOptions {
  concurrency?: number;
}

export type PageFetchResult =
  | { status: "ok"; html: string; finalUrl: string; contentType: string }
  | { status: "error"; error: string };

export interface ExtractedPageContent {
  description: string | null;
  articleText: string | null;
}

export async function fetchPageHtml(
  value: string,
  options: PageFetchOptions = {},
): Promise<PageFetchResult> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS);
  try {
    const { response, finalUrl } = await fetchPublicUrl(value, {
      ...options,
      maxBytes: options.maxBytes ?? PAGE_FETCH_MAX_BYTES,
      maxRedirects: options.maxRedirects ?? PAGE_FETCH_MAX_REDIRECTS,
      userAgent: options.userAgent ?? "poimio/0.1 (description enrichment)",
      headers: {
        Accept: "text/html, application/xhtml+xml",
        "Accept-Encoding": "identity",
      },
      signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new HttpFetchError(`HTTP ${response.status}`);
    }
    const contentType = headerValue(response.headers, "content-type") ?? "";
    if (!/^\s*(text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(contentType)) {
      throw new HttpFetchError("unsupported content type");
    }
    return {
      status: "ok",
      html: new TextDecoder("utf-8").decode(response.body),
      finalUrl,
      contentType,
    };
  } catch (error) {
    const message = error instanceof HttpFetchError ? error.message : "request failed";
    if (signal.aborted) return { status: "error", error: "request timed out" };
    return { status: "error", error: message.slice(0, 500) };
  }
}

export async function fetchPages(
  urls: string[],
  options: PageFetchBatchOptions = {},
): Promise<PageFetchResult[]> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? PAGE_FETCH_CONCURRENCY, PAGE_FETCH_CONCURRENCY),
  );
  const results = new Array<PageFetchResult>(urls.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const url = urls[index];
      if (url === undefined) return;
      results[index] = await fetchPageHtml(url, options);
    }
  });
  await Promise.all(workers);
  return results;
}

function metaContent(
  document: Document,
  attribute: "property" | "name",
  key: string,
): string | null {
  const matching = Array.from(document.querySelectorAll("meta")).find(
    (element) => element.getAttribute(attribute)?.toLowerCase() === key,
  );
  return matching?.getAttribute("content") ?? null;
}

function normalizedDescription(candidate: string | null): string | null {
  if (candidate === null || isLinkOnly(candidate)) return null;
  const text = htmlToText(candidate).replace(/\s+/g, " ").trim();
  if (
    !text ||
    SITE_WIDE_DESCRIPTIONS.some(
      (description) =>
        text.toLowerCase().replace(/\.$/, "") === description.toLowerCase().replace(/\.$/, ""),
    )
  ) {
    return null;
  }
  return truncateSummary(text, DEFAULT_SUMMARY_MAX_LENGTH);
}

export function extractPageContent(html: string, pageUrl: string): ExtractedPageContent {
  const dom = new JSDOM(html, { url: pageUrl });
  try {
    const document = dom.window.document;
    const metadata = [
      metaContent(document, "property", "og:description"),
      metaContent(document, "name", "twitter:description"),
      metaContent(document, "name", "description"),
    ];
    for (const candidate of metadata) {
      const description = normalizedDescription(candidate);
      if (description !== null) return { description, articleText: null };
    }

    const article = new Readability(document).parse();
    const articleText = article?.content
      ? htmlToText(article.content).replace(/\s+/g, " ").trim()
      : "";
    return {
      description: null,
      articleText: articleText ? articleText.slice(0, MAX_ARTICLE_TEXT_LENGTH) : null,
    };
  } finally {
    dom.window.close();
  }
}
