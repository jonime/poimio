import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";
import {
  extractPageContent,
  fetchPageHtml,
  fetchPages,
  PAGE_FETCH_MAX_BYTES,
  type PageResponse,
  type PageTransport,
  type PinnedLookup,
} from "./page.ts";

const publicAddress: LookupAddress = {
  address: "93.184.216.34",
  family: 4,
};

function response(
  status = 200,
  headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
  },
  body = "<html><body>ok</body></html>",
): PageResponse {
  return { status, headers, body: Buffer.from(body) };
}

function options(request: PageTransport = vi.fn(async () => response())) {
  return {
    resolve: vi.fn(async () => [publicAddress]),
    request,
  };
}

describe("fetchPageHtml", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/story",
    "http://localhost/story",
    "http://127.0.0.1/story",
    "http://10.0.0.1/story",
    "http://172.16.0.1/story",
    "http://192.168.1.1/story",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/story",
    "http://[fc00::1]/story",
    "http://[fe80::1]/story",
  ])("rejects unsafe URL %s before making a request", async (url) => {
    const deps = options();
    const result = await fetchPageHtml(url, deps);
    expect(result.status).toBe("error");
    expect(deps.request).not.toHaveBeenCalled();
  });

  it("rejects URL credentials and mixed or private DNS answers before connecting", async () => {
    const credentialOptions = options();
    expect(
      (
        await fetchPageHtml(
          "https://user:pass@example.com/story",
          credentialOptions,
        )
      ).status,
    ).toBe("error");
    expect(credentialOptions.resolve).not.toHaveBeenCalled();

    const dnsOptions = options();
    dnsOptions.resolve.mockResolvedValue([
      publicAddress,
      { address: "10.0.0.3", family: 4 },
    ]);
    expect(
      (await fetchPageHtml("https://feed.example.com/story", dnsOptions))
        .status,
    ).toBe("error");
    expect(dnsOptions.request).not.toHaveBeenCalled();
  });

  it.each(["::1", "fc00::1", "fe80::1", "2001:db8::1", "::ffff:10.0.0.1"])(
    "rejects unsafe IPv6 DNS answers: %s",
    async (address) => {
      const deps = options();
      deps.resolve.mockResolvedValue([{ address, family: 6 }]);
      const result = await fetchPageHtml(
        "https://feed.example.com/story",
        deps,
      );
      expect(result.status).toBe("error");
      expect(deps.request).not.toHaveBeenCalled();
    },
  );

  it("uses the validated DNS answer without resolving again at connection time", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    let connectedAddress: string | undefined;
    const request = vi.fn(async (_url: URL, lookup: PinnedLookup) => {
      await new Promise<void>((resolveLookup, rejectLookup) => {
        lookup("feed.example.com", { family: 4 }, (error, address) => {
          if (error) rejectLookup(error);
          else {
            connectedAddress = address as string;
            resolveLookup();
          }
        });
      });
      return response();
    });

    const result = await fetchPageHtml("https://feed.example.com/story", {
      resolve,
      request,
    });

    expect(result.status).toBe("ok");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(connectedAddress).toBe(publicAddress.address);
  });

  it("validates every redirect destination before issuing its request", async () => {
    const deps = options(
      vi.fn(async () =>
        response(302, { location: "http://127.0.0.1/private" }, ""),
      ),
    );
    const result = await fetchPageHtml("https://feed.example.com/story", deps);
    expect(result.status).toBe("error");
    expect(deps.request).toHaveBeenCalledTimes(1);
  });

  it("revalidates DNS answers for redirect hosts", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([{ address: "192.168.1.2", family: 4 }]);
    const request = vi.fn(async () =>
      response(302, { location: "https://redirect.example.com/story" }, ""),
    );
    const result = await fetchPageHtml("https://feed.example.com/story", {
      resolve,
      request,
    });
    expect(result.status).toBe("error");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("pins the validated address when connecting to a redirect host", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const connectedAddresses: string[] = [];
    const request = vi.fn(async (url: URL, lookup: PinnedLookup) => {
      await new Promise<void>((resolveLookup, rejectLookup) => {
        lookup(url.hostname, { family: 4 }, (error, address) => {
          if (error) rejectLookup(error);
          else {
            connectedAddresses.push(address as string);
            resolveLookup();
          }
        });
      });
      return url.hostname === "feed.example.com"
        ? response(302, { location: "https://redirect.example.com/story" }, "")
        : response();
    });

    const result = await fetchPageHtml("https://feed.example.com/story", {
      resolve,
      request,
    });

    expect(result.status).toBe("ok");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(connectedAddresses).toEqual([
      publicAddress.address,
      publicAddress.address,
    ]);
  });

  it("enforces timeout, response-size, content-type, and redirect limits", async () => {
    const timeoutRequest = vi.fn(
      (_url, _lookup, requestOptions) =>
        new Promise<PageResponse>((_resolve, reject) => {
          requestOptions.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const timeout = await fetchPageHtml("https://feed.example.com/story", {
      ...options(timeoutRequest),
      timeoutMs: 5,
    });
    expect(timeout).toEqual({ status: "error", error: "request timed out" });

    const oversized = await fetchPageHtml("https://feed.example.com/story", {
      ...options(
        vi.fn(async () =>
          response(200, {}, "x".repeat(PAGE_FETCH_MAX_BYTES + 1)),
        ),
      ),
    });
    expect(oversized).toEqual({ status: "error", error: "response too large" });

    const wrongType = await fetchPageHtml("https://feed.example.com/story", {
      ...options(
        vi.fn(async () =>
          response(200, { "content-type": "application/json" }, "{}"),
        ),
      ),
    });
    expect(wrongType).toEqual({
      status: "error",
      error: "unsupported content type",
    });

    const redirects = await fetchPageHtml("https://feed.example.com/story", {
      ...options(vi.fn(async () => response(302, { location: "/again" }, ""))),
      maxRedirects: 1,
    });
    expect(redirects).toEqual({ status: "error", error: "too many redirects" });
  });

  it("keeps batch fetch concurrency bounded and preserves result order", async () => {
    let active = 0;
    let maxActive = 0;
    const request = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return response();
    });
    const urls = Array.from(
      { length: 8 },
      (_, index) => `https://feed${index}.example.com/story`,
    );

    const results = await fetchPages(urls, {
      ...options(request),
      concurrency: 2,
    });

    expect(results).toHaveLength(urls.length);
    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(maxActive).toBe(2);
  });
});

