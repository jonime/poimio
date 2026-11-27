import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EMBEDDING_BATCH_SIZE,
  embedItemsInMemory,
  type InMemoryEmbeddingInput,
} from "./embeddings.ts";
import { type FetchBatchOptions, type FetchResult, fetchFeeds } from "./fetch.ts";
import { parseFeed } from "./normalize/parse.ts";
import {
  activeWindowDate,
  assessDiscoveryFeed,
  candidateItemsForScoring,
  countRecentEligibleItems,
  type DiscoveryClick,
  type DiscoveryFeedback,
  type DiscoveryLanguage,
  type DiscoveryScore,
  type DiscoverySource,
  type DiscoveryVectorItem,
  normalizeSourceFeedUrl,
  SOURCE_DISCOVERY_EMBEDDING_MODEL,
  sampleDiscoveryTitles,
  scoreDiscoveryCandidate,
} from "./source-discovery.ts";

const READ_PAGE_SIZE = 1_000;
const KNOWN_URL_BATCH_SIZE = 100;
const SOURCE_BATCH_SIZE = 8;
const MAX_EMBEDDING_REQUESTS = 8;
const MAX_SCAN_DURATION_MS = 240_000;
const SCAN_LEASE_SECONDS = 330;

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

interface RawSource {
  id: string;
  name: string;
  feed_url: string;
  site_url: string | null;
  kind: "rss" | "youtube";
  language: string;
}

interface ExistingCandidate {
  id: string;
  source_id: string | null;
  status: "pending" | "failed" | "approved" | "rejected";
}

interface RawVectorItem {
  id: string;
  source_id: string;
  type: "article" | "video";
  url: string;
  language: string;
  published_at: string;
  embedding: string | number[] | null;
  summary: string | null;
}

interface RawFeedback {
  user_id: string;
  item_id: string;
  kind: "like" | "not_interested" | "seen";
  updated_at: string;
}

interface RawClick {
  user_id: string;
  item_id: string;
}

interface RawMean {
  language: string;
  mean: string | number[];
}

interface ScoringContext {
  referenceItems: DiscoveryVectorItem[];
  likeItems: DiscoveryVectorItem[];
  feedback: DiscoveryFeedback[];
  clicks: DiscoveryClick[];
  means: Partial<Record<DiscoveryLanguage, number[]>>;
}

interface CandidateEvaluation {
  source: DiscoverySource;
  feedUrl: string;
  status: "pending" | "failed";
  failure: string | null;
  itemCount: number | null;
  itemsPerDay: number | null;
  score: DiscoveryScore;
  sampleTitles: string[];
  scannedAt: string;
}

interface ReadyCandidate extends CandidateEvaluation {
  language: DiscoveryLanguage;
  scoringItems: ReturnType<typeof candidateItemsForScoring>;
  vectors: Map<number, number[]>;
  embeddingFailed: boolean;
}

type CandidateState = CandidateEvaluation | ReadyCandidate;

interface CandidateItemJob {
  candidateIndex: number;
  itemIndex: number;
  item: InMemoryEmbeddingInput;
}

export interface CatalogScanResult {
  status: "scan_running" | "completed" | "partial";
  processed: number;
  failed: number;
}

export interface CatalogScanOptions {
  now?: () => Date;
  deadlineMs?: number;
  sourceIds?: string[];
  fetchBatch?: (
    feeds: Parameters<typeof fetchFeeds>[0],
    options?: FetchBatchOptions,
  ) => Promise<FetchResult[]>;
  embeddingRequest?: typeof embedItemsInMemory;
}

