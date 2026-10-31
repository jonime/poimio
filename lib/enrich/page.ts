import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import {
  DEFAULT_SUMMARY_MAX_LENGTH,
  htmlToText,
  isLinkOnly,
  truncateSummary,
} from "../normalize/text.ts";

export const PAGE_FETCH_TIMEOUT_MS = 8_000;
export const PAGE_FETCH_MAX_BYTES = 1_000_000;
export const PAGE_FETCH_MAX_REDIRECTS = 3;
export const PAGE_FETCH_CONCURRENCY = 3;
export const MAX_ARTICLE_TEXT_LENGTH = 24_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RESERVED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".test",
  ".example",
  ".invalid",
  ".onion",
];
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

export interface PageResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
}

export interface PageTransportOptions {
  maxBytes: number;
  signal: AbortSignal;
  userAgent: string;
}

export type PageResolver = (hostname: string) => Promise<LookupAddress[]>;
export type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;
export type PageTransport = (
  url: URL,
  lookup: PinnedLookup,
  options: PageTransportOptions,
) => Promise<PageResponse>;

export interface PageFetchOptions {
  resolve?: PageResolver;
  request?: PageTransport;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
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

class PageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageFetchError";
  }
}

function ipv4Number(address: string): number | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const number = Number(octet);
    if (number > 255) return null;
    value = (value * 256 + number) >>> 0;
  }
  return value;
}

function ipv6Bytes(address: string): Uint8Array | null {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (isIP(normalized) !== 6) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (half === "") return [];
    const groups = half.split(":");
    const last = groups.at(-1);
    if (last?.includes(".")) {
      const ipv4 = ipv4Number(last);
      if (ipv4 === null) return null;
      groups.splice(
        -1,
        1,
        (ipv4 >>> 16).toString(16),
        (ipv4 & 0xffff).toString(16),
      );
    }
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array<number>(missing).fill(0), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return true;
  return BLOCKED_IPV4_RANGES.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === network;
  });
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isBlockedIpv4(address);
  if (family !== 6) return false;

  const bytes = ipv6Bytes(address);
  if (bytes === null) return false;
  const mappedPrefix =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (mappedPrefix) {
    return !isBlockedIpv4(
      [bytes[12], bytes[13], bytes[14], bytes[15]].join("."),
    );
  }

  const globalUnicast = (bytes[0]! & 0xe0) === 0x20;
  const specialPurpose =
    (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2]! & 0xfe) === 0) ||
    (bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x0d &&
      bytes[3] === 0xb8) ||
    (bytes[0] === 0x20 && bytes[1] === 0x02) ||
    (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2]! & 0xf0) === 0);
  return globalUnicast && !specialPurpose;
}

function isReservedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    RESERVED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function parsePageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PageFetchError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageFetchError("unsupported URL scheme");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PageFetchError("URL credentials are not allowed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || isReservedHostname(hostname)) {
    throw new PageFetchError("internal destination blocked");
  }
  if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
    throw new PageFetchError("internal destination blocked");
  }
  return url;
}

