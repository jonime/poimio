import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, inflateRaw, zstdDecompress } from "node:zlib";
import { fetchPublicUrl, HttpFetchError, headerValue, withAbort } from "./public-http.ts";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_USER_AGENT = "poimio/0.1 (Finnish & English news ingestion bot)";

/** A feed to fetch, plus the conditional-GET state we stored on a previous run. */
export interface FeedToFetch {
  feedUrl: string;
  etag?: string | null;
  lastModified?: string | null;
}

/**
 * Options for a single feed fetch. Omitted values fall back to the `DEFAULT_*`
 * constants above.
 */
export interface FetchOptions {
  /** Stored `ETag`; sent as `If-None-Match`. */
  etag?: string | null;
  /** Stored `Last-Modified`; sent as `If-Modified-Since`. */
  lastModified?: string | null;
  /** Whole-request timeout in milliseconds (default 15 s). */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default 5 MB). */
  maxBytes?: number;
  /** Value of the identifying `User-Agent` header. */
  userAgent?: string;
}

/** Options for {@link fetchFeeds}: per-feed options plus the concurrency cap. */
export interface FetchBatchOptions extends Omit<FetchOptions, "etag" | "lastModified"> {
  /** Maximum number of feeds fetched at once (default 4). */
  concurrency?: number;
}

/** A feed fetched successfully. */
export interface FetchOk {
  status: "ok";
  /** Raw feed body, UTF-8 decoded. */
  body: string;
  contentType: string;
  /** New `ETag` to persist, or null to clear it after a redirect. */
  etag?: string | null;
  /** New `Last-Modified` to persist, or null to clear it after a redirect. */
  lastModified?: string | null;
}

/** The server answered `304 Not Modified`; nothing new to do. */
export interface FetchNotModified {
  status: "not_modified";
}

/** The fetch failed; `error` is a human-readable reason for `sources.last_error`. */
export interface FetchFailed {
  status: "error";
  error: string;
}

export type FetchResult = FetchOk | FetchNotModified | FetchFailed;

const decompress = {
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  rawDeflate: promisify(inflateRaw),
  br: promisify(brotliDecompress),
  zstd: promisify(zstdDecompress),
};

async function decodeBody(
  body: Uint8Array,
  contentEncoding: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  let bytes = body;
  for (const coding of contentEncoding.toLowerCase().split(",").reverse()) {
    signal.throwIfAborted();
    const encoding = coding.trim();
    if (encoding === "" || encoding === "identity" || bytes.byteLength === 0) continue;

    let decode: (input: Uint8Array, options: { maxOutputLength: number }) => Promise<Buffer>;
    switch (encoding) {
      case "gzip":
      case "x-gzip":
        decode = decompress.gzip;
        break;
      case "deflate":
      case "x-deflate":
        // Some servers send raw deflate without the zlib wrapper.
        decode = ((bytes[0] ?? 0) & 15) === 8 ? decompress.deflate : decompress.rawDeflate;
        break;
      case "br":
        decode = decompress.br;
        break;
      case "zstd":
        decode = decompress.zstd;
        break;
      default:
        throw new HttpFetchError("unsupported content encoding");
    }
    try {
      bytes = await withAbort(decode(bytes, { maxOutputLength: maxBytes }), signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
        throw new HttpFetchError("decoded response too large");
      }
      throw error;
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Fetch a single feed with a conditional GET.
 *
 * This function never throws: it always resolves to a {@link FetchResult}, so a
 * failing source can be reported without stopping an ingestion run.
 */
export async function fetchFeed(feedUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  const initialHeaders: Record<string, string> = {};
  if (options.etag) initialHeaders["If-None-Match"] = options.etag;
  if (options.lastModified) initialHeaders["If-Modified-Since"] = options.lastModified;

  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { response, redirected } = await fetchPublicUrl(feedUrl, {
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "Accept-Encoding": "br, gzip, deflate, zstd",
      },
      initialHeaders,
      maxBytes,
      userAgent,
      signal,
    });

    if (response.status === 304 && !redirected && Object.keys(initialHeaders).length > 0) {
      return { status: "not_modified" };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        status: "error",
        error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      };
    }

    const body = await decodeBody(
      response.body,
      headerValue(response.headers, "content-encoding") ?? "",
      maxBytes,
      signal,
    );
    const etag = redirected ? null : (headerValue(response.headers, "etag") ?? undefined);
    const lastModified = redirected
      ? null
      : (headerValue(response.headers, "last-modified") ?? undefined);
    return {
      status: "ok",
      body,
      contentType: headerValue(response.headers, "content-type") ?? "",
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
    };
  } catch (error) {
    if (signal.aborted) return { status: "error", error: `timed out after ${timeoutMs} ms` };
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch several feeds with limited concurrency.
 *
 * Results are returned in the same order as `feeds`. Because {@link fetchFeed}
 * never throws, a single failing feed is reported as a `FetchFailed` result
 * without cancelling the others.
 */
export async function fetchFeeds(
  feeds: FeedToFetch[],
  options: FetchBatchOptions = {},
): Promise<FetchResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const perFeed: FetchOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
  };

  const results = new Array<FetchResult>(feeds.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, feeds.length);

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      const feed = feeds[index];
      if (!feed) return;
      // fetchFeed resolves to a FetchResult (never throws), so one failure
      // cannot reject this worker or the run as a whole.
      results[index] = await fetchFeed(feed.feedUrl, {
        ...perFeed,
        etag: feed.etag ?? null,
        lastModified: feed.lastModified ?? null,
      });
    }
  });

  await Promise.all(workers);
  return results;
}