export async function readPages<T>(
  readPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += READ_PAGE_SIZE) {
    const { data, error } = await readPage(offset, offset + READ_PAGE_SIZE - 1);
    if (error) throw new Error(`${label} failed: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < READ_PAGE_SIZE) return rows;
  }
}

function parseVector(value: string | number[] | null, label: string): number[] {
  let vector: number[];
  if (Array.isArray(value)) {
    vector = value;
  } else if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
    vector = value
      .slice(1, -1)
      .split(",")
      .map((number) => Number(number));
  } else {
    throw new Error(`${label} is missing a stored vector`);
  }
  if (vector.length !== 512 || !vector.every((number) => Number.isFinite(number))) {
    throw new Error(`${label} has an invalid stored vector`);
  }
  return vector;
}

function toDiscoveryVectorItem(row: RawVectorItem): DiscoveryVectorItem | null {
  if ((row.language !== "fi" && row.language !== "en") || !row.summary?.trim()) return null;
  return {
    id: row.id,
    url: row.url,
    type: row.type,
    language: row.language,
    publishedAt: new Date(row.published_at),
    embedding: parseVector(row.embedding, `content item ${row.id}`),
  };
}

async function loadInactiveSources(client: SupabaseClient): Promise<DiscoverySource[]> {
  const rows = await readPages(
    (from, to) =>
      client
        .from("sources")
        .select("id,name,feed_url,site_url,kind,language")
        .eq("is_active", false)
        .order("id")
        .range(from, to),
    "loading inactive sources",
  );
  return (rows as RawSource[]).map((row) => ({
    id: row.id,
    name: row.name,
    feedUrl: row.feed_url,
    siteUrl: row.site_url,
    kind: row.kind,
    language: row.language,
  }));
}

async function loadCandidates(
  client: SupabaseClient,
  sourceIds: string[],
): Promise<Map<string, ExistingCandidate>> {
  const result = new Map<string, ExistingCandidate>();
  for (let offset = 0; offset < sourceIds.length; offset += READ_PAGE_SIZE) {
    const ids = sourceIds.slice(offset, offset + READ_PAGE_SIZE);
    const rows = await readPages(
      (from, to) =>
        client
          .from("source_candidates")
          .select("id,source_id,status")
          .in("source_id", ids)
          .order("source_id")
          .range(from, to),
      "loading existing source candidates",
    );
    for (const candidate of rows as ExistingCandidate[]) {
      if (candidate.source_id) result.set(candidate.source_id, candidate);
    }
  }
  return result;
}

async function loadMeans(
  client: SupabaseClient,
): Promise<Partial<Record<DiscoveryLanguage, number[]>>> {
  const { data, error } = await client
    .from("embedding_language_means")
    .select("language,mean")
    .eq("embedding_model", SOURCE_DISCOVERY_EMBEDDING_MODEL);
  if (error) throw new Error(`loading embedding language means failed: ${error.message}`);
  const means: Partial<Record<DiscoveryLanguage, number[]>> = {};
  for (const row of (data ?? []) as RawMean[]) {
    if (row.language === "fi" || row.language === "en") {
      means[row.language] = parseVector(row.mean, `${row.language} language mean`);
    }
  }
  return means;
}

async function loadReferences(
  client: SupabaseClient,
  activeSourceIds: string[],
  now: Date,
): Promise<DiscoveryVectorItem[]> {
  const rawRows: RawVectorItem[] = [];
  for (let offset = 0; offset < activeSourceIds.length; offset += READ_PAGE_SIZE) {
    const sourceIds = activeSourceIds.slice(offset, offset + READ_PAGE_SIZE);
    const rows = await readPages(
      (from, to) =>
        client
          .from("content_items")
          .select("id,source_id,type,url,language,published_at,embedding,summary")
          .in("source_id", sourceIds)
          .eq("embedding_model", SOURCE_DISCOVERY_EMBEDDING_MODEL)
          .eq("enrichment_status", "completed")
          .not("embedding", "is", null)
          .not("summary", "is", null)
          .gte("published_at", activeWindowDate("video", now).toISOString())
          .lte("published_at", now.toISOString())
          .order("published_at", { ascending: false })
          .order("id")
          .range(from, to),
      "loading active-source reference items",
    );
    rawRows.push(...(rows as RawVectorItem[]));
  }
  return rawRows
    .map(toDiscoveryVectorItem)
    .filter((item): item is DiscoveryVectorItem => item !== null);
}

async function loadFeedback(client: SupabaseClient): Promise<RawFeedback[]> {
  return (await readPages(
    (from, to) =>
      client
        .from("feedback")
        .select("user_id,item_id,kind,updated_at")
        .order("user_id")
        .order("item_id")
        .range(from, to),
    "loading user feedback for discovery scoring",
  )) as RawFeedback[];
}

async function loadClicks(client: SupabaseClient): Promise<RawClick[]> {
  return (await readPages(
    (from, to) =>
      client
        .from("item_clicks")
        .select("user_id,item_id")
        .order("user_id")
        .order("item_id")
        .range(from, to),
    "loading opened items for discovery scoring",
  )) as RawClick[];
}

async function loadLikeItems(
  client: SupabaseClient,
  likes: RawFeedback[],
): Promise<DiscoveryVectorItem[]> {
  const itemIds = [
    ...new Set(likes.filter((row) => row.kind === "like").map((row) => row.item_id)),
  ];
  const result: DiscoveryVectorItem[] = [];
  for (let offset = 0; offset < itemIds.length; offset += 500) {
    const ids = itemIds.slice(offset, offset + 500);
    const rows = await readPages(
      (from, to) =>
        client
          .from("content_items")
          .select("id,source_id,type,url,language,published_at,embedding,summary")
          .in("id", ids)
          .eq("embedding_model", SOURCE_DISCOVERY_EMBEDDING_MODEL)
          .eq("enrichment_status", "completed")
          .not("embedding", "is", null)
          .not("summary", "is", null)
          .range(from, to),
      "loading eligible liked items for discovery scoring",
    );
    result.push(
      ...(rows as RawVectorItem[])
        .map(toDiscoveryVectorItem)
        .filter((item): item is DiscoveryVectorItem => item !== null),
    );
  }
  return result;
}

async function loadScoringContext(client: SupabaseClient, now: Date): Promise<ScoringContext> {
  const [activeSources, means, rawFeedback, rawClicks] = await Promise.all([
    readPages(
      (from, to) =>
        client.from("sources").select("id").eq("is_active", true).order("id").range(from, to),
      "loading active source IDs",
    ),
    loadMeans(client),
    loadFeedback(client),
    loadClicks(client),
  ]);
  const activeSourceIds = (activeSources as Array<{ id: string }>).map(({ id }) => id);
  const [referenceItems, likeItems] = await Promise.all([
    loadReferences(client, activeSourceIds, now),
    loadLikeItems(client, rawFeedback),
  ]);
  const feedback = rawFeedback.map((row) => ({
    userId: row.user_id,
    itemId: row.item_id,
    kind: row.kind,
    updatedAt: new Date(row.updated_at),
  }));
  const clicks = rawClicks.map((row) => ({ userId: row.user_id, itemId: row.item_id }));
  return { referenceItems, likeItems, feedback, clicks, means };
}

async function loadKnownUrls(client: SupabaseClient, urls: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  const uniqueUrls = [...new Set(urls)];
  for (let offset = 0; offset < uniqueUrls.length; offset += KNOWN_URL_BATCH_SIZE) {
    const batch = uniqueUrls.slice(offset, offset + KNOWN_URL_BATCH_SIZE);
    const { data, error } = await client.rpc("find_existing_content_item_urls", {
      p_urls: batch,
    });
    if (error) throw new Error(`checking existing item URLs failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ url: string }>) result.add(row.url);
  }
  return result;
}

