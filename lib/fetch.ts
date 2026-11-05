/**
 * Feed fetching with the guardrails from spec 001 (task 4):
 *
 *  - conditional GET using the stored `etag` / `last-modified`
 *  - a 15 s timeout covering the whole request (headers + body)
 *  - a 5 MB response size limit (enforced on the streamed body)
 *  - an identifying User-Agent
 *  - limited concurrency (default 4) when fetching several feeds
 *  - per-source error isolation: one failing feed never stops the run
 *
 * Feed URLs are admin-curated (seeded from feeds.md), so the private/internal
 * address (SSRF) block required when URLs come from users or an LLM is not
 * applied here. They are still restricted to http/https as a non-negotiable
 * security rule, and the size/timeout limits double as a slow/abusive-response
 * guard.
 */

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
  /** New `ETag` to persist for the next run. */
  etag?: string;
  /** New `Last-Modified` to persist for the next run. */
  lastModified?: string;
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

/** Raised internally when a response exceeds the size limit. */
class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`response too large: exceeds the ${maxBytes} byte limit`);
    this.name = "BodyTooLargeError";
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

/**
 * Read a response body, enforcing {@link maxBytes} on the streamed bytes.
 * Throws {@link BodyTooLargeError} once the total exceeds the limit.
 */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder("utf-8");

  // Some responses (e.g. an empty 200) expose no body stream.
  if (response.body == null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      if (signal.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value;
      total += bytes.byteLength;
      if (total > maxBytes) {
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(bytes);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be locked/errored; releasing is best-effort.
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(combined);
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

  if (!isHttpUrl(feedUrl)) {
    return { status: "error", error: `unsupported or invalid URL: ${feedUrl}` };
  }

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(feedUrl, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });

    if (response.status === 304) {
      return { status: "not_modified" };
    }
    if (!response.ok) {
      return {
        status: "error",
        error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      };
    }

    // Fast-fail on a declared size before reading the body.
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      return {
        status: "error",
        error: `response too large: ${contentLength} bytes (limit ${maxBytes})`,
      };
    }

    const body = await readBodyWithLimit(response, maxBytes, controller.signal);

    const etag = response.headers.get("etag") ?? undefined;
    const lastModified = response.headers.get("last-modified") ?? undefined;
    return {
      status: "ok",
      body,
      contentType: response.headers.get("content-type") ?? "",
      etag,
      lastModified,
    };
  } catch (error) {
    if (timedOut) {
      return { status: "error", error: `timed out after ${timeoutMs} ms` };
    }
    if (error instanceof BodyTooLargeError) {
      return { status: "error", error: error.message };
    }
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "error", error: "request aborted" };
    }
    return { status: "error", error: describeError(error) };
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
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    userAgent: options.userAgent,
  };

  const results = new Array<FetchResult>(feeds.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, feeds.length);

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= feeds.length) return;
      const feed = feeds[index];
      // fetchFeed resolves to a FetchResult (never throws), so one failure
      // cannot reject this worker or the run as a whole.
      results[index] = await fetchFeed(feed.feedUrl, {
        ...perFeed,
        etag: feed.etag,
        lastModified: feed.lastModified,
      });
    }
  });

  await Promise.all(workers);
  return results;
}
