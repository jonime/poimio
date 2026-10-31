import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";

const enabled = process.env.SUPABASE_INTEGRATION === "1";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const activeModel = "text-embedding-3-small@512";
const otherModel = "older-model@512";
const meanVectors = {
  fi: new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
  en: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) =>
    index === 4 ? 10 : 0,
  ),
} as const;

interface ItemDefinition {
  key: string;
  source: number;
  language: "fi" | "en";
  center: number[];
  embedding?: number[] | null;
  model?: string | null;
}

interface FeedRow {
  id: string;
  source_name: string;
  score: number;
  reason: string;
  because_item_id: string | null;
  because_title: string | null;
}

interface LanguageMeanRow {
  embedding_model: string;
  language: "fi" | "en";
  mean: string;
  item_count: number;
  computed_at: string;
}

function axisVector(axis: number, sign = 1): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) =>
    index === axis ? sign : 0,
  );
}

function addVectors(left: number[], right: number[]): number[] {
  return left.map((value, index) => value + right[index]!);
}

function pgVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
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
  ...Array.from({ length: 105 }, (_, index) => ({
    key: `limit-candidate-${index}`,
    source: index % 3,
    language: "fi" as const,
    center: axisVector(2),
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
    const anonymous: SupabaseClient | null = anonKey
      ? createClient(url, anonKey, options)
      : null;
    const service: SupabaseClient | null = serviceKey
      ? createClient(url, serviceKey, options)
      : null;
    const userAClient: SupabaseClient | null = anonKey
      ? createClient(url, anonKey, options)
      : null;
    const userBClient: SupabaseClient | null = anonKey
      ? createClient(url, anonKey, options)
      : null;

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
    const sourceNames = [
      "Feed test source A",
      "Feed test source B",
      "Feed test source C",
    ];
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
      if (error)
        throw new Error(`Setting ${kind} feedback failed: ${error.message}`);
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
      const limitFixtureIds = includeLimitFixtures
        ? []
        : itemDefinitions
            .filter((definition) =>
              definition.key.startsWith("limit-candidate-"),
            )
            .map((definition) => itemIds.get(definition.key)!);
      const { data, error } = await client.rpc("get_feed", {
        ...rpcParameters,
        p_limit: rpcParameters.p_limit ?? 100,
        p_exclude: [
          ...new Set([...limitFixtureIds, ...(rpcParameters.p_exclude ?? [])]),
        ],
      });
      if (error) throw new Error(`Loading feed failed: ${error.message}`);
      return (data ?? []) as FeedRow[];
    }

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
        throw new Error(
          `Restoring ${language} mean failed: ${result.error.message}`,
        );
      }
    }

    beforeAll(async () => {
      const { service, userAClient, userBClient } = clients();
      const userA = await service.auth.admin.createUser({
        email: emailA,
        password,
        email_confirm: true,
      });
      if (userA.error)
        throw new Error(`Creating user A failed: ${userA.error.message}`);
      userAId = userA.data.user.id;

      const userB = await service.auth.admin.createUser({
        email: emailB,
        password,
        email_confirm: true,
      });
      if (userB.error)
        throw new Error(`Creating user B failed: ${userB.error.message}`);
      userBId = userB.data.user.id;

      const [signInA, signInB] = await Promise.all([
        userAClient.auth.signInWithPassword({ email: emailA, password }),
        userBClient.auth.signInWithPassword({ email: emailB, password }),
      ]);
      if (signInA.error)
        throw new Error(`Signing in user A failed: ${signInA.error.message}`);
      if (signInB.error)
        throw new Error(`Signing in user B failed: ${signInB.error.message}`);

      const savedMeans = await service
        .from("embedding_language_means")
        .select("embedding_model,language,mean,item_count,computed_at")
        .eq("embedding_model", activeModel);
      if (savedMeans.error) {
        throw new Error(
          `Saving original means failed: ${savedMeans.error.message}`,
        );
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
      if (meanError)
        throw new Error(`Creating test means failed: ${meanError.message}`);

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
      if (sources.error)
        throw new Error(`Creating sources failed: ${sources.error.message}`);
      sourceIds.push(...sources.data.map((source) => source.id as string));

      const rows = itemDefinitions.map((definition) => {
        const embedding =
          definition.embedding === undefined
            ? addVectors(meanVectors[definition.language], definition.center)
            : definition.embedding;
        return {
          source_id: sourceIds[definition.source],
          type: "article",
          url: `https://feed-integration.example/${suffix}/${definition.key}`,
          title: `feed-test-${definition.key}`,
          summary: "Ranking integration description",
          summary_origin: "feed",
          enrichment_status: "completed",
          language: definition.language,
          published_at: publishedAt,
          embedding: embedding === null ? null : pgVector(embedding),
          embedding_model:
            definition.model === undefined ? activeModel : definition.model,
        };
      });
      const items = await service
        .from("content_items")
        .insert(rows)
        .select("id,title");
      if (items.error)
        throw new Error(`Creating items failed: ${items.error.message}`);
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
          throw new Error(
            `Loading non-fixture items failed: ${page.error.message}`,
          );
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
          const { error } = await service
            .from("feedback")
            .insert(neutralFeedback);
          if (error) {
            throw new Error(
              `Isolating test candidates failed: ${error.message}`,
            );
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
        if (error)
          throw new Error(`Clearing test feedback failed: ${error.message}`);
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
      for (const key of [
        "liked-fi",
        "candidate-close",
        "candidate-unrelated",
      ]) {
        expect(returnedIds.has(itemIds.get(key)!)).toBe(false);
      }
    });

    it("isolates another user's feedback and explains only with the caller's likes", async () => {
      const { userAClient, userBClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");
      await setFeedback(userBClient, "foreign-like", "like");

      const feed = await getFeed(userAClient);
      expect(
        feed.findIndex((row) => row.id === itemIds.get("candidate-close")),
      ).toBeLessThan(
        feed.findIndex((row) => row.id === itemIds.get("foreign-match")),
      );
      for (const row of feed) {
        expect(row.reason).toBe("similar");
        expect(row.because_item_id).toBe(itemIds.get("liked-fi"));
      }
    });

    it("ranks an item near a like above an unrelated item of the same age", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");

      const feed = await getFeed(userAClient);
      expect(
        feed.findIndex((row) => row.id === itemIds.get("candidate-close")),
      ).toBeLessThan(
        feed.findIndex((row) => row.id === itemIds.get("candidate-unrelated")),
      );
    });

    it("penalizes items near a Not interested signal", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");
      await setFeedback(userAClient, "disliked-fi", "not_interested");

      const feed = await getFeed(userAClient);
      const disliked = feed.find(
        (row) => row.id === itemIds.get("candidate-close-dislike"),
      );
      const neutral = feed.find(
        (row) => row.id === itemIds.get("candidate-neutral"),
      );
      expect(disliked).toBeDefined();
      expect(neutral).toBeDefined();
      expect(neutral!.score).toBeGreaterThan(disliked!.score);
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
      const neutralIndex = feed.findIndex(
        (row) => row.id === itemIds.get("cold-a1"),
      );
      const dislikedIndex = feed.findIndex(
        (row) => row.id === itemIds.get("cold-negative-match"),
      );
      expect(neutralIndex).toBeGreaterThanOrEqual(0);
      expect(dislikedIndex).toBeGreaterThan(neutralIndex);
      expect(
        feed.find((row) => row.id === itemIds.get("cold-a1"))?.reason,
      ).toBe("recent");
    });

    it("uses language-centered vectors for cross-language similarity", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");

      const feed = await getFeed(userAClient);
      expect(
        feed.findIndex(
          (row) => row.id === itemIds.get("candidate-cross-related"),
        ),
      ).toBeLessThan(
        feed.findIndex(
          (row) => row.id === itemIds.get("candidate-same-unrelated"),
        ),
      );
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
      expect(excludedIds).not.toContain(beforeLike[0]!.id);
      expect(beforeLike[0]!.id).not.toBe(itemIds.get("page-target"));

      await setFeedback(userAClient, "page-like", "like");
      const afterLike = await getFeed(userAClient, {
        p_limit: 1,
        p_exclude: excludedIds,
      });
      const afterLikeKey = [...itemIds.entries()].find(
        ([, id]) => id === afterLike[0]?.id,
      )?.[0];
      expect(afterLikeKey, `winning row score: ${afterLike[0]?.score}`).toBe(
        "page-target",
      );
      expect(excludedIds).not.toContain(afterLike[0]?.id);
    });

    it("returns finite scores when a centered vector has zero length", async () => {
      const { userAClient } = clients();
      await setFeedback(userAClient, "liked-fi", "like");

      const feed = await getFeed(userAClient);
      const zeroCentered = feed.find(
        (row) => row.id === itemIds.get("zero-centered"),
      );
      expect(zeroCentered).toBeDefined();
      expect(Number.isFinite(zeroCentered!.score)).toBe(true);
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
        throw new Error(
          `Removing test English mean failed: ${deleteMeanError.message}`,
        );
      }

      try {
        const feed = await getFeed(userAClient);
        expect(feed.length).toBeGreaterThan(0);
        expect(feed.every((row) => row.reason === "recent")).toBe(true);
        expect(
          feed.some((row) => row.id === itemIds.get("other-model-candidate")),
        ).toBe(false);
        expect(
          feed.some((row) => row.id === itemIds.get("no-embedding-signal")),
        ).toBe(false);
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
        if (error)
          throw new Error(
            `Restoring test English mean failed: ${error.message}`,
          );
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
  },
);