async function saveCandidate(
  client: SupabaseClient,
  existing: ExistingCandidate | undefined,
  evaluation: CandidateEvaluation,
): Promise<void> {
  const values = {
    origin: "catalog",
    source_id: evaluation.source.id,
    name: evaluation.source.name,
    feed_url: evaluation.feedUrl,
    site_url: evaluation.source.siteUrl,
    kind: evaluation.source.kind,
    language: evaluation.source.language,
    status: evaluation.status,
    failure: evaluation.failure,
    item_count: evaluation.itemCount,
    items_per_day: evaluation.itemsPerDay,
    relevance: evaluation.score.relevance,
    relevance_basis: evaluation.score.relevanceBasis,
    mean_match_share: evaluation.score.meanMatchShare,
    duplicate_share: evaluation.score.duplicateShare,
    sample_titles: evaluation.sampleTitles,
    scanned_at: evaluation.scannedAt,
    decided_at: null,
  };
  const result = existing
    ? await client.from("source_candidates").update(values).eq("id", existing.id)
    : await client.from("source_candidates").insert(values);
  if (result.error) throw new Error(`saving source candidate failed: ${result.error.message}`);
}

function failedEvaluation(
  source: DiscoverySource,
  feedUrl: string,
  failure: string,
  scannedAt: string,
): CandidateEvaluation {
  return {
    source,
    feedUrl,
    status: "failed",
    failure,
    itemCount: null,
    itemsPerDay: null,
    score: {
      relevance: "not_scored",
      relevanceBasis: null,
      meanMatchShare: null,
      duplicateShare: null,
    },
    sampleTitles: [],
    scannedAt,
  };
}

