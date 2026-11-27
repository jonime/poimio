export const INTEREST_SUMMARY_DAILY_LIMIT = 10;
export const INTEREST_SUMMARY_LIMIT_MESSAGE =
  "You have used all 10 interest summary requests for the last 24 hours.";

export interface InterestSummary {
  summary: string;
  topics: string[];
  likeCount: number;
  generatedAt: string;
}
