import { describe, expect, it } from "vitest";
import type { ParsedItem } from "./normalize/parse.ts";
import {
  assessDiscoveryFeed,
  candidateItemsForScoring,
  countRecentEligibleItems,
  type DiscoveryFeedback,
  type DiscoveryScoreInput,
  type DiscoveryVectorItem,
  nearestRankPercentile,
  normalizeSourceFeedUrl,
  roundMatchShare,
  sampleDiscoveryTitles,
  scoreDiscoveryCandidate,
  sortDiscoveryCandidates,
} from "./source-discovery.ts";

const now = new Date("2026-11-27T12:00:00.000Z");
const zeroMean = [0, 0];

function parsedItem(
  index: number,
  options: {
    type?: "article" | "video";
    daysAgo?: number;
    feedDate?: Date | null;
    url?: string;
    summary?: string;
  } = {},
): ParsedItem {
  const publishedAt = new Date(now.getTime() - (options.daysAgo ?? 1) * 86_400_000);
  return {
    url: options.url ?? `https://publisher.example/${index}`,
    title: `Title ${index}`,
    summary: options.summary ?? `Summary ${index}`,
    type: options.type ?? "article",
    categories: [],
    thumbnailUrl: null,
    publishedAt,
    feedPublishedAt: options.feedDate === undefined ? publishedAt : options.feedDate,
  };
}

function vectorItem(
  id: string,
  embedding: number[],
  options: Partial<Pick<DiscoveryVectorItem, "url" | "type" | "language" | "publishedAt">> = {},
): DiscoveryVectorItem {
  return {
    id,
    url: options.url ?? `https://publisher.example/${id}`,
    type: options.type ?? "article",
    language: options.language ?? "en",
    publishedAt: options.publishedAt ?? new Date(now.getTime() - 86_400_000),
    embedding,
  };
}

function likes(userId: string, itemIds: string[]): DiscoveryFeedback[] {
  return itemIds.map((itemId, index) => ({
    userId,
    itemId,
    kind: "like",
    updatedAt: new Date(now.getTime() - index * 1_000),
  }));
}

function scoreInput(overrides: Partial<DiscoveryScoreInput> = {}): DiscoveryScoreInput {
  const likeItems = Array.from({ length: 5 }, (_, index) => vectorItem(`like-${index}`, [1, 0]));
  const referenceItems = [
    vectorItem("reference-0", [0, 1]),
    vectorItem("reference-1", [0, 1]),
    vectorItem("reference-2", [0.2, Math.sqrt(0.96)]),
    vectorItem("reference-3", [0.3, Math.sqrt(0.91)]),
    vectorItem("reference-4", [1, 0]),
  ];
  return {
    candidateItems: Array.from({ length: 3 }, (_, index) =>
      vectorItem(`candidate-${index}`, [0.25, Math.sqrt(0.9375)]),
    ),
    likeItems,
    referenceItems,
    allKnownUrls: new Set<string>(),
    feedback: likes(
      "admin",
      likeItems.map((item) => item.id),
    ),
    clicks: [],
    means: { fi: zeroMean, en: zeroMean },
    adminUserId: "admin",
    now,
    ...overrides,
  };
}

describe("source feed URL normalization", () => {
  it("lowers the scheme and host, drops the default port and fragment, and keeps the query", () => {
    expect(normalizeSourceFeedUrl(" HTTPS://Feed.Example:443/path?x=1&Keep=2#section ")).toBe(
      "https://feed.example/path?x=1&Keep=2",
    );
    expect(normalizeSourceFeedUrl("http://feed.example:8080/a%2Fb?X=1")).toBe(
      "http://feed.example:8080/a%2Fb?X=1",
    );
  });

  it.each(["", "ftp://feed.example/rss", "https://user:pass@feed.example/rss"])(
    "rejects invalid feed URL %s",
    (url) => {
      expect(() => normalizeSourceFeedUrl(url)).toThrow("invalid_feed_url");
    },
  );
});

