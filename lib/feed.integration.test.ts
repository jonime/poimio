import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIngestDb } from "./db.ts";
import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";
import { rankingDefaults } from "./ranking-parameters.ts";
import { requireDefined } from "./required.ts";

const enabled = process.env.SUPABASE_INTEGRATION === "1";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const activeModel = "text-embedding-3-small@512";
const otherModel = "older-model@512";
const meanVectors = {
  fi: new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
  en: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === 4 ? 10 : 0)),
} as const;

interface ItemDefinition {
  key: string;
  source: number;
  language: "fi" | "en";
  center: number[];
  embedding?: number[] | null;
  model?: string | null;
  type?: "article" | "video";
  ageMinutes?: number;
}

interface FeedRow {
  id: string;
  source_name: string;
  score: number;
  reason: string;
  because_item_id: string | null;
  because_title: string | null;
  because_preference_id: string | null;
}

interface LanguageMeanRow {
  embedding_model: string;
  language: "fi" | "en";
  mean: string;
  item_count: number;
  computed_at: string;
}

function axisVector(axis: number, sign = 1): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === axis ? sign : 0));
}

function addVectors(left: number[], right: number[]): number[] {
  return left.map(
    (value, index) => value + requireDefined(right[index], `fixture vector component ${index}`),
  );
}

function pgVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function dot(left: number[], right: number[]): number {
  return left.reduce(
    (sum, value, index) => sum + value * requireDefined(right[index], `vector component ${index}`),
    0,
  );
}

function vectorNorm(vector: number[]): number {
  return Math.sqrt(dot(vector, vector));
}

function cosine(left: number[], right: number[]): number {
  const leftNorm = vectorNorm(left);
  const rightNorm = vectorNorm(right);
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot(left, right) / (leftNorm * rightNorm);
}

const itemDefinitions: ItemDefinition[] = [
  { key: "liked-fi", source: 0, language: "fi", center: axisVector(0) },
  { key: "candidate-close", source: 1, language: "fi", center: axisVector(0) },
  {
    key: "candidate-unrelated",
    source: 2,
    language: "fi",
    center: axisVector(1),
  },
  { key: "disliked-fi", source: 0, language: "fi", center: axisVector(1) },
  {
    key: "candidate-close-dislike",
    source: 1,
    language: "fi",
    center: axisVector(1),
  },
  {
    key: "candidate-neutral",
    source: 2,
    language: "fi",
    center: axisVector(2),
  },
  {
    key: "candidate-cross-related",
    source: 0,
    language: "en",
    center: axisVector(0),
  },
  {
    key: "candidate-same-unrelated",
    source: 1,
    language: "fi",
    center: axisVector(1),
  },
  { key: "cold-a1", source: 0, language: "fi", center: axisVector(0) },
  { key: "cold-b1", source: 1, language: "fi", center: axisVector(2) },
  { key: "cold-c1", source: 2, language: "en", center: axisVector(0) },
  { key: "cold-a2", source: 0, language: "fi", center: axisVector(2) },
  { key: "cold-b2", source: 1, language: "en", center: axisVector(2) },
  { key: "cold-c2", source: 2, language: "fi", center: axisVector(0) },
  {
    key: "cold-negative-match",
    source: 2,
    language: "fi",
    center: axisVector(1),
  },
  { key: "foreign-like", source: 0, language: "fi", center: axisVector(1) },
  { key: "foreign-match", source: 1, language: "fi", center: axisVector(1) },
  { key: "zero-centered", source: 2, language: "fi", center: axisVector(0, 0) },
  { key: "page-old-like", source: 0, language: "fi", center: axisVector(7) },
  { key: "page-like", source: 0, language: "fi", center: axisVector(6) },
  {
    key: "page-target",
    source: 1,
    language: "fi",
    center: addVectors(axisVector(6), axisVector(7, -1)),
  },
  { key: "sitewide-requeue", source: 1, language: "fi", center: axisVector(8) },
  {
    key: "no-embedding-signal",
    source: 2,
    language: "fi",
    center: axisVector(1),
    embedding: null,
  },
  { key: "no-mean-signal", source: 0, language: "en", center: axisVector(1) },
  {
    key: "other-model-signal",
    source: 1,
    language: "fi",
    center: axisVector(1),
    model: otherModel,
  },
  {
    key: "other-model-candidate",
    source: 2,
    language: "fi",
    center: axisVector(2),
    model: otherModel,
  },
  // Ranking-method fixtures: ids start with "rank-" and are never shown by get_feed in tests.
  { key: "rank-like-1", source: 0, language: "fi", center: axisVector(10) },
  { key: "rank-like-2", source: 0, language: "fi", center: axisVector(11) },
  { key: "rank-like-3", source: 0, language: "fi", center: axisVector(12) },
  {
    key: "rank-x",
    source: 1,
    language: "fi",
    center: addVectors(axisVector(10, 3), axisVector(11, 4)),
  },
  {
    key: "rank-mid",
    source: 1,
    language: "fi",
    center: addVectors(axisVector(10), axisVector(11)),
  },
  { key: "rank-cand-a", source: 2, language: "fi", center: axisVector(10) },
  { key: "rank-cand-b", source: 2, language: "fi", center: axisVector(11) },
  { key: "rank-cold-dislike", source: 0, language: "fi", center: axisVector(13) },
  { key: "rank-cold-1", source: 0, language: "fi", center: axisVector(13), ageMinutes: 0 },
  { key: "rank-cold-2", source: 0, language: "fi", center: axisVector(14), ageMinutes: 5 },
  { key: "rank-cold-3", source: 1, language: "fi", center: axisVector(14), ageMinutes: 5 },
  { key: "rank-fi-other", source: 0, language: "fi", center: axisVector(15), ageMinutes: 10 },
  { key: "rank-en-dislike", source: 1, language: "en", center: axisVector(13) },
  { key: "rank-en-cand", source: 0, language: "en", center: axisVector(14), ageMinutes: 0 },
  {
    key: "rank-probe-article",
    source: 1,
    language: "en",
    center: addVectors(axisVector(10), axisVector(13)),
  },
  {
    key: "rank-probe-video",
    source: 2,
    language: "en",
    center: addVectors(axisVector(10), axisVector(13)),
    type: "video",
  },
  { key: "mmr-like-a", source: 0, language: "fi", center: axisVector(20) },
  { key: "mmr-like-b", source: 0, language: "fi", center: axisVector(21) },
  { key: "mmr-a", source: 0, language: "fi", center: axisVector(20) },
  {
    key: "mmr-b",
    source: 1,
    language: "fi",
    center: addVectors(axisVector(20, 0.9), axisVector(22, Math.sqrt(0.19))),
  },
  {
    key: "mmr-c",
    source: 2,
    language: "fi",
    center: addVectors(axisVector(21, 0.8), axisVector(23, 0.6)),
  },
  { key: "mmr-negative", source: 1, language: "fi", center: axisVector(20, -1) },
  { key: "mmr-zero", source: 2, language: "fi", center: axisVector(24) },
  ...Array.from({ length: 105 }, (_, index) => ({
    key: `limit-candidate-${index}`,
    source: index < 100 ? 0 : index % 3,
    language: "fi" as const,
    center: index < 100 ? axisVector(10) : axisVector(2),
  })),
];

