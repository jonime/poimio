import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const MAX_REDIRECTS = 3;

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

export interface HttpResponse {
  status: number;
  statusText?: string | undefined;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
}

export interface HttpTransportOptions {
  maxBytes: number;
  signal: AbortSignal;
  userAgent: string;
  headers: Record<string, string>;
}

export type HostResolver = (hostname: string) => Promise<LookupAddress[]>;
export type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;
export type HttpTransport = (
  url: URL,
  lookup: PinnedLookup,
  options: HttpTransportOptions,
) => Promise<HttpResponse>;

export class HttpFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpFetchError";
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
      groups.splice(-1, 1, (ipv4 >>> 16).toString(16), (ipv4 & 0xffff).toString(16));
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
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mappedPrefix) {
    return !isBlockedIpv4([bytes[12], bytes[13], bytes[14], bytes[15]].join("."));
  }

  const [first, second, third, fourth] = bytes;
  if (first === undefined || third === undefined) return false;
  const globalUnicast = (first & 0xe0) === 0x20;
  const specialPurpose =
    (first === 0x20 && second === 0x01 && (third & 0xfe) === 0) ||
    (first === 0x20 && second === 0x01 && third === 0x0d && fourth === 0xb8) ||
    (first === 0x20 && second === 0x02) ||
    (first === 0x3f && second === 0xff && (third & 0xf0) === 0);
  return globalUnicast && !specialPurpose;
}

function isReservedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    RESERVED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpFetchError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpFetchError("unsupported URL scheme");
  }
  if (url.username !== "" || url.password !== "") {
    throw new HttpFetchError("URL credentials are not allowed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || isReservedHostname(hostname)) {
    throw new HttpFetchError("internal destination blocked");
  }
  if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
    throw new HttpFetchError("internal destination blocked");
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
      callback(Object.assign(new Error("No validated address"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function requestHttp(
  url: URL,
  lookup: PinnedLookup,
  options: HttpTransportOptions,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        lookup,
        signal: options.signal,
        ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
        headers: {
          ...options.headers,
          Host: url.host,
          "User-Agent": options.userAgent,
        },
      },
      (response) => {
        const { headers, statusCode: status = 0, statusMessage: statusText } = response;
        response.on("error", reject);

        // Redirect bodies are unused. A 304 can declare a size without sending a body.
        if (REDIRECT_STATUSES.has(status) || status === 304) {
          resolve({ status, statusText, headers, body: Buffer.alloc(0) });
          response.destroy();
          return;
        }

        const contentLength = Number(headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
          reject(new HttpFetchError("response too large"));
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > options.maxBytes) {
            reject(new HttpFetchError("response too large"));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({ status, statusText, headers, body: Buffer.concat(chunks, totalBytes) });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new HttpFetchError("request timed out"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
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

interface HttpFetchOptions extends HttpTransportOptions {
  resolve?: HostResolver;
  request?: HttpTransport;
  maxRedirects?: number;
  allowUrl?: (url: URL) => boolean;
  initialHeaders?: Record<string, string>;
}

/** Fetch from validated public addresses, using a fresh pinned connection for every hop. */
export async function fetchPublicUrl(value: string, options: HttpFetchOptions) {
  const {
    signal,
    resolve = resolveAddresses,
    request = requestHttp,
    maxRedirects = MAX_REDIRECTS,
  } = options;
  let url = parseHttpUrl(value);

  for (let redirects = 0; ; redirects++) {
    if (options.allowUrl && !options.allowUrl(url)) {
      throw new HttpFetchError("destination outside publisher rule");
    }
    if (signal.aborted) throw new HttpFetchError("request timed out");

    const host = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(host);
    const addresses = family ? [{ address: host, family }] : await withAbort(resolve(host), signal);
    if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new HttpFetchError("internal destination blocked");
    }

    if (signal.aborted) throw new HttpFetchError("request timed out");
    const response = await withAbort(
      request(url, pinnedLookup(addresses), {
        maxBytes: options.maxBytes,
        signal,
        userAgent: options.userAgent,
        headers:
          redirects === 0 ? { ...options.headers, ...options.initialHeaders } : options.headers,
      }),
      signal,
    );
    if (response.body.byteLength > options.maxBytes) {
      throw new HttpFetchError("response too large");
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: url.href, redirected: redirects > 0 };
    }

    const location = headerValue(response.headers, "location");
    if (!location) throw new HttpFetchError("redirect without a location");
    if (redirects >= maxRedirects) throw new HttpFetchError("too many redirects");
    const nextUrl = URL.parse(location, url);
    if (!nextUrl) throw new HttpFetchError("invalid redirect URL");
    url = parseHttpUrl(nextUrl.href);
  }
}
