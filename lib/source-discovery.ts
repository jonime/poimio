import { FeedEntryLimitError, filterIngestionItems } from "./ingest.ts";
import type { ParsedItem } from "./normalize/parse.ts";

export type DiscoveryLanguage = "fi" | "en";
export type DiscoveryItemType = "article" | "video";
export type DiscoveryRelevance = "high" | "medium" | "low" | "not_scored";
export type DiscoveryRelevanceBasis = "all_users" | "admin";

export interface DiscoverySource {
  id: string;
  name: string;
  feedUrl: string;
  siteUrl: string | null;
  kind: "rss" | "youtube";
  language: string;
}

export interface DiscoveryFeedAssessment {
  items: ParsedItem[];
  recentDistinctCount: number;
  failure: "unsupported_language" | "feed_too_large" | "insufficient_recent_items" | null;
}

export interface DiscoveryVectorItem {
  id: string;
  url: string;
  type: DiscoveryItemType;
  language: DiscoveryLanguage;
  publishedAt: Date;
  embedding: number[];
}

export interface DiscoveryFeedback {
  userId: string;
  itemId: string;
  kind: "like" | "not_interested" | "seen";
  updatedAt: Date;
}

export interface DiscoveryClick {
  userId: string;
  itemId: string;
}

export interface DiscoveryScoreInput {
  candidateItems: DiscoveryVectorItem[];
  likeItems: DiscoveryVectorItem[];
  referenceItems: DiscoveryVectorItem[];
  allKnownUrls: ReadonlySet<string>;
  feedback: DiscoveryFeedback[];
  clicks: DiscoveryClick[];
  means: Partial<Record<DiscoveryLanguage, number[]>>;
  adminUserId: string;
  now: Date;
}

export interface DiscoveryScore {
  relevance: DiscoveryRelevance;
  relevanceBasis: DiscoveryRelevanceBasis | null;
  meanMatchShare: number | null;
  duplicateShare: number | null;
}

const DAYS = 24 * 60 * 60 * 1000;
const ARTICLE_WINDOW_DAYS = 7;
const VIDEO_WINDOW_DAYS = 30;
const ACTIVE_EMBEDDING_MODEL = "text-embedding-3-small@512";