describe.skipIf(!enabled || anonKey == null || serviceKey == null)(
  "get_feed against local Supabase with controlled embeddings",
  () => {
    const options = {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    };
    const anonymous: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
    const service: SupabaseClient | null = serviceKey
      ? createClient(url, serviceKey, options)
      : null;
    const userAClient: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
    const userBClient: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;

    function clients() {
      if (!anonymous || !service || !userAClient || !userBClient) {
        throw new Error("Local integration credentials are unavailable.");
      }
      return { anonymous, service, userAClient, userBClient };
    }

    const suffix = randomUUID();
    const password = `Feed-test-${randomUUID()}Aa1!`;
    const emailA = `feed-a-${suffix}@example.test`;
    const emailB = `feed-b-${suffix}@example.test`;
    const sourceIds: string[] = [];
    const sourceNames = ["Feed test source A", "Feed test source B", "Feed test source C"];
    const itemIds = new Map<string, string>();
    let userAId: string | undefined;
    let userBId: string | undefined;
    let originalMeans: LanguageMeanRow[] = [];
    const publishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    async function setFeedback(
      client: SupabaseClient,
      itemKey: string,
      kind: "like" | "not_interested" | "seen",
    ): Promise<void> {
      const { error } = await client.rpc("set_feedback", {
        p_item_id: itemIds.get(itemKey),
        p_kind: kind,
        p_via: "button",
      });
      if (error) throw new Error(`Setting ${kind} feedback failed: ${error.message}`);
    }

    async function getFeed(
      client: SupabaseClient,
      parameters: {
        p_limit?: number;
        p_exclude?: string[];
        includeLimitFixtures?: boolean;
      } = {},
    ): Promise<FeedRow[]> {
      const { includeLimitFixtures = false, ...rpcParameters } = parameters;
      const hiddenFixtureIds = itemDefinitions
        .filter(
          (definition) =>
            definition.key.startsWith("rank-") ||
            (!includeLimitFixtures && definition.key.startsWith("limit-candidate-")),
        )
        .map((definition) =>
          requireDefined(itemIds.get(definition.key), `fixture item ${definition.key}`),
        );
      const { data, error } = await client.rpc("get_feed", {
        ...rpcParameters,
        p_limit: rpcParameters.p_limit ?? 100,
        p_exclude: [...new Set([...hiddenFixtureIds, ...(rpcParameters.p_exclude ?? [])])],
      });
      if (error) throw new Error(`Loading feed failed: ${error.message}`);
      return (data ?? []) as FeedRow[];
    }

    async function rankItems(
      candidateKeys: string[],
      likedKeys: string[] = [],
      dislikedKeys: string[] = [],
      parameters: {
        p_as_of?: string;
        p_method?: string;
        p_params?: Record<string, unknown>;
        p_seed?: number;
        p_limit?: number;
        p_more_preference_ids?: string[];
        p_less_preference_ids?: string[];
      } = {},
    ) {
      const { service } = clients();
      const { data, error } = await service.rpc("rank_items", {
        p_candidate_ids: candidateKeys.map((key) => itemIds.get(key)),
        p_liked_ids: likedKeys.map((key) => itemIds.get(key)),
        p_disliked_ids: dislikedKeys.map((key) => itemIds.get(key)),
        p_as_of: parameters.p_as_of ?? new Date().toISOString(),
        p_method: parameters.p_method,
        p_params: parameters.p_params ?? {},
        p_seed: parameters.p_seed ?? 0,
        p_limit: parameters.p_limit ?? 100,
        p_more_preference_ids: parameters.p_more_preference_ids,
        p_less_preference_ids: parameters.p_less_preference_ids,
      });
      if (error) throw new Error(`Ranking items failed: ${error.message}`);
      return (data ?? []) as {
        item_id: string;
        score: number | null;
        because_item_id: string | null;
        exploration: boolean;
        because_preference_id: string | null;
      }[];
    }

    async function insertPreference(input: {
      userId: string;
      label: string;
      direction: "more" | "less";
      fi: number[];
      en: number[];
      model?: string;
      id?: string;
    }) {
      const { service } = clients();
      const inserted = await service
        .from("feed_preferences")
        .insert({
          id: input.id,
          user_id: input.userId,
          label: input.label,
          direction: input.direction,
          description_fi: "Yksi lause suomeksi.",
          description_en: "One sentence in English.",
          embedding_fi: pgVector(input.fi),
          embedding_en: pgVector(input.en),
          embedding_model: input.model ?? activeModel,
        })
        .select("id")
        .single();
      if (inserted.error || !inserted.data) {
        throw new Error(`Creating preference failed: ${inserted.error?.message ?? "row missing"}`);
      }
      return inserted.data.id as string;
    }

    const rankingFixtureKeys = itemDefinitions
      .map((definition) => definition.key)
      .filter((key) => !key.startsWith("limit-candidate-") && !key.startsWith("rank-"));

    async function restoreMean(language: "fi" | "en"): Promise<void> {
      const { service } = clients();
      const original = originalMeans.find((row) => row.language === language);
      const result = original
        ? await service
            .from("embedding_language_means")
            .upsert(original, { onConflict: "embedding_model,language" })
        : await service
            .from("embedding_language_means")
            .delete()
            .eq("embedding_model", activeModel)
            .eq("language", language);
      if (result.error) {
        throw new Error(`Restoring ${language} mean failed: ${result.error.message}`);
      }
    }

    beforeAll(async () => {
      const { service, userAClient, userBClient } = clients();
      const userA = await service.auth.admin.createUser({
        email: emailA,
        password,
        email_confirm: true,
      });
      if (userA.error) throw new Error(`Creating user A failed: ${userA.error.message}`);
      userAId = userA.data.user.id;

      const userB = await service.auth.admin.createUser({
        email: emailB,
        password,
        email_confirm: true,
      });
      if (userB.error) throw new Error(`Creating user B failed: ${userB.error.message}`);
      userBId = userB.data.user.id;

      const [signInA, signInB] = await Promise.all([
        userAClient.auth.signInWithPassword({ email: emailA, password }),
        userBClient.auth.signInWithPassword({ email: emailB, password }),
      ]);
      if (signInA.error) throw new Error(`Signing in user A failed: ${signInA.error.message}`);
      if (signInB.error) throw new Error(`Signing in user B failed: ${signInB.error.message}`);

      const savedMeans = await service
        .from("embedding_language_means")
        .select("embedding_model,language,mean,item_count,computed_at")
        .eq("embedding_model", activeModel);
      if (savedMeans.error) {
        throw new Error(`Saving original means failed: ${savedMeans.error.message}`);
      }
      originalMeans = (savedMeans.data ?? []) as LanguageMeanRow[];

      const means = (["fi", "en"] as const).map((language) => ({
        embedding_model: activeModel,
        language,
        mean: pgVector(meanVectors[language]),
        item_count: 50,
        computed_at: new Date().toISOString(),
      }));
      const { error: meanError } = await service
        .from("embedding_language_means")
        .upsert(means, { onConflict: "embedding_model,language" });
      if (meanError) throw new Error(`Creating test means failed: ${meanError.message}`);

      const sources = await service
        .from("sources")
        .insert(
          sourceNames.map((name, index) => ({
            name: `${name} ${suffix}`,
            feed_url: `https://feed-integration.example/${suffix}/source-${index}`,
            kind: "rss",
            language: "en",
            is_active: true,
          })),
        )
        .select("id");
      if (sources.error) throw new Error(`Creating sources failed: ${sources.error.message}`);
      sourceIds.push(...sources.data.map((source) => source.id as string));

      const rows = itemDefinitions.map((definition) => {
        const embedding =
          definition.embedding === undefined
            ? addVectors(meanVectors[definition.language], definition.center)
            : definition.embedding;
        return {
          source_id: sourceIds[definition.source],
          type: definition.type ?? "article",
          url: `https://feed-integration.example/${suffix}/${definition.key}`,
          title: `feed-test-${definition.key}`,
          summary: "Ranking integration description",
          summary_origin: "feed",
          enrichment_status: "completed",
          language: definition.language,
          published_at:
            definition.ageMinutes === undefined
              ? publishedAt
              : new Date(Date.parse(publishedAt) - definition.ageMinutes * 60_000).toISOString(),
          embedding: embedding === null ? null : pgVector(embedding),
          embedding_model: definition.model === undefined ? activeModel : definition.model,
        };
      });
      const items = await service.from("content_items").insert(rows).select("id,title");
      if (items.error) throw new Error(`Creating items failed: ${items.error.message}`);
      for (const item of items.data) {
        itemIds.set(item.title.replace("feed-test-", ""), item.id as string);
      }

      const fixtureIds = new Set(itemIds.values());
      const batchSize = 500;
      for (let offset = 0; ; offset += batchSize) {
        const page = await service
          .from("content_items")
          .select("id")
          .eq("embedding_model", activeModel)
          .not("embedding", "is", null)
          .order("id")
          .range(offset, offset + batchSize - 1);
        if (page.error) {
          throw new Error(`Loading non-fixture items failed: ${page.error.message}`);
        }
        const neutralFeedback = page.data
          .filter((item) => !fixtureIds.has(item.id))
          .flatMap((item) =>
            [userAId, userBId].map((userId) => ({
              user_id: userId,
              item_id: item.id,
              kind: "seen",
              via: "button",
            })),
          );
        if (neutralFeedback.length > 0) {
          const { error } = await service.from("feedback").insert(neutralFeedback);
          if (error) {
            throw new Error(`Isolating test candidates failed: ${error.message}`);
          }
        }
        if (page.data.length < batchSize) break;
      }
    });

    beforeEach(async () => {
      const { service } = clients();
      if (userAId && userBId) {
        const { error } = await service
          .from("feedback")
          .delete()
          .in("user_id", [userAId, userBId])
          .in("item_id", [...itemIds.values()]);
        if (error) throw new Error(`Clearing test feedback failed: ${error.message}`);
        const { error: preferenceError } = await service
          .from("feed_preferences")
          .delete()
          .in("user_id", [userAId, userBId]);
        if (preferenceError) {
          throw new Error(`Clearing test preferences failed: ${preferenceError.message}`);
        }
      }
    });

    afterAll(async () => {
      const { service } = clients();
      for (const userId of [userAId, userBId]) {
        if (userId) await service.auth.admin.deleteUser(userId);
      }
      if (sourceIds.length > 0) {
        await service.from("content_items").delete().in("source_id", sourceIds);
        await service.from("sources").delete().in("id", sourceIds);
      }
      await restoreMean("fi");
      await restoreMean("en");
    });

    it("excludes items rated with any feedback action", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");
      await setFeedback(userAClient, "candidate-close", "not_interested");
      await setFeedback(userAClient, "candidate-unrelated", "seen");

      const feed = await getFeed(userAClient);
      const returnedIds = new Set(feed.map((row) => row.id));
      for (const key of ["liked-fi", "candidate-close", "candidate-unrelated"]) {
        expect(returnedIds.has(requireDefined(itemIds.get(key), `fixture item ${key}`))).toBe(
          false,
        );
      }
    });

    it("isolates another user's feedback and explains only with the caller's likes", async () => {
      const { userAClient, userBClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");
      await setFeedback(userBClient, "foreign-like", "like");

      const feed = await getFeed(userAClient);
      expect(feed.findIndex((row) => row.id === itemIds.get("candidate-close"))).toBeLessThan(
        feed.findIndex((row) => row.id === itemIds.get("foreign-match")),
      );
      for (const row of feed) {
        expect(["similar", "exploring"]).toContain(row.reason);
        expect(row.because_item_id).toBe(itemIds.get("liked-fi"));
      }
      expect(feed.some((row) => row.reason === "exploring")).toBe(true);
    });

    it("ranks an item near a like above an unrelated item of the same age", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");

      const feed = await getFeed(userAClient);
      expect(feed.findIndex((row) => row.id === itemIds.get("candidate-close"))).toBeLessThan(
        feed.findIndex((row) => row.id === itemIds.get("candidate-unrelated")),
      );
    });

    it("penalizes items near a Not interested signal", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");
      await setFeedback(userAClient, "disliked-fi", "not_interested");

      const feed = await getFeed(userAClient);
      const disliked = feed.find((row) => row.id === itemIds.get("candidate-close-dislike"));
      const neutral = feed.find((row) => row.id === itemIds.get("candidate-neutral"));
      assert(disliked, "Disliked candidate must exist");
      assert(neutral, "Neutral candidate must exist");
      expect(neutral.score).toBeGreaterThan(disliked.score);
    });

    it("round-robins cold-start sources and moves disliked topics last", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "disliked-fi", "not_interested");

      const feed = await getFeed(userAClient);
      const firstThree = feed.slice(0, 3).map((row) => row.source_name);
      const sourceOrder = feed.slice(0, 6).map((row) => ({
        source: row.source_name,
        key: [...itemIds.entries()].find(([, id]) => id === row.id)?.[0],
      }));
      expect(new Set(firstThree).size, JSON.stringify(sourceOrder)).toBe(3);
      const neutralIndex = feed.findIndex((row) => row.id === itemIds.get("cold-a1"));
      const dislikedIndex = feed.findIndex((row) => row.id === itemIds.get("cold-negative-match"));
      expect(neutralIndex).toBeGreaterThanOrEqual(0);
      expect(dislikedIndex).toBeGreaterThan(neutralIndex);
      expect(feed.find((row) => row.id === itemIds.get("cold-a1"))?.reason).toBe("recent");
    });

    it("uses language-centered vectors for cross-language similarity", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");

      const feed = await getFeed(userAClient);
      expect(
        feed.findIndex((row) => row.id === itemIds.get("candidate-cross-related")),
      ).toBeLessThan(feed.findIndex((row) => row.id === itemIds.get("candidate-same-unrelated")));
    });

    it("matches get_feed order when the service role ranks explicit likes and dislikes", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");
      await setFeedback(userAClient, "disliked-fi", "not_interested");

      const feed = await getFeed(userAClient);
      const ranking = await rankItems(
        rankingFixtureKeys.filter((key) => key !== "liked-fi" && key !== "disliked-fi"),
        ["liked-fi"],
        ["disliked-fi"],
        { p_params: { diversity: 0, exploration: true } },
      );

      expect(ranking.map((row) => row.item_id)).toEqual(feed.map((row) => row.id));
    });

    it("hides a site-wide description until its summary and embedding are restored", async () => {
      const { service, userAClient } = clients();
      const id = requireDefined(itemIds.get("sitewide-requeue"), "site-wide requeue fixture");
      const { error: metadataError } = await service
        .from("content_items")
        .update({
          summary: "Uutiset nopeasti ja luotettavasti.",
          summary_origin: "page_metadata",
        })
        .eq("id", id);
      expect(metadataError).toBeNull();

      const otherFixtureIds = [...itemIds.values()].filter((fixtureId) => fixtureId !== id);
      const loadFeed = () => getFeed(userAClient, { p_limit: 100, p_exclude: otherFixtureIds });
      expect((await loadFeed()).some((row) => row.id === id)).toBe(true);

      const db = createIngestDb({
        NEXT_PUBLIC_SUPABASE_URL: url,
        SUPABASE_SERVICE_ROLE_KEY: requireDefined(serviceKey, "local service-role key"),
      });
      expect(await db.requeueSiteWideDescriptionItems([id])).toBe(1);
      expect((await loadFeed()).some((row) => row.id === id)).toBe(false);

      expect(
        await db.saveEnrichedSummary(
          id,
          0,
          "A specific description for this article.",
          "ai_generated",
          new Date(),
        ),
      ).toBe(true);
      expect(
        await db.saveEmbedding(id, addVectors(meanVectors.fi, axisVector(8)), activeModel),
      ).toBe(true);
      expect((await loadFeed()).some((row) => row.id === id)).toBe(true);
    });

    it("uses the exact nearest-liked and average-vector score formulas", async () => {
      const asOf = publishedAt;
      const candidates = ["page-target"];
      const likes = ["page-old-like", "page-like"];

      const recency = { recency_weight: 0.1 };
      const nearest = await rankItems(candidates, likes, [], {
        p_as_of: asOf,
        p_method: "nearest_liked",
        p_params: recency,
      });
      const average = await rankItems(candidates, likes, [], {
        p_as_of: asOf,
        p_method: "average_vector",
        p_params: recency,
      });
      const disliked = await rankItems(["candidate-close-dislike"], ["liked-fi"], ["disliked-fi"], {
        p_as_of: asOf,
        p_method: "nearest_liked",
        p_params: recency,
      });
      const adjustedDislike = await rankItems(
        ["candidate-close-dislike"],
        ["liked-fi"],
        ["disliked-fi"],
        { p_as_of: asOf, p_method: "nearest_liked", p_params: { ...recency, lambda: 0.25 } },
      );

      expect(nearest[0]?.score).toBeCloseTo(0.1 + Math.SQRT1_2, 6);
      expect(average[0]?.score).toBeCloseTo(0.1, 6);
      expect(disliked[0]?.score).toBeCloseTo(-0.4, 6);
      expect(adjustedDislike[0]?.score).toBeCloseTo(-0.15, 6);
      expect(nearest[0]?.because_item_id).toBeTruthy();
      expect(average[0]?.because_item_id).toBeTruthy();
    });

    it("ignores feedback for newest-first and random baselines", async () => {
      const candidates = ["candidate-close", "candidate-unrelated", "candidate-neutral"];
      const newestWithFeedback = await rankItems(candidates, ["liked-fi"], ["disliked-fi"], {
        p_method: "newest_first",
      });
      const newestWithoutFeedback = await rankItems(candidates, [], [], {
        p_method: "newest_first",
      });
      const randomFirst = await rankItems(candidates, ["liked-fi"], ["disliked-fi"], {
        p_method: "random",
        p_seed: 42,
      });
      const randomSecond = await rankItems(candidates, [], [], {
        p_method: "random",
        p_seed: 42,
      });
      const coldNearest = await rankItems(candidates, [], ["disliked-fi"], {
        p_as_of: publishedAt,
      });
      const coldAverage = await rankItems(candidates, [], ["disliked-fi"], {
        p_as_of: publishedAt,
        p_method: "average_vector",
      });

      expect(newestWithFeedback.map((row) => row.item_id)).toEqual(
        newestWithoutFeedback.map((row) => row.item_id),
      );
      expect(randomFirst.map((row) => row.item_id)).toEqual(randomSecond.map((row) => row.item_id));
      expect(newestWithoutFeedback.every((row) => row.score === null)).toBe(true);
      expect(randomFirst.every((row) => row.score === null)).toBe(true);
      expect(coldAverage).toEqual(coldNearest);
    });

    it("supports raw cosine, rejects unknown parameters, and breaks score ties by id", async () => {
      const { service } = clients();
      const centered = await rankItems(["candidate-cross-related"], ["liked-fi"]);
      const raw = await rankItems(["candidate-cross-related"], ["liked-fi"], [], {
        p_params: { centered: false },
      });
      const tied = await rankItems(["candidate-unrelated", "candidate-neutral"], ["liked-fi"]);
      const invalid = await service.rpc("rank_items", {
        p_candidate_ids: [itemIds.get("candidate-neutral")],
        p_liked_ids: [],
        p_disliked_ids: [],
        p_as_of: publishedAt,
        p_params: { unexpected: true },
      });

      expect(centered[0]?.score).not.toBeCloseTo(raw[0]?.score ?? 0, 3);
      expect(centered).toHaveLength(1);
      expect(raw).toHaveLength(1);
      expect(tied.map((row) => row.item_id)).toEqual(tied.map((row) => row.item_id).toSorted());
      expect(invalid.error).not.toBeNull();
    });

    describe("interest models", () => {
      const likes = ["rank-like-1", "rank-like-2", "rank-like-3"];
      const candidates = ["rank-x", "rank-mid", "rank-cand-a", "rank-cand-b"];
      // `rank-x` has cosine 0.6, 0.8, and 0 to the three likes.
      const topTwoMean = 0.7;
      const topThreeMean = (0.6 + 0.8 + 0) / 3;
      const averageSimilarity = 7 / (5 * Math.sqrt(3));

      function rank(method: string, params: Record<string, unknown> = {}) {
        return rankItems(candidates, likes, [], {
          p_as_of: publishedAt,
          p_method: method,
          p_params: { recency_weight: 0, ...params },
        });
      }

      function scoreOf(rows: Awaited<ReturnType<typeof rank>>, key: string): number | undefined {
        return rows.find((row) => row.item_id === itemIds.get(key))?.score ?? undefined;
      }

      it("matches nearest_liked for top_m_mean m=1 and blend alpha=1, and average_vector for alpha=0", async () => {
        for (const centered of [true, false]) {
          const nearest = await rank("nearest_liked", { centered });
          const average = await rank("average_vector", { centered });
          expect(await rank("top_m_mean", { centered, top_m: 1 })).toEqual(nearest);
          expect(await rank("blend", { centered, blend_alpha: 1 })).toEqual(nearest);
          expect(await rank("blend", { centered, blend_alpha: 0 })).toEqual(average);
        }
      });

      it("computes top_m_mean and blend scores exactly", async () => {
        expect(scoreOf(await rank("top_m_mean", { top_m: 2 }), "rank-x")).toBeCloseTo(
          topTwoMean,
          5,
        );
        expect(scoreOf(await rank("top_m_mean", { top_m: 3 }), "rank-x")).toBeCloseTo(
          topThreeMean,
          5,
        );
        expect(scoreOf(await rank("blend", { blend_alpha: 0.5 }), "rank-x")).toBeCloseTo(
          0.5 * 0.8 + 0.5 * averageSimilarity,
          5,
        );
        expect(await rank("top_m_mean")).toEqual(await rank("top_m_mean", { top_m: 3 }));
        expect(await rank("blend")).toEqual(await rank("blend", { blend_alpha: 0.5 }));
      });

      it("uses all likes when m is larger than the number of likes", async () => {
        const all = await rank("top_m_mean", { top_m: 3 });
        expect(await rank("top_m_mean", { top_m: 5 })).toEqual(all);
        expect(await rank("top_m_mean", { top_m: 10 })).toEqual(all);
      });

      it("ranks both interests above an item between them only for nearest_liked", async () => {
        const nearest = await rank("nearest_liked");
        const average = await rank("average_vector");
        const order = (rows: typeof nearest) => rows.map((row) => row.item_id);
        const position = (rows: typeof nearest, key: string) =>
          order(rows).indexOf(requireDefined(itemIds.get(key), `fixture item ${key}`));

        expect(position(nearest, "rank-cand-a")).toBeLessThan(position(nearest, "rank-mid"));
        expect(position(nearest, "rank-cand-b")).toBeLessThan(position(nearest, "rank-mid"));
        expect(position(average, "rank-mid")).toBeLessThan(position(average, "rank-cand-a"));
        expect(position(average, "rank-mid")).toBeLessThan(position(average, "rank-cand-b"));
      });

      it("keeps the most similar like as the explanation for every method", async () => {
        for (const [method, params] of [
          ["nearest_liked", {}],
          ["average_vector", {}],
          ["top_m_mean", { top_m: 2 }],
          ["blend", { blend_alpha: 0.5 }],
        ] as const) {
          const rows = await rank(method, params);
          expect(
            rows.find((row) => row.item_id === itemIds.get("rank-x"))?.because_item_id,
            method,
          ).toBe(itemIds.get("rank-like-2"));
        }
      });

      it("rejects invalid top_m and blend_alpha values", async () => {
        const invalidParameters = [
          { top_m: 0 },
          { top_m: 11 },
          { top_m: 1.5 },
          { top_m: "2" },
          { blend_alpha: -0.1 },
          { blend_alpha: 1.1 },
          { blend_alpha: "0.5" },
        ];
        for (const params of invalidParameters) {
          await expect(rank("top_m_mean", params), JSON.stringify(params)).rejects.toThrow(
            "Ranking items failed",
          );
        }
      });

      it("orders cold start identically across interest models at each vector mode", async () => {
        const coldCandidates = ["rank-cold-1", "rank-cold-2", "rank-cold-3", "rank-fi-other"];
        for (const centered of [true, false]) {
          const orders = await Promise.all(
            (
              [
                ["nearest_liked", {}],
                ["average_vector", {}],
                ["top_m_mean", { top_m: 2 }],
                ["blend", { blend_alpha: 0.5 }],
              ] as const
            ).map(async ([method, params]) =>
              (
                await rankItems(coldCandidates, [], ["rank-cold-dislike"], {
                  p_method: method,
                  p_params: { centered, ...params },
                })
              ).map((row) => row.item_id),
            ),
          );
          for (const order of orders) expect(order).toEqual(orders[0]);
          expect(orders[0]?.at(-1)).toBe(itemIds.get("rank-cold-1"));
        }
      });

      it("lets the vector mode change cold-start dislike demotion", async () => {
        const order = async (centered: boolean) =>
          (
            await rankItems(["rank-en-cand", "rank-fi-other"], [], ["rank-en-dislike"], {
              p_params: { centered },
            })
          ).map((row) => row.item_id);
        const enCandidate = itemIds.get("rank-en-cand");
        const otherCandidate = itemIds.get("rank-fi-other");

        expect(await order(true)).toEqual([enCandidate, otherCandidate]);
        expect(await order(false)).toEqual([otherCandidate, enCandidate]);
      });

      it("keeps the documented defaults in sync with the scorer", async () => {
        const probes = ["rank-probe-article", "rank-probe-video"];
        const asOf = new Date(Date.parse(publishedAt) + 168 * 3600 * 1000).toISOString();
        const score = async (params: Record<string, unknown>) =>
          rankItems(probes, ["rank-like-1"], ["rank-cold-dislike"], {
            p_as_of: asOf,
            p_params: params,
          });
        const implicit = await score({});

        expect(await score(rankingDefaults)).toEqual(implicit);
        for (const changed of [{ lambda: 0.4 }, { recency_weight: 0.2 }, { centered: false }]) {
          expect(
            await score({ ...rankingDefaults, ...changed }),
            JSON.stringify(changed),
          ).not.toEqual(implicit);
        }

        // Half-lives only matter with a nonzero recency weight.
        const recent = await score({ recency_weight: 0.1 });
        expect(await score({ ...rankingDefaults, recency_weight: 0.1 })).toEqual(recent);
        for (const changed of [{ article_half_life_hours: 48 }, { video_half_life_hours: 336 }]) {
          expect(
            await score({ ...rankingDefaults, recency_weight: 0.1, ...changed }),
            JSON.stringify(changed),
          ).not.toEqual(recent);
        }
      });
    });

    describe("diversity and exploration", () => {
      const mmrCandidates = ["mmr-a", "mmr-b", "mmr-c", "mmr-negative", "mmr-zero"];
      const mmrLikes = ["mmr-like-a", "mmr-like-b"];

      const keyFor = (id: string | null | undefined) =>
        [...itemIds.entries()].find(([, fixtureId]) => fixtureId === id)?.[0];

      it("preserves scores and uses MMR in centered and raw-vector modes", async () => {
        for (const centered of [true, false]) {
          const baseline = await rankItems(mmrCandidates, mmrLikes, [], {
            p_as_of: publishedAt,
            p_method: "nearest_liked",
            p_params: { centered, diversity: 0 },
          });
          const implicit = await rankItems(mmrCandidates, mmrLikes, [], {
            p_as_of: publishedAt,
            p_method: "nearest_liked",
            p_params: { centered },
          });
          const diversified = await rankItems(mmrCandidates, mmrLikes, [], {
            p_as_of: publishedAt,
            p_method: "nearest_liked",
            p_params: { centered, diversity: 0.5 },
          });

          expect(implicit).toEqual(baseline);
          expect(diversified.slice(0, 3).map((row) => keyFor(row.item_id))).toEqual([
            "mmr-a",
            "mmr-negative",
            "mmr-c",
          ]);
          expect(new Set(diversified.map((row) => row.item_id)).size).toBe(mmrCandidates.length);
          for (const row of diversified) {
            expect(row.score).toBe(
              baseline.find((candidate) => candidate.item_id === row.item_id)?.score,
            );
          }
        }
      });

      it("uses signed similarity at diversity one and deterministic tie breaks", async () => {
        const params = {
          p_as_of: publishedAt,
          p_method: "nearest_liked",
          p_params: { diversity: 1 },
        };
        const first = await rankItems(mmrCandidates, mmrLikes, [], params);
        const second = await rankItems(mmrCandidates, mmrLikes, [], params);

        expect(first.slice(0, 2).map((row) => keyFor(row.item_id))).toEqual([
          "mmr-a",
          "mmr-negative",
        ]);
        expect(second).toEqual(first);
      });

      it("fills fixed exploration slots from any rank without losing main-sequence order", async () => {
        const limitCandidates = itemDefinitions
          .filter(({ key }) => key.startsWith("limit-candidate-"))
          .map(({ key }) => key);
        const base = await rankItems(limitCandidates, ["rank-like-1"], [], {
          p_as_of: publishedAt,
          p_params: { exploration: false },
          p_limit: 105,
        });
        const full = await rankItems(limitCandidates, ["rank-like-1"], [], {
          p_as_of: publishedAt,
          p_params: { exploration: true },
          p_limit: 30,
        });
        const short = await rankItems(limitCandidates, ["rank-like-1"], [], {
          p_as_of: publishedAt,
          p_params: { exploration: true },
          p_limit: 10,
        });
        const flagged = full.filter((row) => row.exploration);

        expect(flagged).toHaveLength(3);
        expect(flagged.map((row) => full.indexOf(row) + 1)).toEqual([5, 15, 25]);
        expect(
          flagged.every(
            (row) => base.findIndex((candidate) => candidate.item_id === row.item_id) >= 100,
          ),
        ).toBe(true);
        expect(full.filter((row) => !row.exploration).map((row) => row.item_id)).toEqual(
          base
            .filter((row) => !flagged.some((flag) => flag.item_id === row.item_id))
            .slice(0, 27)
            .map((row) => row.item_id),
        );
        expect(short).toEqual(full.slice(0, 10));
        expect(base.every((row) => row.exploration === false)).toBe(true);
      });

      it("ignores ineligible liked sources and falls back when a slot has no candidate", async () => {
        const topOfLikedSource = Array.from(
          { length: 10 },
          (_, index) => `limit-candidate-${index}`,
        );
        const withIneligibleLike = await rankItems(
          [...topOfLikedSource, "mmr-c"],
          ["rank-like-1", "no-embedding-signal"],
          [],
          {
            p_as_of: publishedAt,
            p_params: { exploration: true },
            p_limit: 10,
          },
        );
        expect(withIneligibleLike[4]?.item_id).toBe(itemIds.get("mmr-c"));
        expect(withIneligibleLike[4]?.exploration).toBe(true);

        const noAlternative = await rankItems(topOfLikedSource, ["rank-like-1"], [], {
          p_as_of: publishedAt,
          p_params: { exploration: true },
          p_limit: 10,
        });
        expect(noAlternative.every((row) => row.exploration === false)).toBe(true);
      });

      it("ignores both transformations for cold start and baseline methods", async () => {
        for (const method of ["nearest_liked", "average_vector", "newest_first", "random"]) {
          const params = { diversity: 1, exploration: true, centered: true };
          const normal = await rankItems(mmrCandidates, [], [], {
            p_as_of: publishedAt,
            p_method: method,
            p_params: {},
          });
          const transformed = await rankItems(mmrCandidates, [], [], {
            p_as_of: publishedAt,
            p_method: method,
            p_params: params,
          });
          expect(transformed).toEqual(normal);
        }
      });

      it("rejects invalid diversity and exploration parameters", async () => {
        const { service } = clients();
        for (const params of [
          { diversity: -0.1 },
          { diversity: 1.1 },
          { diversity: "0.3" },
          { exploration: "true" },
          { exploration: 1 },
        ]) {
          const { error } = await service.rpc("rank_items", {
            p_candidate_ids: [itemIds.get("mmr-a")],
            p_liked_ids: [itemIds.get("mmr-like-a")],
            p_disliked_ids: [],
            p_as_of: publishedAt,
            p_params: params,
          });
          expect(error, JSON.stringify(params)).not.toBeNull();
        }
      });
    });

    it("defaults to the tuned blend model in the scorer, wrapper, and get_feed", async () => {
      const { userAClient } = clients();
      const asOf = publishedAt;
      const implicit = await rankItems(
        ["rank-x"],
        ["rank-like-1", "rank-like-2", "rank-like-3"],
        [],
        {
          p_as_of: asOf,
        },
      );
      // Blend alpha 0.5 of the nearest like (0.8) and the average-vector similarity, no recency.
      expect(implicit[0]?.score).toBeCloseTo(0.5 * 0.8 + 0.5 * (7 / (5 * Math.sqrt(3))), 6);

      await setFeedback(userAClient, "liked-fi", "like");
      await setFeedback(userAClient, "disliked-fi", "not_interested");
      const feed = await getFeed(userAClient);
      const blend = await rankItems(
        rankingFixtureKeys.filter((key) => key !== "liked-fi" && key !== "disliked-fi"),
        ["liked-fi"],
        ["disliked-fi"],
        {
          p_method: "blend",
          p_params: { blend_alpha: 0.5, recency_weight: 0, diversity: 0, exploration: true },
        },
      );
      expect(feed.map((row) => row.id)).toEqual(blend.map((row) => row.item_id));
    });

    it("denies direct ranking to anonymous and signed-in clients", async () => {
      const { anonymous, service, userAClient } = clients();
      const args = {
        p_candidate_ids: [requireDefined(itemIds.get("candidate-close"), "candidate fixture")],
        p_liked_ids: [requireDefined(itemIds.get("liked-fi"), "like fixture")],
        p_disliked_ids: [requireDefined(itemIds.get("disliked-fi"), "dislike fixture")],
        p_as_of: publishedAt,
      };

      const anonymousResult = await anonymous.rpc("rank_items", args);
      expect(anonymousResult.error?.code).toBe("42501");

      const authenticatedResult = await userAClient.rpc("rank_items", args);
      expect(authenticatedResult.error?.code).toBe("42501");

      const privateResult = await userAClient.schema("ranking_private").rpc("rank_items", args);
      expect(privateResult.error?.code).toBe("PGRST106");

      const serviceResult = await service.rpc("rank_items", args);
      expect(serviceResult.error).toBeNull();
      expect(serviceResult.data).toEqual([
        {
          item_id: args.p_candidate_ids[0],
          score: expect.any(Number),
          because_item_id: args.p_liked_ids[0],
          exploration: false,
          because_preference_id: null,
        },
      ]);
    });

    it("rejects anonymous calls and clamps limits to 1 through 100", async () => {
      const { anonymous, userAClient } = clients();
      const anonymousResult = await anonymous.rpc("get_feed", { p_limit: 1 });
      expect(anonymousResult.error).not.toBeNull();

      const minimum = await getFeed(userAClient, { p_limit: 0 });
      const maximum = await getFeed(userAClient, {
        p_limit: 101,
        includeLimitFixtures: true,
      });
      expect(minimum).toHaveLength(1);
      expect(maximum).toHaveLength(100);
    });

    it("pages without duplicates and reflects a like given between pages", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "page-old-like", "like");

      const firstPage = await getFeed(userAClient, { p_limit: 1 });
      expect(firstPage).toHaveLength(1);
      const excludedIds = firstPage.map((row) => row.id);
      const beforeLike = await getFeed(userAClient, {
        p_limit: 1,
        p_exclude: excludedIds,
      });
      expect(beforeLike).toHaveLength(1);
      const beforeLikeItem = beforeLike[0];
      assert(beforeLikeItem, "Feed page must contain an item before liking");
      expect(excludedIds).not.toContain(beforeLikeItem.id);
      expect(beforeLikeItem.id).not.toBe(itemIds.get("page-target"));

      await setFeedback(userAClient, "page-like", "like");
      const afterLike = await getFeed(userAClient, {
        p_limit: 1,
        p_exclude: excludedIds,
      });
      const afterLikeKey = [...itemIds.entries()].find(([, id]) => id === afterLike[0]?.id)?.[0];
      expect(afterLikeKey, `winning row score: ${afterLike[0]?.score}`).toBe("page-target");
      expect(excludedIds).not.toContain(afterLike[0]?.id);
    });

    it("returns finite scores when a centered vector has zero length", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");

      const feed = await getFeed(userAClient);
      const zeroCentered = feed.find((row) => row.id === itemIds.get("zero-centered"));
      assert(zeroCentered, "Zero-centered fixture must appear in feed");
      expect(Number.isFinite(zeroCentered.score)).toBe(true);
      expect(feed.every((row) => Number.isFinite(row.score))).toBe(true);
    });

    it("ignores ineligible likes and never returns another embedding model", async () => {
      const { service, userAClient } = clients();
      await setFeedback(userAClient, "no-embedding-signal", "like");
      await setFeedback(userAClient, "no-mean-signal", "like");
      await setFeedback(userAClient, "other-model-signal", "like");

      const { error: deleteMeanError } = await service
        .from("embedding_language_means")
        .delete()
        .eq("embedding_model", activeModel)
        .eq("language", "en");
      if (deleteMeanError) {
        throw new Error(`Removing test English mean failed: ${deleteMeanError.message}`);
      }

      let restoreErrorMessage: string | undefined;
      try {
        const feed = await getFeed(userAClient);
        expect(feed.length).toBeGreaterThan(0);
        expect(feed.every((row) => row.reason === "recent")).toBe(true);
        expect(feed.some((row) => row.id === itemIds.get("other-model-candidate"))).toBe(false);
        expect(feed.some((row) => row.id === itemIds.get("no-embedding-signal"))).toBe(false);
      } finally {
        const { error } = await service.from("embedding_language_means").upsert(
          {
            embedding_model: activeModel,
            language: "en",
            mean: pgVector(meanVectors.en),
            item_count: 50,
            computed_at: new Date().toISOString(),
          },
          { onConflict: "embedding_model,language" },
        );
        if (error) restoreErrorMessage = error.message;
      }
      if (restoreErrorMessage !== undefined) {
        throw new Error(`Restoring test English mean failed: ${restoreErrorMessage}`);
      }
    });

    it("excludes unresolved items even when the user has feedback on them", async () => {
      const { service, userAClient } = clients();
      const { data: unresolved, error: insertError } = await service
        .from("content_items")
        .insert({
          source_id: sourceIds[0],
          type: "article",
          url: `https://feed-integration.example/${suffix}/unresolved-feedback`,
          title: "Unresolved feedback fixture",
          summary: null,
          summary_origin: null,
          enrichment_status: "pending",
          language: "fi",
          published_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      expect(insertError).toBeNull();

      const { error: feedbackError } = await userAClient.rpc("set_feedback", {
        p_item_id: unresolved?.id,
        p_kind: "like",
        p_via: "button",
      });
      expect(feedbackError).toBeNull();

      const feed = await getFeed(userAClient);
      expect(feed.some((row) => row.id === unresolved?.id)).toBe(false);
      expect(feed.every((row) => row.reason === "recent")).toBe(true);
    });

    it("personalizes from a more preference and penalizes a less preference", async () => {
      if (!userAId) throw new Error("Fixture user is missing.");
      const moreId = await insertPreference({
        userId: userAId,
        label: "Axis zero",
        direction: "more",
        fi: axisVector(0),
        en: addVectors(meanVectors.en, axisVector(30)),
      });
      const personalized = await rankItems(["candidate-close", "candidate-neutral"], [], [], {
        p_as_of: publishedAt,
        p_method: "nearest_liked",
        p_params: { recency_weight: 0, exploration: true },
        p_more_preference_ids: [moreId],
      });
      expect(personalized.map((row) => row.item_id)).toEqual([
        itemIds.get("candidate-close"),
        itemIds.get("candidate-neutral"),
      ]);
      expect(personalized[0]?.score).toBeCloseTo(1, 6);
      expect(personalized[0]?.because_item_id).toBeNull();
      expect(personalized[0]?.because_preference_id).toBe(moreId);
      expect(personalized.every((row) => row.exploration === false)).toBe(true);

      const lessId = await insertPreference({
        userId: userAId,
        label: "Axis zero less",
        direction: "less",
        fi: axisVector(0),
        en: addVectors(meanVectors.en, axisVector(31)),
      });
      const penalized = await rankItems(
        ["candidate-close", "candidate-unrelated"],
        ["candidate-neutral"],
        [],
        {
          p_as_of: publishedAt,
          p_method: "nearest_liked",
          p_params: { recency_weight: 0, lambda: 0.5 },
          p_less_preference_ids: [lessId],
        },
      );
      expect(penalized.map((row) => row.item_id)).toEqual([
        itemIds.get("candidate-unrelated"),
        itemIds.get("candidate-close"),
      ]);
      expect(penalized[1]?.score).toBeLessThan(penalized[0]?.score ?? 0);
    });

    it("centers each preference description in its own language", async () => {
      const { service } = clients();
      if (!userAId) throw new Error("Fixture user is missing.");
      const { data: candidate, error } = await service
        .from("content_items")
        .insert({
          source_id: sourceIds[0],
          type: "article",
          url: `https://feed-integration.example/${suffix}/preference-centering`,
          title: "Preference centering fixture",
          summary: "Ranking integration description",
          summary_origin: "feed",
          enrichment_status: "completed",
          language: "fi",
          published_at: publishedAt,
          embedding: pgVector(axisVector(4)),
          embedding_model: activeModel,
        })
        .select("id")
        .single();
      if (error || !candidate)
        throw new Error(`Creating centering fixture failed: ${error?.message}`);

      const preferenceId = await insertPreference({
        userId: userAId,
        label: "English axis",
        direction: "more",
        fi: axisVector(30),
        en: axisVector(4),
      });
      const { data, error: rankError } = await service.rpc("rank_items", {
        p_candidate_ids: [candidate.id],
        p_liked_ids: [],
        p_disliked_ids: [],
        p_as_of: publishedAt,
        p_method: "nearest_liked",
        p_params: { recency_weight: 0, centered: true },
        p_more_preference_ids: [preferenceId],
      });
      expect(rankError).toBeNull();
      expect(data?.[0]?.score).toBeCloseTo(0, 6);
      expect(data?.[0]?.score).not.toBeCloseTo(1, 6);
      expect(data?.[0]?.because_preference_id).toBe(preferenceId);
    });

    it("counts a preference as one signal in average, blend, and top-m scores", async () => {
      const { service } = clients();
      if (!userAId) throw new Error("Fixture user is missing.");
      const like = axisVector(10);
      const preferenceFi = addVectors(axisVector(10), axisVector(11));
      const preferenceEn = addVectors(meanVectors.en, axisVector(12));
      const candidate = axisVector(10);
      const inserted = await service
        .from("content_items")
        .insert([
          {
            source_id: sourceIds[0],
            type: "article",
            url: `https://feed-integration.example/${suffix}/preference-like`,
            title: "Preference score like",
            summary: "Ranking integration description",
            summary_origin: "feed",
            enrichment_status: "completed",
            language: "fi",
            published_at: publishedAt,
            embedding: pgVector(like),
            embedding_model: activeModel,
          },
          {
            source_id: sourceIds[1],
            type: "article",
            url: `https://feed-integration.example/${suffix}/preference-candidate`,
            title: "Preference score candidate",
            summary: "Ranking integration description",
            summary_origin: "feed",
            enrichment_status: "completed",
            language: "fi",
            published_at: publishedAt,
            embedding: pgVector(candidate),
            embedding_model: activeModel,
          },
        ])
        .select("id,title");
      if (inserted.error || !inserted.data) {
        throw new Error(`Creating score fixtures failed: ${inserted.error?.message}`);
      }
      const likeId = inserted.data.find((row) => row.title === "Preference score like")?.id;
      const candidateId = inserted.data.find(
        (row) => row.title === "Preference score candidate",
      )?.id;
      if (!likeId || !candidateId) throw new Error("Score fixtures were not created.");

      const preferenceId = await insertPreference({
        userId: userAId,
        label: "One signal",
        direction: "more",
        fi: preferenceFi,
        en: preferenceEn,
      });
      const averageVector = addVectors(
        axisVector(10, 0.75),
        addVectors(axisVector(11, 0.25), axisVector(12, 0.25)),
      );
      const wrongAverage = addVectors(
        axisVector(10, 2 / 3),
        addVectors(axisVector(11, 1 / 3), axisVector(12, 1 / 3)),
      );
      const averageSimilarity = cosine(candidate, averageVector);
      const wrongAverageSimilarity = cosine(candidate, wrongAverage);
      const preferenceSimilarity = Math.max(
        cosine(candidate, preferenceFi),
        cosine(candidate, axisVector(12)),
      );
      const nearest = Math.max(cosine(candidate, like), preferenceSimilarity);
      const oneSignalTopM = (nearest + preferenceSimilarity) / 2;
      const twoSignalTopM =
        (nearest + preferenceSimilarity + cosine(candidate, axisVector(12))) / 3;
      expect(averageSimilarity).not.toBeCloseTo(wrongAverageSimilarity, 3);
      expect(oneSignalTopM).not.toBeCloseTo(twoSignalTopM, 3);

      const rank = (method: string, params: Record<string, unknown> = {}) =>
        service.rpc("rank_items", {
          p_candidate_ids: [candidateId],
          p_liked_ids: [likeId],
          p_disliked_ids: [],
          p_as_of: publishedAt,
          p_method: method,
          p_params: { recency_weight: 0, lambda: 0, centered: true, top_m: 3, ...params },
          p_more_preference_ids: [preferenceId],
        });
      const average = await rank("average_vector");
      const blend = await rank("blend", { blend_alpha: 0.5 });
      const topM = await rank("top_m_mean");
      expect(average.error).toBeNull();
      expect(blend.error).toBeNull();
      expect(topM.error).toBeNull();
      expect(average.data?.[0]?.score).toBeCloseTo(averageSimilarity, 6);
      expect(average.data?.[0]?.score).not.toBeCloseTo(wrongAverageSimilarity, 3);
      expect(blend.data?.[0]?.score).toBeCloseTo(0.5 * nearest + 0.5 * averageSimilarity, 6);
      expect(topM.data?.[0]?.score).toBeCloseTo(oneSignalTopM, 6);
      expect(topM.data?.[0]?.score).not.toBeCloseTo(twoSignalTopM, 3);
    });

    it("ignores ineligible and duplicate preferences and rejects an ID in both lists", async () => {
      const { service } = clients();
      if (!userAId) throw new Error("Fixture user is missing.");
      const { error: meanError } = await service.from("embedding_language_means").upsert(
        {
          embedding_model: otherModel,
          language: "fi",
          mean: pgVector(meanVectors.fi),
          item_count: 50,
          computed_at: new Date().toISOString(),
        },
        { onConflict: "embedding_model,language" },
      );
      if (meanError) throw new Error(`Creating other-model mean failed: ${meanError.message}`);

      const wrongModel = await insertPreference({
        userId: userAId,
        label: "Wrong model",
        direction: "more",
        fi: axisVector(0),
        en: axisVector(0),
        model: otherModel,
      });
      const missingMean = await insertPreference({
        userId: userAId,
        label: "Missing mean",
        direction: "more",
        fi: axisVector(0),
        en: axisVector(0),
        model: "missing-mean@512",
      });
      const cold = await rankItems(["candidate-close", "candidate-neutral"], [], [], {
        p_as_of: publishedAt,
        p_more_preference_ids: [wrongModel, missingMean],
      });
      const baseline = await rankItems(["candidate-close", "candidate-neutral"], [], [], {
        p_as_of: publishedAt,
      });
      expect(cold.map((row) => row.item_id)).toEqual(baseline.map((row) => row.item_id));
      expect(cold.every((row) => row.because_preference_id === null)).toBe(true);

      const eligible = await insertPreference({
        userId: userAId,
        label: "Eligible",
        direction: "more",
        fi: axisVector(0),
        en: addVectors(meanVectors.en, axisVector(30)),
      });
      const once = await rankItems(["candidate-close"], [], [], {
        p_as_of: publishedAt,
        p_params: { recency_weight: 0 },
        p_more_preference_ids: [eligible],
      });
      const twice = await rankItems(["candidate-close"], [], [], {
        p_as_of: publishedAt,
        p_params: { recency_weight: 0 },
        p_more_preference_ids: [eligible, eligible],
      });
      expect(twice).toEqual(once);

      const { error } = await service.rpc("rank_items", {
        p_candidate_ids: [itemIds.get("candidate-close")],
        p_liked_ids: [],
        p_disliked_ids: [],
        p_as_of: publishedAt,
        p_more_preference_ids: [eligible],
        p_less_preference_ids: [eligible],
      });
      expect(error).not.toBeNull();
    });

    it("explains a tied positive signal with the like and ignores preferences in baselines", async () => {
      if (!userAId) throw new Error("Fixture user is missing.");
      const preferenceId = await insertPreference({
        userId: userAId,
        label: "Tied",
        direction: "more",
        fi: axisVector(0),
        en: addVectors(meanVectors.en, axisVector(30)),
        id: "00000000-0000-0000-0000-000000000001",
      });
      const tied = await rankItems(["candidate-close"], ["liked-fi"], [], {
        p_as_of: publishedAt,
        p_params: { recency_weight: 0 },
        p_more_preference_ids: [preferenceId],
      });
      expect(preferenceId < requireDefined(itemIds.get("liked-fi"), "like fixture")).toBe(true);
      expect(tied[0]?.because_item_id).toBe(itemIds.get("liked-fi"));
      expect(tied[0]?.because_preference_id).toBeNull();

      const candidates = ["candidate-close", "candidate-neutral"];
      const newest = await rankItems(candidates, [], [], { p_method: "newest_first" });
      const newestWithPreference = await rankItems(candidates, [], [], {
        p_method: "newest_first",
        p_less_preference_ids: [preferenceId],
      });
      const random = await rankItems(candidates, [], [], { p_method: "random", p_seed: 7 });
      const randomWithPreference = await rankItems(candidates, [], [], {
        p_method: "random",
        p_seed: 7,
        p_more_preference_ids: [preferenceId],
      });
      expect(newestWithPreference.map((row) => row.item_id)).toEqual(
        newest.map((row) => row.item_id),
      );
      expect(randomWithPreference.map((row) => row.item_id)).toEqual(
        random.map((row) => row.item_id),
      );
      expect(newestWithPreference.every((row) => row.because_preference_id === null)).toBe(true);
      expect(randomWithPreference.every((row) => row.because_preference_id === null)).toBe(true);
    });

    it("keeps cold-start round-robin and demotes less matches at the dislike threshold", async () => {
      if (!userAId) throw new Error("Fixture user is missing.");
      const lessId = await insertPreference({
        userId: userAId,
        label: "Cold less",
        direction: "less",
        fi: axisVector(13),
        en: addVectors(meanVectors.en, axisVector(31)),
      });
      const keys = ["rank-cold-1", "rank-cold-2", "rank-cold-3"];
      const baseline = await rankItems(keys, [], [], { p_as_of: publishedAt, p_method: "blend" });
      const others = await rankItems(["rank-cold-2", "rank-cold-3"], [], [], {
        p_as_of: publishedAt,
        p_method: "blend",
      });
      const demoted = await rankItems(keys, [], [], {
        p_as_of: publishedAt,
        p_method: "blend",
        p_less_preference_ids: [lessId],
      });
      const matchedId = itemIds.get("rank-cold-1");
      expect(demoted.at(-1)?.item_id).toBe(matchedId);
      expect(baseline.findIndex((row) => row.item_id === matchedId)).toBeLessThan(
        demoted.findIndex((row) => row.item_id === matchedId),
      );
      expect(demoted.slice(0, -1).map((row) => row.item_id)).toEqual(
        others.map((row) => row.item_id),
      );
      expect(demoted.every((row) => row.exploration === false)).toBe(true);
    });

    it("passes only the caller's preferences and returns the preference label", async () => {
      const { userAClient, userBClient } = clients();
      if (!userAId || !userBId) throw new Error("Fixture users are missing.");
      await insertPreference({
        userId: userAId,
        label: "A topic",
        direction: "more",
        fi: axisVector(2),
        en: addVectors(meanVectors.en, axisVector(30)),
      });
      await insertPreference({
        userId: userBId,
        label: "B topic",
        direction: "more",
        fi: axisVector(0),
        en: addVectors(meanVectors.en, axisVector(31)),
      });

      const feedA = await getFeed(userAClient);
      const feedB = await getFeed(userBClient);
      const closeA = feedA.find((row) => row.id === itemIds.get("candidate-close"));
      const closeB = feedB.find((row) => row.id === itemIds.get("candidate-close"));
      assert(closeA, "User A feed must include the close candidate");
      assert(closeB, "User B feed must include the close candidate");
      expect(closeA.reason).toBe("preference");
      expect(closeA.because_title).toBe("A topic");
      expect(closeB.reason).toBe("preference");
      expect(closeB.because_title).toBe("B topic");
      expect(feedA.every((row) => row.because_title !== "B topic")).toBe(true);
      expect(feedB.every((row) => row.because_title !== "A topic")).toBe(true);
      expect(feedA.every((row) => row.reason !== "exploring")).toBe(true);
    });
  },
);
