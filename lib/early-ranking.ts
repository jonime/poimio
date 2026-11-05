export const EARLY_RANKING_METHODS = ["nearest-liked", "average-vector", "newest-first"] as const;

export type EarlyRankingMethod = (typeof EARLY_RANKING_METHODS)[number];

export const CENTERED_RANKING_METHODS = [
  "nearest-liked-raw",
  "average-vector-raw",
  "nearest-liked-centered",
  "average-vector-centered",
  "newest-first",
] as const;

export type CenteredRankingMethod = (typeof CENTERED_RANKING_METHODS)[number];
export type RankingLanguage = "fi" | "en";

export interface EarlyRankingItem {
  id: string;
  title: string;
  summary: string | null;
  language: "fi" | "en";
  url: string;
  publishedAt: string;
  embedding: number[];
}

export interface CenteredRankingAnswerKey {
  languageMeans: Record<RankingLanguage, number[]>;
  personas: Record<string, Record<CenteredRankingMethod, Array<{ url: string; rank: number }>>>;
}

export interface CenteredJudgingRow {
  persona: string;
  url: string;
  relevant: string;
}

export interface CenteredRankingScore {
  persona: string;
  method: CenteredRankingMethod;
  relevant: number;
  precisionAt10: number;
}

export interface CenteredRankingResults {
  perPersona: CenteredRankingScore[];
  macroAverage: Record<CenteredRankingMethod, number>;
  gate1: {
    passed: boolean;
    decision: string;
  };
  languageMeans: Record<RankingLanguage, number[]>;
}

export interface JudgingRow {
  persona: string;
  blind_id: string;
  relevant: string;
}

export interface RankingAnswerKey {
  personas: Record<string, Record<EarlyRankingMethod, Array<{ blindId: string; rank: number }>>>;
}

export interface EarlyRankingScore {
  persona: string;
  method: EarlyRankingMethod;
  relevant: number;
  precisionAt10: number;
}

export interface EarlyRankingResults {
  perPersona: EarlyRankingScore[];
  macroAverage: Record<EarlyRankingMethod, number>;
  gate1: {
    passed: boolean;
    decision: string;
  };
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("embedding dimensions must match and be non-empty");
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) {
      throw new Error("embedding contains a missing value");
    }
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function meanEmbedding(items: EarlyRankingItem[]): number[] {
  const firstItem = items[0];
  if (!firstItem) throw new Error("at least one liked item is required");

  const mean = Array<number>(firstItem.embedding.length).fill(0);
  for (const item of items) {
    if (item.embedding.length !== mean.length) {
      throw new Error("liked items have inconsistent embedding dimensions");
    }
    for (let index = 0; index < mean.length; index += 1) {
      const value = item.embedding[index];
      if (value === undefined) throw new Error("embedding contains a missing value");
      mean[index] = (mean[index] ?? 0) + value;
    }
  }
  return mean.map((value) => value / items.length);
}

export function centerEmbeddingsByLanguage(items: EarlyRankingItem[]): {
  means: Record<RankingLanguage, number[]>;
  items: EarlyRankingItem[];
} {
  const means = {
    fi: meanEmbedding(items.filter((item) => item.language === "fi")),
    en: meanEmbedding(items.filter((item) => item.language === "en")),
  };
  const centeredItems = items.map((item) => {
    const mean = means[item.language];
    const centered = item.embedding.map((value, index) => {
      const meanValue = mean[index];
      if (meanValue === undefined) throw new Error("language mean has an inconsistent dimension");
      return value - meanValue;
    });
    const norm = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0));
    return {
      ...item,
      embedding: norm === 0 ? centered : centered.map((value) => value / norm),
    };
  });
  return { means, items: centeredItems };
}

export function rankEarlyItems(
  items: EarlyRankingItem[],
  likedItemIds: string[],
  method: EarlyRankingMethod,
): EarlyRankingItem[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const likedItems = likedItemIds.map((id) => {
    const item = itemById.get(id);
    if (!item) throw new Error(`liked item ${id} is not in the sample`);
    return item;
  });
  if (likedItems.length === 0) throw new Error("at least one liked item is required");

  const likedIds = new Set(likedItemIds);
  const candidates = items.filter((item) => !likedIds.has(item.id));

  if (method === "newest-first") {
    return candidates.sort((left, right) => {
      const timeDifference = Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
      return timeDifference || left.id.localeCompare(right.id);
    });
  }

  const average = method === "average-vector" ? meanEmbedding(likedItems) : null;
  return candidates.sort((left, right) => {
    const leftScore =
      method === "nearest-liked"
        ? Math.max(...likedItems.map((liked) => cosineSimilarity(left.embedding, liked.embedding)))
        : cosineSimilarity(left.embedding, average ?? []);
    const rightScore =
      method === "nearest-liked"
        ? Math.max(...likedItems.map((liked) => cosineSimilarity(right.embedding, liked.embedding)))
        : cosineSimilarity(right.embedding, average ?? []);
    return rightScore - leftScore || left.id.localeCompare(right.id);
  });
}

export function encodeCsv(rows: string[][]): string {
  return `${rows
    .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(","))
    .join("\r\n")}\r\n`;
}

export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === undefined) continue;

    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