async function resolveAddresses(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function pinnedLookup(addresses: LookupAddress[]): PinnedLookup {
  return (
    _hostname: string,
    options: LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    if (typeof options === "object" && options.all) {
      callback(null, addresses);
      return;
    }
    const address = addresses[0];
    if (!address) {
      callback(
        Object.assign(new Error("No validated address"), { code: "ENOTFOUND" }),
        "",
        0,
      );
      return;
    }
    callback(null, address.address, address.family);
  };
}

function requestPage(
  url: URL,
  lookup: PinnedLookup,
  options: PageTransportOptions,
): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        lookup,
        signal: options.signal,
        headers: {
          Accept: "text/html, application/xhtml+xml",
          "Accept-Encoding": "identity",
          Host: url.host,
          "User-Agent": options.userAgent,
        },
      },
      (response) => {
        const contentLength = Number(response.headers["content-length"]);
        if (
          Number.isFinite(contentLength) &&
          contentLength > options.maxBytes
        ) {
          response.destroy(new PageFetchError("response too large"));
          reject(new PageFetchError("response too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | Uint8Array) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.byteLength;
          if (totalBytes > options.maxBytes) {
            response.destroy(new PageFetchError("response too large"));
            reject(new PageFetchError("response too large"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", (error) => {
          reject(
            error instanceof PageFetchError
              ? error
              : new PageFetchError("request failed"),
          );
        });
      },
    );
    request.on("error", (error) => {
      reject(
        error instanceof PageFetchError
          ? error
          : options.signal.aborted
            ? new PageFetchError("request timed out")
            : new PageFetchError("request failed"),
      );
    });
    request.end();
  });
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new PageFetchError("request timed out"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new PageFetchError("request timed out"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function fetchPageHtml(
  value: string,
  options: PageFetchOptions = {},
): Promise<PageFetchResult> {
  const timeoutMs = options.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? PAGE_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? PAGE_FETCH_MAX_REDIRECTS;
  const userAgent = options.userAgent ?? "poimio/0.1 (description enrichment)";
  const resolve = options.resolve ?? resolveAddresses;
  const request = options.request ?? requestPage;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = Date.now() + timeoutMs;

  try {
    let url = parsePageUrl(value);
    let redirects = 0;

    for (;;) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = await withAbort(resolve(host), controller.signal);
      if (
        addresses.length === 0 ||
        addresses.some((entry) => !isPublicAddress(entry.address))
      ) {
        throw new PageFetchError("internal destination blocked");
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || controller.signal.aborted) {
        throw new PageFetchError("request timed out");
      }
      const response = await withAbort(
        request(url, pinnedLookup(addresses), {
          maxBytes,
          signal: controller.signal,
          userAgent,
        }),
        controller.signal,
      );
      if (controller.signal.aborted)
        throw new PageFetchError("request timed out");
      if (response.body.byteLength > maxBytes) {
        throw new PageFetchError("response too large");
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = headerValue(response.headers, "location");
        if (!location) throw new PageFetchError("redirect without a location");
        if (redirects >= maxRedirects)
          throw new PageFetchError("too many redirects");
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, url);
        } catch {
          throw new PageFetchError("invalid redirect URL");
        }
        url = parsePageUrl(nextUrl.href);
        redirects++;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new PageFetchError(`HTTP ${response.status}`);
      }
      const contentType = headerValue(response.headers, "content-type") ?? "";
      if (
        !/^\s*(text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(
          contentType,
        )
      ) {
        throw new PageFetchError("unsupported content type");
      }
      return {
        status: "ok",
        html: new TextDecoder("utf-8").decode(response.body),
        finalUrl: url.href,
        contentType,
      };
    }
  } catch (error) {
    const message =
      error instanceof PageFetchError ? error.message : "request failed";
    if (controller.signal.aborted)
      return { status: "error", error: "request timed out" };
    return { status: "error", error: message.slice(0, 500) };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPages(
  urls: string[],
  options: PageFetchBatchOptions = {},
): Promise<PageFetchResult[]> {
  const concurrency = Math.max(
    1,
    Math.min(
      options.concurrency ?? PAGE_FETCH_CONCURRENCY,
      PAGE_FETCH_CONCURRENCY,
    ),
  );
  const results = new Array<PageFetchResult>(urls.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, urls.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= urls.length) return;
        results[index] = await fetchPageHtml(urls[index]!, options);
      }
    },
  );
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
  if (!text) return null;
  return truncateSummary(text, DEFAULT_SUMMARY_MAX_LENGTH);
}

export function extractPageContent(
  html: string,
  pageUrl: string,
): ExtractedPageContent {
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
      articleText: articleText
        ? articleText.slice(0, MAX_ARTICLE_TEXT_LENGTH)
        : null,
    };
  } finally {
    dom.window.close();
  }
}