/** Normalize feed identity without changing its path or query. */
export function normalizeSourceFeedUrl(value: string): string {
  const trimmed = value.trim();
  const parts = /^(https?):\/\/([^/?#]*)([^#]*)(?:#.*)?$/iu.exec(trimmed);
  if (!parts) throw new Error("invalid_feed_url");

  let url: URL;
  try {
    url = new URL(`${parts[1]}://${parts[2]}/`);
  } catch {
    throw new Error("invalid_feed_url");
  }
  if (url.username || url.password || !url.hostname) throw new Error("invalid_feed_url");
  return `${url.protocol}//${url.host}${parts[3] ?? ""}`;
}

function isLanguage(value: string): value is DiscoveryLanguage {
  return value === "fi" || value === "en";
}

function uniqueItems(items: ParsedItem[]): ParsedItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function isWithinWindow(date: Date, days: number, now: Date): boolean {
  const timestamp = date.getTime();
  return timestamp <= now.getTime() && timestamp >= now.getTime() - days * DAYS;
}

export function assessDiscoveryFeed(
  items: ParsedItem[],
  language: string,
  now: Date,
): DiscoveryFeedAssessment {
  if (!isLanguage(language)) {
    return { items: [], recentDistinctCount: 0, failure: "unsupported_language" };
  }

  let filtered: ParsedItem[];
  try {
    filtered = uniqueItems(filterIngestionItems(items));
  } catch (error) {
    if (error instanceof FeedEntryLimitError) {
      return { items: [], recentDistinctCount: 0, failure: "feed_too_large" };
    }
    throw error;
  }

  const recentUrls = new Set(
    filtered
      .filter(
        (item) =>
          item.feedPublishedAt !== null &&
          isWithinWindow(item.feedPublishedAt, VIDEO_WINDOW_DAYS, now),
      )
      .map((item) => item.url),
  );
  return {
    items: filtered,
    recentDistinctCount: recentUrls.size,
    failure: recentUrls.size >= 3 ? null : "insufficient_recent_items",
  };
}

function windowDays(type: DiscoveryItemType): number {
  return type === "video" ? VIDEO_WINDOW_DAYS : ARTICLE_WINDOW_DAYS;
}

function centeredSimilarity(
  left: DiscoveryVectorItem,
  right: DiscoveryVectorItem,
  means: Partial<Record<DiscoveryLanguage, number[]>>,
): number {
  const leftMean = means[left.language];
  const rightMean = means[right.language];
  if (!leftMean || !rightMean) throw new Error("Missing language mean for discovery score");
  if (
    left.embedding.length !== leftMean.length ||
    right.embedding.length !== rightMean.length ||
    left.embedding.length !== right.embedding.length
  ) {
    throw new Error("Discovery embeddings and language means must have matching dimensions");
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.embedding.length; index += 1) {
    const leftValue = left.embedding[index];
    const rightValue = right.embedding[index];
    const leftMeanValue = leftMean[index];
    const rightMeanValue = rightMean[index];
    if (
      leftValue === undefined ||
      rightValue === undefined ||
      leftMeanValue === undefined ||
      rightMeanValue === undefined
    ) {
      throw new Error("Discovery embedding contains a missing value");
    }
    const centeredLeft = leftValue - leftMeanValue;
    const centeredRight = rightValue - rightMeanValue;
    dot += centeredLeft * centeredRight;
    leftNorm += centeredLeft * centeredLeft;
    rightNorm += centeredRight * centeredRight;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function nearestRankPercentile(values: number[], percentile: number): number {
  if (values.length === 0) throw new Error("percentile requires at least one value");
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error("percentile must be greater than 0 and at most 1");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(percentile * sorted.length);
  const threshold = sorted[rank - 1];
  if (threshold === undefined) throw new Error("percentile rank is out of bounds");
  return threshold;
}

export function roundMatchShare(value: number): number {
  return Number((Math.round(value / 0.05) * 0.05).toFixed(2));
}

function inDiscoveryWindow(item: DiscoveryVectorItem, now: Date): boolean {
  return isWithinWindow(item.publishedAt, windowDays(item.type), now);
}

function nearestLikeSimilarity(
  item: DiscoveryVectorItem,
  likes: DiscoveryVectorItem[],
  means: Partial<Record<DiscoveryLanguage, number[]>>,
): number {
  return Math.max(...likes.map((like) => centeredSimilarity(item, like, means)));
}

interface UserMatchShare {
  userId: string;
  share: number;
}

function buildUserMatchShares(input: DiscoveryScoreInput): UserMatchShare[] {
  const itemById = new Map(
    [...input.likeItems, ...input.referenceItems, ...input.candidateItems].map((item) => [
      item.id,
      item,
    ]),
  );
  const excludedByUser = new Map<string, Set<string>>();
  const likesByUser = new Map<string, DiscoveryFeedback[]>();
  for (const event of input.feedback) {
    let excluded = excludedByUser.get(event.userId);
    if (!excluded) {
      excluded = new Set();
      excludedByUser.set(event.userId, excluded);
    }
    excluded.add(event.itemId);
    if (event.kind === "like") {
      const likes = likesByUser.get(event.userId) ?? [];
      likes.push(event);
      likesByUser.set(event.userId, likes);
    }
  }
  for (const click of input.clicks) {
    const excluded = excludedByUser.get(click.userId) ?? new Set<string>();
    excluded.add(click.itemId);
    excludedByUser.set(click.userId, excluded);
  }

  const candidateTypes = new Set(input.candidateItems.map((item) => item.type));
  const shares: UserMatchShare[] = [];
  for (const [userId, userLikes] of likesByUser) {
    const eligibleLikes = userLikes
      .filter((like) => {
        const item = itemById.get(like.itemId);
        return item !== undefined && input.means[item.language] !== undefined;
      })
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          left.itemId.localeCompare(right.itemId),
      )
      .slice(0, 200)
      .map((like) => itemById.get(like.itemId))
      .filter((item): item is DiscoveryVectorItem => item !== undefined);
    if (eligibleLikes.length < 5) continue;

    const excluded = excludedByUser.get(userId) ?? new Set<string>();
    const thresholds = new Map<DiscoveryItemType, number>();
    for (const type of candidateTypes) {
      const pool = input.referenceItems.filter(
        (item) =>
          item.type === type &&
          inDiscoveryWindow(item, input.now) &&
          !excluded.has(item.id) &&
          input.means[item.language] !== undefined,
      );
      if (pool.length === 0) break;
      const similarities = pool.map((item) =>
        nearestLikeSimilarity(item, eligibleLikes, input.means),
      );
      thresholds.set(type, nearestRankPercentile(similarities, 0.75));
    }
    if (thresholds.size !== candidateTypes.size) continue;

    const matches = input.candidateItems.filter((item) => {
      const threshold = thresholds.get(item.type);
      return (
        threshold !== undefined &&
        nearestLikeSimilarity(item, eligibleLikes, input.means) > threshold
      );
    });
    shares.push({ userId, share: matches.length / input.candidateItems.length });
  }
  return shares;
}

function scoreRelevance(
  shares: UserMatchShare[],
  adminUserId: string,
): Pick<DiscoveryScore, "relevance" | "relevanceBasis" | "meanMatchShare"> {
  const selected =
    shares.length >= 3 ? shares : shares.filter((entry) => entry.userId === adminUserId);
  if (selected.length === 0) {
    return { relevance: "not_scored", relevanceBasis: null, meanMatchShare: null };
  }

  const relevanceBasis: DiscoveryRelevanceBasis = shares.length >= 3 ? "all_users" : "admin";
  const mean = selected.reduce((sum, entry) => sum + entry.share, 0) / selected.length;
  const matchedUsers = selected.filter((entry) => entry.share >= 0.25).length;
  const matchedShare = matchedUsers / selected.length;
  const relevance =
    relevanceBasis === "admin"
      ? mean >= 0.5
        ? "high"
        : mean >= 0.25
          ? "medium"
          : "low"
      : matchedShare >= 0.5
        ? "high"
        : matchedShare >= 0.2
          ? "medium"
          : "low";

  return {
    relevance,
    relevanceBasis,
    meanMatchShare: roundMatchShare(mean),
  };
}

function scoreDuplicateShare(input: DiscoveryScoreInput): number | null {
  if (input.candidateItems.length === 0) return null;
  const duplicates = input.candidateItems.filter((candidate) => {
    if (input.allKnownUrls.has(candidate.url)) return true;
    return input.referenceItems.some(
      (reference) =>
        reference.type === candidate.type &&
        inDiscoveryWindow(reference, input.now) &&
        input.means[candidate.language] !== undefined &&
        input.means[reference.language] !== undefined &&
        centeredSimilarity(candidate, reference, input.means) >= 0.74,
    );
  });
  return roundMatchShare(duplicates.length / input.candidateItems.length);
}

export function scoreDiscoveryCandidate(input: DiscoveryScoreInput): DiscoveryScore {
  const duplicateShare = scoreDuplicateShare(input);
  if (
    input.candidateItems.length < 3 ||
    input.candidateItems.some((item) => input.means[item.language] === undefined)
  ) {
    return {
      relevance: "not_scored",
      relevanceBasis: null,
      meanMatchShare: null,
      duplicateShare,
    };
  }

  return {
    ...scoreRelevance(buildUserMatchShares(input), input.adminUserId),
    duplicateShare,
  };
}

const RELEVANCE_ORDER: Record<DiscoveryRelevance, number> = {
  high: 0,
  medium: 1,
  low: 2,
  not_scored: 3,
};

export function sortDiscoveryCandidates<
  T extends {
    relevance: DiscoveryRelevance;
    meanMatchShare: number | null;
    duplicateShare: number | null;
  },
>(candidates: T[]): T[] {
  return [...candidates].sort(
    (left, right) =>
      RELEVANCE_ORDER[left.relevance] - RELEVANCE_ORDER[right.relevance] ||
      (right.meanMatchShare ?? -1) - (left.meanMatchShare ?? -1) ||
      (left.duplicateShare ?? Number.POSITIVE_INFINITY) -
        (right.duplicateShare ?? Number.POSITIVE_INFINITY),
  );
}

export function candidateItemsForScoring(items: ParsedItem[], now: Date): ParsedItem[] {
  const withinWindow = items.filter((item) =>
    isWithinWindow(
      item.publishedAt,
      item.type === "video" ? VIDEO_WINDOW_DAYS : ARTICLE_WINDOW_DAYS,
      now,
    ),
  );
  return uniqueItems(withinWindow.filter((item) => item.summary.trim() !== ""))
    .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime())
    .slice(0, 20);
}

export function countRecentEligibleItems(items: ParsedItem[], now: Date): number {
  const cutoff = now.getTime() - VIDEO_WINDOW_DAYS * DAYS;
  return items.filter((item) => {
    const publishedAt = item.publishedAt.getTime();
    return publishedAt >= cutoff && publishedAt <= now.getTime();
  }).length;
}

export function sampleDiscoveryTitles(items: ParsedItem[], now: Date): string[] {
  return [...items]
    .filter((item) => isWithinWindow(item.publishedAt, VIDEO_WINDOW_DAYS, now))
    .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime())
    .slice(0, 5)
    .map((item) => item.title);
}

export function activeWindowDate(type: DiscoveryItemType, now: Date): Date {
  return new Date(now.getTime() - windowDays(type) * DAYS);
}

export const SOURCE_DISCOVERY_EMBEDDING_MODEL = ACTIVE_EMBEDDING_MODEL;
