/**
 * URL normalization for feed items (spec 001, task 5).
 *
 * Rules (design.md §1.3): lowercase scheme/host, drop the fragment, drop
 * tracking parameters (`utm_*`, `origin`, `at_medium`, `at_campaign`,
 * `fbclid`, `gclid`), and keep everything else — including the `v` parameter
 * that identifies a YouTube video.
 */

/** Exact-match query parameters dropped by {@link normalizeUrl}. */
const DROPPED_PARAM_NAMES = new Set(["origin", "at_medium", "at_campaign", "fbclid", "gclid"]);

/**
 * Normalize a URL for storage and deduplication.
 *
 * The WHATWG `URL` class already lowercases the scheme and host, so we only
 * need to clear the fragment and remove tracking parameters. Input that is
 * not a valid http(s) URL is returned trimmed but otherwise unchanged, so a
 * malformed feed link is never silently rewritten into a different shape.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return trimmed;
  }

  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (name.startsWith("utm_") || DROPPED_PARAM_NAMES.has(name.toLowerCase())) {
      url.searchParams.delete(name);
    }
  }
  return url.toString();
}