describe("extractPageContent", () => {
  it("uses metadata precedence and skips empty, whitespace, and link-only candidates", () => {
    const html = `
      <meta property="og:description" content="   ">
      <meta name="twitter:description" content="<a href='/comments'>Comments</a>">
      <meta name="description" content="A &amp; B <b>story</b>">
      <article><p>Article body fallback text.</p></article>`;
    expect(extractPageContent(html, "https://example.com/story")).toEqual({
      description: "A & B story",
      articleText: null,
    });
  });

  it("prefers Open Graph, then Twitter, then standard metadata", () => {
    const allUsable = `
      <meta name="description" content="Standard">
      <meta name="twitter:description" content="Twitter">
      <meta property="og:description" content="Open Graph">`;
    expect(
      extractPageContent(allUsable, "https://example.com/story").description,
    ).toBe("Open Graph");

    const noOpenGraph = `
      <meta property="og:description" content=" ">
      <meta name="twitter:description" content="Twitter">
      <meta name="description" content="Standard">`;
    expect(
      extractPageContent(noOpenGraph, "https://example.com/story").description,
    ).toBe("Twitter");
  });

  it.each([
    ["og:description", "property", "og:description"],
    ["twitter:description", "name", "twitter:description"],
    ["description", "name", "description"],
  ])("accepts %s metadata", (key, attribute, value) => {
    const html = `<meta ${attribute}="${value}" content="Useful description">`;
    expect(
      extractPageContent(html, "https://example.com/story").description,
    ).toBe("Useful description");
  });

  it("extracts bounded readable article text only when metadata is unusable", () => {
    const html = `
      <html><head><title>Article title</title>
        <meta property="og:description" content=" ">
        <meta name="twitter:description" content="<a href='/comments'>Comments</a>">
        <meta name="description" content="">
      </head><body>
        <nav>Home | News | Search</nav>
        <article><h1>Article title</h1><p>${"Readable article text. ".repeat(3000)}</p></article>
        <footer>Privacy policy</footer>
      </body></html>`;
    const content = extractPageContent(html, "https://example.com/story");
    expect(content.description).toBeNull();
    expect(content.articleText).toContain("Readable article text.");
    expect(content.articleText?.length).toBeLessThanOrEqual(24_000);
  });

  it("does not invent content for empty or unreadable pages", () => {
    expect(
      extractPageContent("<html><body></body></html>", "https://example.com/"),
    ).toEqual({
      description: null,
      articleText: null,
    });
  });
});
