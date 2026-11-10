import type { LookupAddress } from "node:dns";
import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import { PassThrough } from "node:stream";
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  fetchFeed,
  fetchFeeds,
} from "./fetch.ts";
import type { PinnedLookup } from "./public-http.ts";

type RequestOptions = {
  headers: Record<string, string>;
  lookup: PinnedLookup;
  signal: AbortSignal;
};

type TestResponse = PassThrough & {
  statusCode: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
};

const { lookup, request } = vi.hoisted(() => ({
  lookup: vi.fn<(host: string) => Promise<LookupAddress[]>>(),
  request:
    vi.fn<
      (
        url: URL,
        options: RequestOptions,
        onResponse: (response: TestResponse) => void,
      ) => EventEmitter
    >(),
}));

vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:http", () => ({ request }));
vi.mock("node:https", () => ({ request }));

const feedUrl = "https://feeds.example.com/feed";
const publicAddress = { address: "93.184.216.34", family: 4 };
const validators = { etag: '"tag-1"', lastModified: "Tue, 28 Oct 2026 12:00:00 GMT" };

interface Reply {
  statusCode?: number;
  statusMessage?: string;
  headers?: IncomingHttpHeaders;
  body?: Buffer | string;
  stall?: boolean;
}

function serve(reply: Reply | ((url: URL) => Reply)) {
  request.mockImplementation((url, { signal }, onResponse) => {
    const req = new EventEmitter();
    return Object.assign(req, {
      end() {
        const {
          body = "",
          stall,
          statusCode = 200,
          statusMessage = "",
          headers = {},
        } = typeof reply === "function" ? reply(url) : reply;
        const response = Object.assign(new PassThrough(), { statusCode, statusMessage, headers });
        const abort = () => response.destroy(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        response.once("close", () => signal.removeEventListener("abort", abort));
        onResponse(response);
        if (stall) response.write(body);
        else response.end(body);
      },
    });
  });
}

beforeEach(() => {
  request.mockReset();
  lookup.mockReset().mockResolvedValue([publicAddress]);
  serve({ body: "<rss/>", headers: { "content-type": "application/rss+xml" } });
});

describe("fetchFeed", () => {
  it("keeps the RSS/Atom headers and returns direct response validators", async () => {
    serve({
      body: "<rss/>",
      headers: {
        "content-type": "application/rss+xml",
        etag: '"tag-2"',
        "last-modified": validators.lastModified,
      },
    });
    expect(await fetchFeed(feedUrl, validators)).toEqual({
      status: "ok",
      body: "<rss/>",
      contentType: "application/rss+xml",
      etag: '"tag-2"',
      lastModified: validators.lastModified,
    });
    expect(request.mock.calls[0]?.[1].headers).toMatchObject({
      Host: "feeds.example.com",
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: expect.stringContaining("application/atom+xml"),
      "If-None-Match": validators.etag,
      "If-Modified-Since": validators.lastModified,
    });
  });

  it("accepts a direct 304 only when it sent a validator", async () => {
    serve({ statusCode: 304, headers: { "content-length": String(DEFAULT_MAX_BYTES + 1) } });
    expect(await fetchFeed(feedUrl, { etag: validators.etag })).toEqual({ status: "not_modified" });
    expect(await fetchFeed(feedUrl)).toEqual({ status: "error", error: "HTTP 304" });
  });

  it.each([
    ["relative", "/moved", "https://feeds.example.com/moved"],
    ["cross-origin", "https://cdn.example.com/moved", "https://cdn.example.com/moved"],
  ])(
    "follows a public %s redirect without validators and clears both",
    async (_, location, finalUrl) => {
      serve((url) =>
        url.pathname === "/feed"
          ? { statusCode: 302, headers: { location } }
          : {
              body: "<rss/>",
              headers: { etag: '"cdn-tag"', "last-modified": validators.lastModified },
            },
      );
      expect(await fetchFeed(feedUrl, validators)).toMatchObject({
        status: "ok",
        body: "<rss/>",
        etag: null,
        lastModified: null,
      });
      expect(request.mock.calls.map(([url]) => url.href)).toEqual([feedUrl, finalUrl]);
      expect(request.mock.calls[0]?.[1].headers["If-None-Match"]).toBe(validators.etag);
      const redirectedHeaders = request.mock.calls[1]?.[1].headers;
      expect(redirectedHeaders).not.toHaveProperty("If-None-Match");
      expect(redirectedHeaders).not.toHaveProperty("If-Modified-Since");
    },
  );

  it("rejects an unconditional 304 after a redirect", async () => {
    serve((url) =>
      url.pathname === "/feed"
        ? { statusCode: 302, headers: { location: "/moved" } }
        : { statusCode: 304 },
    );
    expect(await fetchFeed(feedUrl, validators)).toEqual({ status: "error", error: "HTTP 304" });
  });

  it.each([
    "http://127.0.0.1/private",
    "http://10.0.0.1/private",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:127.0.0.1]/private",
    "http://[fe80::1]/private",
    "http://server.internal/private",
    "https://user:pass@cdn.example.com/moved",
    "ftp://cdn.example.com/moved",
  ])("rejects %s before the initial request or a redirected connection", async (destination) => {
    expect(await fetchFeed(destination)).toMatchObject({ status: "error" });
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    serve({ statusCode: 302, headers: { location: destination } });
    expect(await fetchFeed(feedUrl)).toMatchObject({ status: "error" });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].href).toBe(feedUrl);
  });

  it.each(
    [
      [],
      [publicAddress, { address: "192.168.1.9", family: 4 }],
      [{ address: "::ffff:169.254.169.254", family: 6 }],
    ].map((addresses) => [addresses] as const),
  )("rejects blocked or empty DNS answers %j", async (addresses) => {
    lookup.mockResolvedValueOnce(addresses);
    expect(await fetchFeed(feedUrl)).toEqual({
      status: "error",
      error: "internal destination blocked",
    });
    expect(request).not.toHaveBeenCalled();

    lookup.mockResolvedValueOnce([publicAddress]).mockResolvedValueOnce(addresses);
    serve({ statusCode: 302, headers: { location: "https://cdn.example.com/moved" } });
    expect(await fetchFeed(feedUrl)).toEqual({
      status: "error",
      error: "internal destination blocked",
    });
    expect(lookup).toHaveBeenLastCalledWith("cdn.example.com", { all: true, verbatim: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("pins the first connection and redirect even if DNS changes before either connects", async () => {
    const cdnAddress = { address: "1.1.1.1", family: 4 };
    lookup.mockImplementation((host) => {
      const calls = lookup.mock.calls.filter(([name]) => name === host).length;
      return Promise.resolve([
        calls > 1
          ? { address: "127.0.0.1", family: 4 }
          : host === "feeds.example.com"
            ? publicAddress
            : cdnAddress,
      ]);
    });
    serve((url) =>
      url.hostname === "feeds.example.com"
        ? { statusCode: 302, headers: { location: "https://cdn.example.com/moved" } }
        : { body: "<rss/>" },
    );
    const send = request.getMockImplementation();
    if (!send) throw new Error("missing mock transport");
    const connected: LookupAddress[][] = [];
    request.mockImplementation((url, options, respond) => {
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        if (error) throw error;
        if (!Array.isArray(addresses)) throw new Error("expected address array");
        connected.push(addresses);
      });
      expect(options.headers.Host).toBe(url.host);
      expect(options).toMatchObject({ agent: false, rejectUnauthorized: true });
      return send(url, options, respond);
    });

    expect(await fetchFeed(feedUrl)).toMatchObject({ status: "ok" });
    expect(lookup.mock.calls.map(([host]) => host)).toEqual([
      "feeds.example.com",
      "cdn.example.com",
    ]);
    expect(connected).toEqual([[publicAddress], [cdnAddress]]);
  });

  it("follows exactly three redirects and stops a loop", async () => {
    serve((url) => {
      const hop = Number(url.pathname.slice(1)) || 0;
      return hop < 3
        ? { statusCode: 302, headers: { location: `/${hop + 1}` } }
        : { body: "<rss/>" };
    });
    expect(await fetchFeed(feedUrl)).toMatchObject({ status: "ok" });
    expect(request).toHaveBeenCalledTimes(4);

    request.mockClear();
    serve({ statusCode: 302, headers: { location: "/feed" } });
    expect(await fetchFeed(feedUrl)).toEqual({ status: "error", error: "too many redirects" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("times out during DNS without connecting", async () => {
    lookup.mockReturnValue(new Promise(() => {}));
    expect(await fetchFeed(feedUrl, { timeoutMs: 10 })).toEqual({
      status: "error",
      error: "timed out after 10 ms",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("times out while reading the final body and uses one signal across redirects", async () => {
    serve((url) =>
      url.pathname === "/feed"
        ? { statusCode: 302, headers: { location: "/moved" } }
        : { body: "<rss>", stall: true },
    );
    expect(await fetchFeed(feedUrl, { timeoutMs: 20 })).toEqual({
      status: "error",
      error: "timed out after 20 ms",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1].signal).toBe(request.mock.calls[1]?.[1].signal);
    expect(request.mock.calls[1]?.[1].signal.aborted).toBe(true);
  });

  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["deflate", deflateRawSync],
    ["br", brotliCompressSync],
    ["zstd", zstdCompressSync],
  ] as const)("decodes %s response bodies", async (encoding, compress) => {
    serve({ headers: { "content-encoding": encoding }, body: compress("<rss/>") });
    expect(await fetchFeed(feedUrl)).toMatchObject({ status: "ok", body: "<rss/>" });
  });

  it("caps compressed bytes even when Content-Length is absent", async () => {
    serve({ headers: { "content-encoding": "gzip" }, body: gzipSync("<rss/>") });
    expect(await fetchFeed(feedUrl, { maxBytes: 10 })).toEqual({
      status: "error",
      error: "response too large",
    });
  });

  it("caps decoded bytes even when the compressed body is small", async () => {
    const body = gzipSync("x".repeat(DEFAULT_MAX_BYTES + 1));
    expect(body.byteLength).toBeLessThan(DEFAULT_MAX_BYTES);
    serve({ headers: { "content-encoding": "gzip" }, body });
    expect(await fetchFeed(feedUrl)).toEqual({
      status: "error",
      error: "decoded response too large",
    });
  });

  it("rejects a declared Content-Length above the limit before the body arrives", async () => {
    serve({ headers: { "content-length": "101" }, stall: true });
    expect(await fetchFeed(feedUrl, { maxBytes: 100 })).toEqual({
      status: "error",
      error: "response too large",
    });
  });

  it("keeps the documented feed defaults", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(DEFAULT_CONCURRENCY).toBe(4);
  });
});

describe("fetchFeeds", () => {
  const feeds = Array.from({ length: 6 }, (_, index) => ({ feedUrl: `${feedUrl}/${index}` }));

  it("caps concurrency, preserves input order, and isolates a failed feed", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    lookup.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(inFlight, maxInFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return [publicAddress];
    });
    serve((url) =>
      url.pathname === "/feed/2"
        ? { statusCode: 404, statusMessage: "Not Found" }
        : { body: url.href },
    );
    const results = await fetchFeeds(feeds, { concurrency: 2 });
    expect(results).toEqual(
      feeds.map(({ feedUrl }, index) =>
        index === 2
          ? { status: "error", error: "HTTP 404 Not Found" }
          : { status: "ok", body: feedUrl, contentType: "" },
      ),
    );
    expect(maxInFlight).toBe(2);
  });
});