describe("discovery feed assessment", () => {
  it("requires three distinct recent feed dates and rejects undated, fallback, and future dates", () => {
    const dated = [
      parsedItem(1, { feedDate: new Date(now.getTime() - 29 * 86_400_000) }),
      parsedItem(2, { feedDate: new Date(now.getTime() - 2 * 86_400_000) }),
      parsedItem(3, { feedDate: new Date(now.getTime() - 1_000) }),
      parsedItem(4, { feedDate: null }),
      parsedItem(5, { feedDate: new Date(now.getTime() + 1_000) }),
      parsedItem(6, {
        url: "https://publisher.example/1",
        feedDate: new Date(now.getTime() - 5_000),
      }),
    ];
    const result = assessDiscoveryFeed(dated, "en", now);
    expect(result.failure).toBeNull();
    expect(result.recentDistinctCount).toBe(3);

    const insufficient = assessDiscoveryFeed(dated.slice(0, 2), "en", now);
    expect(insufficient.failure).toBe("insufficient_recent_items");
    expect(assessDiscoveryFeed(dated, "sv", now).failure).toBe("unsupported_language");
  });

  it("applies the 200-entry cap before URL deduplication and excludes Shorts and unusable URLs", () => {
    const oversized = Array.from({ length: 201 }, (_, index) =>
      parsedItem(index, { url: "https://publisher.example/repeated" }),
    );
    expect(assessDiscoveryFeed(oversized, "en", now).failure).toBe("feed_too_large");

    const accepted = [
      ...Array.from({ length: 200 }, (_, index) =>
        parsedItem(index, { url: "https://publisher.example/repeated" }),
      ),
      parsedItem(201, { url: "https://youtube.com/shorts/abc" }),
      parsedItem(202, { url: "mailto:story@example.com" }),
    ];
    const result = assessDiscoveryFeed(accepted, "en", now);
    expect(result.failure).toBe("insufficient_recent_items");
    expect(result.items).toHaveLength(1);
  });
});

