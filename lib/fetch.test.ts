import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  type FeedToFetch,
  fetchFeed,
  fetchFeeds,
} from "./fetch";

interface ResponseInit {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

function makeResponse(init: ResponseInit = {}): Response {
  // 304/204/205 responses must have a null body; default to null so those
  // statuses can be constructed, and let tests pass an explicit body otherwise.
  const defaultBody = init.status === 304 || init.status === 204 || init.status === 205 ? null : "";
  return new Response(init.body ?? defaultBody, {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: init.headers,
  });
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A `fetch` mock that records its calls and serves a fixed 200 by default. */
function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const mock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      makeResponse({
        status: 200,
        body: "<rss/>",
        headers: {
          "content-type": "application/rss+xml",
          etag: "new-etag",
          "last-modified": "Wed, 28 Oct 2026 10:00:00 GMT",
        },
      }),
    );
  });
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchFeed", () => {
  it("returns the body, content type, etag and last-modified on 200", async () => {
    const { mock } = captureFetch();
    vi.stubGlobal("fetch", mock);

    const result = await fetchFeed("https://example.com/feed");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.body).toBe("<rss/>");
    expect(result.contentType).toBe("application/rss+xml");
    expect(result.etag).toBe("new-etag");
    expect(result.lastModified).toBe("Wed, 28 Oct 2026 10:00:00 GMT");
  });

  it("sends an identifying User-Agent and conditional-GET headers", async () => {
    const { mock, calls } = captureFetch();
    vi.stubGlobal("fetch", mock);

    await fetchFeed("https://example.com/feed", {
      etag: "stored-etag",
      lastModified: "Tue, 27 Oct 2026 08:00:00 GMT",
      userAgent: "custom-agent/1.0",
    });

    const init = calls[0]?.init as RequestInit;
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("custom-agent/1.0");
    expect(headers["If-None-Match"]).toBe("stored-etag");
    expect(headers["If-Modified-Since"]).toBe("Tue, 27 Oct 2026 08:00:00 GMT");
  });

  it("uses the default identifying User-Agent when none is given", async () => {
    const { mock, calls } = captureFetch();
    vi.stubGlobal("fetch", mock);

    await fetchFeed("https://example.com/feed");

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("User-Agent")).toBe(DEFAULT_USER_AGENT);
    // No stored state: no conditional-GET headers.
    expect(headers.get("If-None-Match")).toBeNull();
    expect(headers.get("If-Modified-Since")).toBeNull();
  });

  it("returns not_modified on 304", async () => {
    const mock = vi.fn(() => Promise.resolve(makeResponse({ status: 304 })));
    vi.stubGlobal("fetch", mock);

    const result = await fetchFeed("https://example.com/feed", {
      etag: "stored-etag",
    });

    expect(result.status).toBe("not_modified");
  });

  it("reports a non-2xx status as an error", async () => {
    const mock = vi.fn(() =>
      Promise.resolve(makeResponse({ status: 500, statusText: "Internal Server Error" })),
    );
    vi.stubGlobal("fetch", mock);

    const result = await fetchFeed("https://example.com/feed");

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.error).toContain("500");
  });

  it("times out when the request does not complete in time", async () => {
    const mock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
          // Never resolves on its own: only the abort ends it.
        }),
    );
    vi.stubGlobal("fetch", mock);

    const startedAt = Date.now();
    const result = await fetchFeed("https://example.com/feed", {
      timeoutMs: 20,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.error).toContain("timed out");
    // The timeout fires before any realistic network delay.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("reports a rejected fetch (e.g. DNS/network) as an error", async () => {
    const mock = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    vi.stubGlobal("fetch", mock);

    const result = await fetchFeed("https://missing.example.com/feed");

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.error).toContain("fetch failed");
  });

  it("enforces the size limit on a streamed body", async () => {
    const big = new Uint8Array(20).fill(65); // 20 bytes
    const mock = vi.fn(() => Promise.resolve(makeResponse({ body: streamFrom(big) })));
    vi.stubGlobal("fetch", mock);

    const result = await fetchFeed("https://example.com/feed", {
      maxBytes: 10,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.error).toContain("too large");
  });

  it("fast-fails when Content-Length already exceeds the limit", async () => {
    const mock = vi.fn(() =>
      Promise.resolve(
        makeResponse({
          body: "small",
          headers: { "content-length": "1000000" },
        }),
      ),
    );
    vi.stubGlobal("fetch", mock);

    const result = await fetchFeed("https://example.com/feed", {
      maxBytes: 100,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.error).toContain("too large");
  });

  it("rejects non-http(s) URLs without calling fetch", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);

    const result = await fetchFeed("ftp://example.com/feed");

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.error).toContain("unsupported or invalid URL");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("fetchFeeds", () => {
  const feeds: FeedToFetch[] = Array.from({ length: 6 }, (_, i) => ({
    feedUrl: `https://example.com/feed${i}`,
  }));

  it("fetches every feed and preserves input order", async () => {
    const { mock } = captureFetch();
    vi.stubGlobal("fetch", mock);

    const results = await fetchFeeds(feeds);

    expect(results).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(results[i].status).toBe("ok");
    }
    expect(mock).toHaveBeenCalledTimes(6);
  });

  it("caps concurrency at the requested value", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const mock = vi.fn(
      (input: string | URL | Request) =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve(makeResponse({ body: `body for ${String(input)}` }));
          }, 25);
        }),
    );
    vi.stubGlobal("fetch", mock);

    const results = await fetchFeeds(feeds, { concurrency: 2 });

    expect(results).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(1);
  });

  it("isolates a failing feed without stopping the rest", async () => {
    const mock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("feed2")) {
        return Promise.reject(new TypeError("network down"));
      }
      return Promise.resolve(makeResponse({ body: `body for ${url}` }));
    });
    vi.stubGlobal("fetch", mock);

    const results = await fetchFeeds(feeds);

    expect(results).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      const result = results[i];
      if (i === 2) {
        expect(result.status).toBe("error");
        if (result.status !== "error") throw new Error("expected error");
        expect(result.error).toContain("network down");
      } else {
        expect(result.status).toBe("ok");
      }
    }
  });
});

describe("defaults", () => {
  it("exposes the documented defaults", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(DEFAULT_CONCURRENCY).toBe(4);
    expect(DEFAULT_USER_AGENT).toBeTruthy();
  });
});