function isReadyCandidate(candidate: CandidateState): candidate is ReadyCandidate {
  return "scoringItems" in candidate;
}

async function finishRun(
  client: SupabaseClient,
  runId: string,
  status: "completed" | "partial" | "failed",
): Promise<void> {
  const { error } = await client
    .from("source_discovery_runs")
    .update({ status, finished_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("status", "running");
  if (error) throw new Error(`finishing source discovery run failed: ${error.message}`);
}

export async function scanInactiveCatalog(
  client: SupabaseClient,
  apiKey: string,
  adminUserId: string,
  options: CatalogScanOptions = {},
): Promise<CatalogScanResult> {
  const { data: runId, error: leaseError } = await client.rpc("start_source_discovery_run", {
    p_kind: "catalog",
  });
  if (leaseError) throw new Error(`starting source discovery run failed: ${leaseError.message}`);
  if (!runId) return { status: "scan_running", processed: 0, failed: 0 };

  const startedAt = performance.now();
  const deadlineMs = options.deadlineMs ?? MAX_SCAN_DURATION_MS;
  const now = options.now?.() ?? new Date();
  const fetchBatch = options.fetchBatch ?? fetchFeeds;
  const embeddingRequest = options.embeddingRequest ?? embedItemsInMemory;
  let processed = 0;
  let failed = 0;
  let status: "completed" | "partial" = "completed";
  let embeddingRequests = 0;

  try {
    const inactiveSources = await loadInactiveSources(client);
    const sources =
      options.sourceIds === undefined
        ? inactiveSources
        : inactiveSources.filter((source) => options.sourceIds?.includes(source.id));
    const existing = await loadCandidates(
      client,
      sources.map((source) => source.id),
    );
    const pendingSources = sources.filter((source) => {
      const current = existing.get(source.id);
      return current === undefined || current.status === "pending" || current.status === "failed";
    });
    const scoring = await loadScoringContext(client, now);

    for (let offset = 0; offset < pendingSources.length; offset += SOURCE_BATCH_SIZE) {
      if (performance.now() - startedAt >= deadlineMs) {
        status = "partial";
        break;
      }

      const sourcesInBatch = pendingSources.slice(offset, offset + SOURCE_BATCH_SIZE);
      const normalizedUrls = sourcesInBatch.map((source) => {
        try {
          return normalizeSourceFeedUrl(source.feedUrl);
        } catch {
          return null;
        }
      });
      const fetched = await fetchBatch(
        sourcesInBatch.map((source) => ({
          feedUrl: source.feedUrl,
          etag: null,
          lastModified: null,
        })),
      );
      const candidates: CandidateState[] = [];
      for (const [index, source] of sourcesInBatch.entries()) {
        const feedUrl = normalizedUrls[index] ?? source.feedUrl.trim();
        const result = fetched[index];
        if (normalizedUrls[index] === null) {
          candidates.push(failedEvaluation(source, feedUrl, "invalid_feed_url", now.toISOString()));
          continue;
        }
        if (result?.status !== "ok") {
          candidates.push(failedEvaluation(source, feedUrl, "fetch_failed", now.toISOString()));
          continue;
        }

        let parsed: Awaited<ReturnType<typeof parseFeed>>;
        try {
          parsed = await parseFeed(result.body, { fetchTime: now });
        } catch {
          candidates.push(failedEvaluation(source, feedUrl, "parse_failed", now.toISOString()));
          continue;
        }
        const assessment = assessDiscoveryFeed(parsed.items, source.language, now);
        if (assessment.failure) {
          candidates.push(failedEvaluation(source, feedUrl, assessment.failure, now.toISOString()));
          continue;
        }
        if (source.language !== "fi" && source.language !== "en") {
          throw new Error("Validated source language was not supported");
        }
        const counted = countRecentEligibleItems(assessment.items, now);
        candidates.push({
          source,
          language: source.language,
          feedUrl,
          status: "pending",
          failure: null,
          itemCount: counted,
          itemsPerDay: Number((counted / 30).toFixed(2)),
          score: {
            relevance: "not_scored",
            relevanceBasis: null,
            meanMatchShare: null,
            duplicateShare: null,
          },
          sampleTitles: sampleDiscoveryTitles(assessment.items, now),
          scannedAt: now.toISOString(),
          scoringItems: candidateItemsForScoring(assessment.items, now),
          vectors: new Map<number, number[]>(),
          embeddingFailed: false,
        });
      }

      const jobs: CandidateItemJob[] = [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (!isReadyCandidate(candidate)) continue;
        for (const [itemIndex, item] of candidate.scoringItems.entries()) {
          jobs.push({
            candidateIndex,
            itemIndex,
            item: { title: item.title, summary: item.summary },
          });
        }
      }

      for (let jobOffset = 0; jobOffset < jobs.length; jobOffset += EMBEDDING_BATCH_SIZE) {
        if (embeddingRequests >= MAX_EMBEDDING_REQUESTS) break;
        const batch = jobs.slice(jobOffset, jobOffset + EMBEDDING_BATCH_SIZE);
        embeddingRequests += 1;
        try {
          const vectors = await embeddingRequest(
            batch.map(({ item }) => item),
            apiKey,
          );
          for (const [index, job] of batch.entries()) {
            const candidate = candidates[job.candidateIndex];
            const vector = vectors[index];
            if (!candidate || !isReadyCandidate(candidate) || vector === undefined) {
              throw new Error("Embedding response did not include a candidate vector");
            }
            candidate.vectors.set(job.itemIndex, vector);
          }
        } catch {
          for (const job of batch) {
            const candidate = candidates[job.candidateIndex];
            if (candidate && isReadyCandidate(candidate)) {
              candidate.embeddingFailed = true;
            }
          }
        }
      }

      const scoredCandidates = candidates.filter(isReadyCandidate);
      const knownUrls = await loadKnownUrls(
        client,
        scoredCandidates.flatMap((candidate) =>
          candidate.scoringItems
            .map((item, index) => (candidate.vectors.has(index) ? item.url : null))
            .filter((url): url is string => url !== null),
        ),
      );

      for (const candidate of candidates) {
        if (!candidate) continue;
        let evaluation: CandidateEvaluation;
        if (!isReadyCandidate(candidate)) {
          evaluation = candidate;
        } else if (candidate.embeddingFailed) {
          evaluation = failedEvaluation(
            candidate.source,
            candidate.feedUrl,
            "embedding_failed",
            candidate.scannedAt,
          );
        } else {
          const candidateItems = candidate.scoringItems.flatMap((item, index) => {
            const embedding = candidate.vectors.get(index);
            return embedding === undefined
              ? []
              : [
                  {
                    id: `${candidate.source.id}:${index}`,
                    url: item.url,
                    type: item.type,
                    language: candidate.language,
                    publishedAt: item.publishedAt,
                    embedding,
                  } satisfies DiscoveryVectorItem,
                ];
          });
          evaluation = {
            ...candidate,
            score: scoreDiscoveryCandidate({
              candidateItems,
              likeItems: scoring.likeItems,
              referenceItems: scoring.referenceItems,
              allKnownUrls: knownUrls,
              feedback: scoring.feedback,
              clicks: scoring.clicks,
              means: scoring.means,
              adminUserId,
              now,
            }),
          };
        }
        await saveCandidate(client, existing.get(evaluation.source.id), evaluation);
        processed += 1;
        if (evaluation.status === "failed") failed += 1;
      }
    }

    await finishRun(client, runId, status);
    return { status, processed, failed };
  } catch (error) {
    try {
      await finishRun(client, runId, "failed");
    } catch (finishError) {
      throw new Error(
        `source discovery failed (${error instanceof Error ? error.message : String(error)}); ` +
          `recording the failed run also failed (${finishError instanceof Error ? finishError.message : String(finishError)})`,
      );
    }
    throw error;
  }
}

export const SOURCE_DISCOVERY_SCAN_LIMITS = {
  leaseSeconds: SCAN_LEASE_SECONDS,
  sourceBatchSize: SOURCE_BATCH_SIZE,
  maxEmbeddingRequests: MAX_EMBEDDING_REQUESTS,
  deadlineMs: MAX_SCAN_DURATION_MS,
};