describe("discovery scoring", () => {
  it("uses the nearest-rank percentile and preserves ties", () => {
    expect(nearestRankPercentile([0.5, 0.1, 0.2, 0.2], 0.75)).toBe(0.2);
    expect(nearestRankPercentile([0.9, 0.1, 0.5], 0.75)).toBe(0.9);
  });

  it("excludes the user's rated and opened items from the reference threshold", () => {
    const input = scoreInput({
      feedback: [
        ...likes("admin", ["like-0", "like-1", "like-2", "like-3", "like-4"]),
        {
          userId: "admin",
          itemId: "reference-4",
          kind: "seen",
          updatedAt: now,
        },
        {
          userId: "admin",
          itemId: "reference-3",
          kind: "seen",
          updatedAt: now,
        },
      ],
      clicks: [{ userId: "admin", itemId: "reference-0" }],
    });
    expect(scoreDiscoveryCandidate(input)).toMatchObject({
      relevance: "high",
      relevanceBasis: "admin",
      meanMatchShare: 1,
    });
  });

  it("uses the admin's likes alone below three scoreable users and all users at three", () => {
    const adminLikes = likes("admin", ["like-0", "like-1", "like-2", "like-3", "like-4"]);
    const otherLikes = likes("other", ["other-0", "other-1", "other-2", "other-3", "other-4"]);
    const otherItems = otherLikes.map((like) => vectorItem(like.itemId, [0, 1]));
    const twoUsers = scoreInput({
      feedback: [...adminLikes, ...otherLikes],
      likeItems: [...scoreInput().likeItems, ...otherItems],
      candidateItems: Array.from({ length: 3 }, (_, index) =>
        vectorItem(`candidate-${index}`, [1, 0]),
      ),
    });
    expect(scoreDiscoveryCandidate(twoUsers)).toMatchObject({
      relevanceBasis: "admin",
      meanMatchShare: 1,
      relevance: "high",
    });

    const thirdLikes = likes("third", ["third-0", "third-1", "third-2", "third-3", "third-4"]);
    const threeUsers = scoreInput({
      feedback: [...adminLikes, ...otherLikes, ...thirdLikes],
      candidateItems: Array.from({ length: 3 }, (_, index) =>
        vectorItem(`candidate-${index}`, [1, 0]),
      ),
      likeItems: [
        ...scoreInput().likeItems,
        ...otherItems,
        ...thirdLikes.map((like) => vectorItem(like.itemId, [1, 0])),
      ],
    });
    expect(scoreDiscoveryCandidate(threeUsers).relevanceBasis).toBe("all_users");
  });

  it.each([
    { lowThresholdUsers: 3, relevance: "high" },
    { lowThresholdUsers: 2, relevance: "medium" },
    { lowThresholdUsers: 0, relevance: "low" },
  ] as const)(
    "assigns $relevance from the share of users meeting the match threshold",
    ({ lowThresholdUsers, relevance }) => {
      const users = Array.from({ length: 5 }, (_, index) => `user-${index}`);
      const likeItems = users.flatMap((user) =>
        Array.from({ length: 5 }, (_, index) => vectorItem(`${user}-like-${index}`, [1, 0])),
      );
      const referenceItems = users.map((user, index) =>
        vectorItem(`${user}-reference`, index < lowThresholdUsers ? [0, 1] : [1, 0]),
      );
      const excludedForUsers = users.flatMap((user) =>
        referenceItems
          .filter((item) => !item.id.startsWith(user))
          .map((item) => ({
            userId: user,
            itemId: item.id,
            kind: "seen" as const,
            updatedAt: now,
          })),
      );
      const result = scoreDiscoveryCandidate(
        scoreInput({
          candidateItems: [
            vectorItem("candidate-match-0", [1, 0]),
            vectorItem("candidate-match-1", [1, 0]),
            vectorItem("candidate-no-match", [0, 1]),
          ],
          likeItems,
          referenceItems,
          feedback: [
            ...users.flatMap((user) =>
              likes(
                user,
                likeItems.filter((item) => item.id.startsWith(user)).map(({ id }) => id),
              ),
            ),
            ...excludedForUsers,
          ],
        }),
      );

      expect(result.relevance).toBe(relevance);
      expect(result.relevanceBasis).toBe("all_users");
    },
  );

  it.each([
    {
      name: "fewer than five admin likes",
      overrides: { feedback: likes("admin", ["like-0", "like-1", "like-2", "like-3"]) },
    },
    {
      name: "an empty reference pool",
      overrides: { referenceItems: [] },
    },
    {
      name: "a missing candidate language mean",
      overrides: { means: { fi: zeroMean } },
    },
    {
      name: "fewer than three scored candidate items",
      overrides: { candidateItems: [vectorItem("candidate-only", [1, 0])] },
    },
  ])("returns not_scored for $name", ({ overrides }) => {
    expect(scoreDiscoveryCandidate(scoreInput(overrides))).toMatchObject({
      relevance: "not_scored",
      relevanceBasis: null,
      meanMatchShare: null,
    });
  });

  it("computes duplicate share from exact URLs and high-confidence centered similarity", () => {
    const candidateItems = [
      vectorItem("candidate-0", [1, 0], { url: "https://publisher.example/exact" }),
      vectorItem("candidate-1", [1, 0]),
      vectorItem("candidate-2", [0, 1]),
    ];
    const result = scoreDiscoveryCandidate(
      scoreInput({
        candidateItems,
        allKnownUrls: new Set(["https://publisher.example/exact"]),
        referenceItems: [vectorItem("reference-duplicate", [1, 0])],
      }),
    );
    expect(result.duplicateShare).toBe(0.65);
  });

  it("rounds shares to 0.05 and sorts by relevance, mean share, and duplicate share", () => {
    expect(roundMatchShare(0.333)).toBe(0.35);
    const candidates = [
      { id: "low", relevance: "low" as const, meanMatchShare: 0.9, duplicateShare: 0 },
      {
        id: "not-scored",
        relevance: "not_scored" as const,
        meanMatchShare: null,
        duplicateShare: null,
      },
      {
        id: "more-duplicates",
        relevance: "high" as const,
        meanMatchShare: 0.7,
        duplicateShare: 0.4,
      },
      { id: "best", relevance: "high" as const, meanMatchShare: 0.7, duplicateShare: 0.1 },
      { id: "medium", relevance: "medium" as const, meanMatchShare: 0.9, duplicateShare: 0.3 },
    ];
    expect(sortDiscoveryCandidates(candidates).map(({ id }) => id)).toEqual([
      "best",
      "more-duplicates",
      "medium",
      "low",
      "not-scored",
    ]);
  });
});

describe("discovery time windows and samples", () => {
  it("counts 30-day eligible volume while scoring articles for 7 days and videos for 30", () => {
    const items = [
      parsedItem(1, { type: "article", daysAgo: 8 }),
      parsedItem(2, { type: "article", daysAgo: 6 }),
      parsedItem(3, { type: "video", daysAgo: 29 }),
    ];
    expect(countRecentEligibleItems(items, now)).toBe(3);
    expect(candidateItemsForScoring(items, now).map(({ url }) => url)).toEqual([
      "https://publisher.example/2",
      "https://publisher.example/3",
    ]);
    expect(sampleDiscoveryTitles(items, now)).toEqual(["Title 2", "Title 1", "Title 3"]);
  });
});
