export interface FeedItem {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  summary_origin: "feed" | "page_metadata" | "ai_generated";
  type: "article" | "video";
  language: "fi" | "en";
  thumbnail_url: string | null;
  published_at: string;
  source_name: string;
  score: number;
  reason: "similar" | "recent";
  because_item_id: string | null;
  because_title: string | null;
}

export interface LikedFeedItem {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  summary_origin: "feed" | "page_metadata" | "ai_generated";
  type: "article" | "video";
  language: "fi" | "en";
  thumbnail_url: string | null;
  published_at: string;
  source_name: string;
  liked_at: string;
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function explanationForFeedItem(item: FeedItem): string {
  if (item.reason === "similar" && item.because_title) {
    return `Similar to ${item.because_title}, which you liked`;
  }
  return `Recent from ${item.source_name}`;
}

export function formatRelativeTime(
  publishedAt: string,
  now: Date = new Date(),
): string {
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return "Unknown time";

  const elapsedSeconds = (timestamp - now.getTime()) / 1000;
  const units = [
    { name: "year", seconds: 31_536_000 },
    { name: "month", seconds: 2_592_000 },
    { name: "week", seconds: 604_800 },
    { name: "day", seconds: 86_400 },
    { name: "hour", seconds: 3_600 },
    { name: "minute", seconds: 60 },
    { name: "second", seconds: 1 },
  ] as const;
  const unit = units.find(({ seconds }) => Math.abs(elapsedSeconds) >= seconds);
  if (!unit) return "now";

  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.round(elapsedSeconds / unit.seconds),
    unit.name,
  );
}
