export const rankingMethods = [
  "nearest_liked",
  "average_vector",
  "top_m_mean",
  "blend",
  "newest_first",
  "random",
] as const;

export type RankingMethod = (typeof rankingMethods)[number];

// Must match the defaults block in `ranking_private.rank_items`; an integration test checks every
// default except `dislike_threshold`.
export const rankingDefaults = {
  lambda: 0.5,
  recency_weight: 0,
  dislike_threshold: 0.4,
  article_half_life_hours: 24,
  video_half_life_hours: 168,
  centered: true,
  diversity: 0,
  exploration: false,
};

const interestDefaults: Partial<Record<RankingMethod, Record<string, number>>> = {
  top_m_mean: { top_m: 3 },
  blend: { blend_alpha: 0.5 },
};

export function isRankingMethod(value: string): value is RankingMethod {
  return (rankingMethods as readonly string[]).includes(value);
}

export function resolveRankingParameters(
  method: RankingMethod,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return { ...rankingDefaults, ...interestDefaults[method], ...overrides };
}