export function scoreEarlyRanking(
  judgingRows: JudgingRow[],
  answerKey: RankingAnswerKey,
): EarlyRankingResults {
  const relevance = new Map<string, boolean>();
  for (const row of judgingRows) {
    const key = `${row.persona}\u0000${row.blind_id}`;
    if (relevance.has(key)) throw new Error(`duplicate judgment for ${row.blind_id}`);
    if (row.relevant !== "0" && row.relevant !== "1") {
      throw new Error(`relevant must be 0 or 1 for ${row.blind_id}`);
    }
    relevance.set(key, row.relevant === "1");
  }

  const perPersona: EarlyRankingScore[] = [];
  for (const [persona, methods] of Object.entries(answerKey.personas)) {
    for (const method of EARLY_RANKING_METHODS) {
      const rankedItems = methods[method];
      if (rankedItems?.length !== 10) {
        throw new Error(`${persona}/${method} must have exactly 10 ranked items`);
      }
      let relevantCount = 0;
      for (const rankedItem of rankedItems) {
        const key = `${persona}\u0000${rankedItem.blindId}`;
        const judgedRelevant = relevance.get(key);
        if (judgedRelevant === undefined) {
          throw new Error(`missing judgment for ${persona}/${rankedItem.blindId}`);
        }
        if (judgedRelevant) relevantCount += 1;
      }
      perPersona.push({
        persona,
        method,
        relevant: relevantCount,
        precisionAt10: relevantCount / 10,
      });
    }
  }

  const macroAverage = Object.fromEntries(
    EARLY_RANKING_METHODS.map((method) => {
      const scores = perPersona.filter((score) => score.method === method);
      if (scores.length === 0) throw new Error("answer key must contain personas");
      return [method, scores.reduce((sum, score) => sum + score.precisionAt10, 0) / scores.length];
    }),
  ) as Record<EarlyRankingMethod, number>;
  const passed =
    macroAverage["nearest-liked"] >= macroAverage["average-vector"] &&
    macroAverage["nearest-liked"] > macroAverage["newest-first"];

  return {
    perPersona,
    macroAverage,
    gate1: {
      passed,
      decision: passed
        ? "Keep nearest-liked; it meets or beats average-vector and beats newest-first."
        : "Investigate embedding input, lambda, and sample; use average-vector as fallback if needed.",
    },
  };
}

export function scoreCenteredEarlyRanking(
  judgingRows: CenteredJudgingRow[],
  answerKey: CenteredRankingAnswerKey,
): CenteredRankingResults {
  const relevance = new Map<string, boolean>();
  for (const row of judgingRows) {
    const key = `${row.persona}\u0000${row.url}`;
    if (relevance.has(key)) throw new Error(`duplicate judgment for ${row.persona}/${row.url}`);
    if (row.relevant !== "0" && row.relevant !== "1") {
      throw new Error(`relevant must be 0 or 1 for ${row.persona}/${row.url}`);
    }
    relevance.set(key, row.relevant === "1");
  }

  const perPersona: CenteredRankingScore[] = [];
  for (const [persona, methods] of Object.entries(answerKey.personas)) {
    for (const method of CENTERED_RANKING_METHODS) {
      const rankedItems = methods[method];
      if (rankedItems?.length !== 10) {
        throw new Error(`${persona}/${method} must have exactly 10 ranked items`);
      }
      let relevantCount = 0;
      for (const rankedItem of rankedItems) {
        const judgedRelevant = relevance.get(`${persona}\u0000${rankedItem.url}`);
        if (judgedRelevant === undefined) {
          throw new Error(`missing judgment for ${persona}/${rankedItem.url}`);
        }
        if (judgedRelevant) relevantCount += 1;
      }
      perPersona.push({
        persona,
        method,
        relevant: relevantCount,
        precisionAt10: relevantCount / 10,
      });
    }
  }

  const macroAverage = Object.fromEntries(
    CENTERED_RANKING_METHODS.map((method) => {
      const scores = perPersona.filter((score) => score.method === method);
      if (scores.length === 0) throw new Error("answer key must contain personas");
      return [method, scores.reduce((sum, score) => sum + score.precisionAt10, 0) / scores.length];
    }),
  ) as Record<CenteredRankingMethod, number>;
  const bestNearestLikedMethod =
    macroAverage["nearest-liked-centered"] >= macroAverage["nearest-liked-raw"]
      ? "nearest-liked-centered"
      : "nearest-liked-raw";
  const pairedAverageMethod =
    bestNearestLikedMethod === "nearest-liked-centered"
      ? "average-vector-centered"
      : "average-vector-raw";
  const bestAverageVectorMethod =
    macroAverage["average-vector-centered"] > macroAverage["average-vector-raw"]
      ? "average-vector-centered"
      : "average-vector-raw";
  const passed =
    macroAverage[bestNearestLikedMethod] >= macroAverage[pairedAverageMethod] &&
    macroAverage[bestNearestLikedMethod] > macroAverage["newest-first"];

  return {
    perPersona,
    macroAverage,
    gate1: {
      passed,
      decision: passed
        ? `Keep ${bestNearestLikedMethod}; it meets or beats ${pairedAverageMethod} and beats newest-first.`
        : `Use ${bestAverageVectorMethod} as the gate 1 baseline; nearest-liked does not meet both criteria.`,
    },
    languageMeans: answerKey.languageMeans,
  };
}
