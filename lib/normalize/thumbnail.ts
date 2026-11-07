export const MIN_THUMBNAIL_WIDTH = 640;
const PREFERRED_THUMBNAIL_WIDTH = 960;

export function imageWidth(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const width = Number(value);
  return Number.isSafeInteger(width) && width > 0 ? width : null;
}

export interface FeedThumbnail {
  url: string;
  width: number | null;
}

function variantKey(value: string): string {
  const url = new URL(value);
  url.hash = "";
  // Match common resize parameters and the BBC's size segment. Keep all
  // other URL components so a different image retains its publisher order.
  for (const name of ["w", "width", "h", "height"]) {
    if (imageWidth(url.searchParams.get(name)) !== null) url.searchParams.delete(name);
  }
  if (/^\d+,\d+$/.test(url.searchParams.get("resize") ?? "")) url.searchParams.delete("resize");
  if (url.hostname === "ichef.bbci.co.uk") {
    url.pathname = url.pathname.replace(/^(\/ace\/standard\/)\d+\//, "$1");
  }
  return url.href;
}

export function selectFeedThumbnail(candidates: FeedThumbnail[]): FeedThumbnail | null {
  const images = new Map<string, FeedThumbnail[]>();
  for (const candidate of candidates) {
    const key = variantKey(candidate.url);
    const variants = images.get(key) ?? [];
    variants.push(candidate);
    images.set(key, variants);
  }

  for (const variants of images.values()) {
    const suitable = variants
      .filter((candidate) => (candidate.width ?? 0) >= MIN_THUMBNAIL_WIDTH)
      .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    const chosen =
      suitable.find((candidate) => (candidate.width ?? 0) >= PREFERRED_THUMBNAIL_WIDTH) ??
      suitable.at(-1);
    if (chosen) return chosen;
  }
  return candidates.find((candidate) => candidate.width === null) ?? candidates[0] ?? null;
}
