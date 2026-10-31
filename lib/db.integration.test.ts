/**
 * Integration tests for the ingestion database writes (spec 001, task 6).
 *
 * These run against a real Postgres with the project migrations applied,
 * using the service-role key, and are skipped by default (so `pnpm test`
 * stays hermetic). To run them against the local stack:
 *
 *   supabase start
 *   supabase db reset
 *   SUPABASE_INTEGRATION=1 \
 *     SUPABASE_SERVICE_ROLE_KEY=<local service key printed by `supabase start`> \
 *     pnpm test lib/db.integration.test.ts
 *
 * For the cloud project, also set `SUPABASE_URL` to the project URL. The
 * tests create throwaway rows and clean them up afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createIngestDb,
  recordSourceOutcome,
  type BackfillDb,
  type IngestDb,
  type Source,
} from "./db";
import type { ParsedItem } from "./normalize/parse";

const enabled = process.env.SUPABASE_INTEGRATION === "1";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!enabled || serviceKey == null)(
  "IngestDb against a real database",
  () => {
    // Built unconditionally: the describe callback runs during collection
    // even when the suite is skipped, and `createClient` throws on a null
    // key. `null` only happens in that skipped case, where no test runs.
    const client: SupabaseClient | null = serviceKey
      ? createClient(url, serviceKey)
      : null;
    const db: (IngestDb & BackfillDb) | null =
      client != null
        ? createIngestDb({
            NEXT_PUBLIC_SUPABASE_URL: url,
            SUPABASE_SERVICE_ROLE_KEY: serviceKey,
          })
        : null;

    /** Narrows the nullable handles; tests only run when ready. */
    function ready(): { client: SupabaseClient; db: IngestDb & BackfillDb } {
      if (client == null || db == null) {
        throw new Error("integration environment not ready");
      }
      return { client, db };
    }

    /** Unique per run, so the tests never collide with real content. */
    const prefix = `https://poimio-integration.example/${Date.now()}`;
    let sourceA: Source;
    let sourceB: Source;

    function item(urlValue: string, title: string): ParsedItem {
      return {
        url: urlValue,
        title,
        summary: "Integration test summary",
        type: "article",
        categories: ["Test"],
        thumbnailUrl: null,
        publishedAt: new Date("2026-10-28T08:00:00.000Z"),
      };
    }

    async function makeSource(name: string, feedUrl: string): Promise<Source> {
      const { client } = ready();
      const { data, error } = await client
        .from("sources")
        .insert({
          name,
          feed_url: feedUrl,
          kind: "rss",
          language: "en",
          is_active: true,
        })
        .select()
        .single();
      if (error) {
        throw new Error(`creating test source failed: ${error.message}`);
      }
      return {
        id: data.id as string,
        name: data.name as string,
        feedUrl: data.feed_url as string,
        siteUrl: null,
        kind: "rss",
        language: "en",
        isActive: true,
        etag: null,
        lastModified: null,
        lastFetchedAt: null,
        lastSuccessAt: null,
        lastError: null,
        createdAt: data.created_at as string,
      };
    }

    beforeAll(async () => {
      sourceA = await makeSource("Integration test A", `${prefix}/feed-a`);
      sourceB = await makeSource("Integration test B", `${prefix}/feed-b`);
    });

    afterAll(async () => {
      const { client } = ready();
      await client
        .from("content_items")
        .delete()
        .in("source_id", [sourceA.id, sourceB.id]);
      await client.from("sources").delete().in("id", [sourceA.id, sourceB.id]);
    });

    it("lists the seeded active sources", async () => {
      const { db } = ready();
      const sources = await db.listActiveSources();
      expect(sources.length).toBeGreaterThanOrEqual(17);
      const names = sources.map((s) => s.name);
      expect(names).toContain("Yle — Latest News");
      expect(names).toContain("Engineering Explained");
      expect(sources.every((s) => s.isActive)).toBe(true);
    });

    it("inserts items, then reports 0 new on a repeat run (on conflict do nothing)", async () => {
      const { client, db } = ready();
      const items = [
        item(`${prefix}/a`, "Item A"),
        item(`${prefix}/b`, "Item B"),
      ];

      expect(await db.insertItems(sourceA, items)).toBe(2);
      // Re-inserting the same items (unchanged feed) adds nothing.
      expect(await db.insertItems(sourceA, items)).toBe(0);

      const { data, error } = await client
        .from("content_items")
        .select("source_id,url,title,summary,language")
        .in("url", [`${prefix}/a`, `${prefix}/b`]);
      expect(error).toBeNull();
      expect(data).toHaveLength(2);
    });

    it("lets the first source win when two sources deliver the same URL", async () => {
      const { client, db } = ready();
      const shared = item(`${prefix}/shared`, "Shared item");

      expect(await db.insertItems(sourceA, [shared])).toBe(1);
      expect(await db.insertItems(sourceB, [shared])).toBe(0);

      const { data, error } = await client
        .from("content_items")
        .select("source_id")
        .eq("url", `${prefix}/shared`)
        .single();
      expect(error).toBeNull();
      expect(data?.source_id).toBe(sourceA.id);
    });

    it("persists feed provenance only for non-empty summaries", async () => {
      const { client, db } = ready();
      const nonEmpty = item(`${prefix}/summary`, "Summary");
      const empty = { ...item(`${prefix}/empty`, "Empty"), summary: "  " };

      expect(await db.insertItems(sourceA, [nonEmpty, empty])).toBe(2);

      const { data, error } = await client
        .from("content_items")
        .select("url,summary,summary_origin,enrichment_status")
        .in("url", [nonEmpty.url, empty.url]);
      expect(error).toBeNull();
      expect(data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: nonEmpty.url,
            summary: "Integration test summary",
            summary_origin: "feed",
            enrichment_status: "completed",
          }),
          expect.objectContaining({
            url: empty.url,
            summary: null,
            summary_origin: null,
            enrichment_status: "pending",
          }),
        ]),
      );
    });

    it("selects due unresolved rows and saves descriptions before embeddings", async () => {
      const { client, db } = ready();
      const unresolved = {
        ...item(`${prefix}/enrichment-success`, "Enrichment success"),
        summary: "  ",
      };
      await db.insertItems(sourceA, [unresolved]);
      const { data: inserted, error: insertError } = await client
        .from("content_items")
        .select("id")
        .eq("url", unresolved.url)
        .single();
      expect(insertError).toBeNull();

      const id = inserted?.id as string;
      const now = new Date("2026-10-31T12:00:00.000Z");
      const due = await db.listDueEnrichmentItems(1_000, now);
      expect(due.some((candidate) => candidate.id === id)).toBe(true);
      expect(
        await db.saveEnrichedSummary(
          id,
          0,
          "A page metadata description",
          "page_metadata",
          now,
        ),
      ).toBe(true);

      const { data, error } = await client
        .from("content_items")
        .select(
          "summary,summary_origin,enrichment_status,enrichment_attempt_count,embedding,embedding_model",
        )
        .eq("id", id)
        .single();
      expect(error).toBeNull();
      expect(data).toMatchObject({
        summary: "A page metadata description",
        summary_origin: "page_metadata",
        enrichment_status: "completed",
        enrichment_attempt_count: 1,
        embedding: null,
        embedding_model: null,
      });
      expect(
        (await db.listDueEnrichmentItems(1_000, now)).some(
          (candidate) => candidate.id === id,
        ),
      ).toBe(false);
      expect(
        (await db.listUnembeddedItems()).some(
          (candidate) => candidate.id === id,
        ),
      ).toBe(true);
    });

    it("rejects embeddings on unresolved items so ranking cannot admit them", async () => {
      const { client, db } = ready();
      const unresolved = {
        ...item(`${prefix}/unresolved-embedding`, "Unresolved embedding"),
        summary: "",
      };
      await db.insertItems(sourceA, [unresolved]);
      const { data: inserted, error: insertError } = await client
        .from("content_items")
        .select("id")
        .eq("url", unresolved.url)
        .single();
      expect(insertError).toBeNull();
      const id = inserted?.id as string;
      const vector = `[${Array<number>(512).fill(0).join(",")}]`;

      const { error } = await client
        .from("content_items")
        .update({ embedding: vector, embedding_model: "title-only@512" })
        .eq("id", id);
      expect(error?.code).toBe("23514");

      const { data: unresolvedWithVectors, error: queryError } = await client
        .from("content_items")
        .select("id")
        .neq("enrichment_status", "completed")
        .not("embedding", "is", null);
      expect(queryError).toBeNull();
      expect(unresolvedWithVectors).toEqual([]);
    });

    it("does not select future retries and excludes exhausted rows", async () => {
      const { client, db } = ready();
      const unresolved = {
        ...item(`${prefix}/enrichment-retry`, "Enrichment retry"),
        summary: "",
      };
      await db.insertItems(sourceA, [unresolved]);
      const { data: inserted, error: insertError } = await client
        .from("content_items")
        .select("id")
        .eq("url", unresolved.url)
        .single();
      expect(insertError).toBeNull();
      const id = inserted?.id as string;
      const firstAttempt = new Date("2026-10-31T12:00:00.000Z");
      const retryAt = new Date(firstAttempt.getTime() + 60 * 60 * 1000);

      expect(
        await db.saveEnrichmentFailure(
          id,
          0,
          firstAttempt,
          retryAt,
          "page fetch failed",
          false,
        ),
      ).toBe(true);
      expect(
        (await db.listDueEnrichmentItems(1_000, firstAttempt)).some(
          (candidate) => candidate.id === id,
        ),
      ).toBe(false);
      expect(
        (await db.listDueEnrichmentItems(1_000, retryAt)).some(
          (candidate) => candidate.id === id,
        ),
      ).toBe(true);

      expect(
        await db.saveEnrichmentFailure(
          id,
          1,
          retryAt,
          null,
          "retry limit reached",
          true,
        ),
      ).toBe(true);
      expect(
        (
          await db.listDueEnrichmentItems(
            1_000,
            new Date("2026-11-02T00:00:00Z"),
          )
        ).some((candidate) => candidate.id === id),
      ).toBe(false);
    });

    it("only requeues an exhausted item through the explicit backfill method", async () => {
      const { client, db } = ready();
      const unresolved = {
        ...item(`${prefix}/enrichment-requeue`, "Enrichment requeue"),
        summary: "",
      };
      await db.insertItems(sourceA, [unresolved]);
      const { data: inserted, error: insertError } = await client
        .from("content_items")
        .select("id")
        .eq("url", unresolved.url)
        .single();
      expect(insertError).toBeNull();
      const id = inserted?.id as string;
      const now = new Date("2026-10-31T12:00:00.000Z");

      expect(
        await db.saveEnrichmentFailure(id, 0, now, null, "exhausted", true),
      ).toBe(true);
      expect(
        (await db.listExhaustedEnrichmentItems(1_000)).some(
          (candidate) => candidate.id === id,
        ),
      ).toBe(true);
      expect(await db.requeueExhaustedEnrichmentItems([id])).toBe(1);

      const requeued = await db.listDueEnrichmentItems(1_000, now, [id]);
      expect(requeued).toHaveLength(1);
      expect(requeued[0]).toMatchObject({ id, attemptCount: 0 });
    });

    it("rejects invalid provenance and enrichment-state combinations", async () => {
      const { client } = ready();
      const base = {
        source_id: sourceA.id,
        type: "article",
        title: "Invalid state fixture",
        language: "en",
        categories: [],
        published_at: new Date("2026-10-28T08:00:00.000Z").toISOString(),
      };
      const invalidStates = [
        {
          summary: "A summary",
          summary_origin: "unknown",
          enrichment_status: "completed",
        },
        {
          summary: "A summary",
          summary_origin: null,
          enrichment_status: "completed",
        },
        {
          summary: "A summary",
          summary_origin: null,
          enrichment_status: "pending",
        },
      ];

      for (const [index, state] of invalidStates.entries()) {
        const { error } = await client.from("content_items").insert({
          ...base,
          url: `${prefix}/invalid-state-${index}`,
          ...state,
        });
        expect(error).not.toBeNull();
        expect(error?.code).toBe("23514");
      }
    });

    it("applies source status patches to the right row and fields", async () => {
      const { client, db } = ready();
      const now = new Date();
      await db.updateSource(sourceA.id, {
        etag: "w/abc",
        lastModified: "Wed, 28 Oct 2026 08:00:00 GMT",
        lastFetchedAt: now,
        lastError: "HTTP 404 Not Found",
      });

      const { data, error } = await client
        .from("sources")
        .select("etag,last_modified,last_fetched_at,last_success_at,last_error")
        .eq("id", sourceA.id)
        .single();
      expect(error).toBeNull();
      expect(data?.etag).toBe("w/abc");
      expect(data?.last_modified).toBe("Wed, 28 Oct 2026 08:00:00 GMT");
      expect(
        Math.abs(Date.parse(data?.last_fetched_at ?? "") - now.getTime()),
      ).toBeLessThan(5000);
      expect(data?.last_success_at).toBeNull();
      expect(data?.last_error).toBe("HTTP 404 Not Found");
    });

    it("recordSourceOutcome: a parse failure clears the conditional-GET state", async () => {
      const { client, db } = ready();
      // Seed some conditional-GET state first.
      await client
        .from("sources")
        .update({
          etag: "w/old",
          last_modified: "Tue, 27 Oct 2026 08:00:00 GMT",
        })
        .eq("id", sourceB.id);

      const now = new Date();
      await recordSourceOutcome(
        db,
        sourceB.id,
        { kind: "error", phase: "parse", error: "unsupported feed format" },
        now,
      );

      const { data, error } = await client
        .from("sources")
        .select("etag,last_modified,last_error,last_success_at")
        .eq("id", sourceB.id)
        .single();
      expect(error).toBeNull();
      expect(data?.etag).toBeNull();
      expect(data?.last_modified).toBeNull();
      expect(data?.last_error).toBe("unsupported feed format");
      expect(data?.last_success_at).toBeNull();
    });

    it("a successful fetch records success and the new conditional-GET headers", async () => {
      const { client, db } = ready();
      const now = new Date();
      await recordSourceOutcome(
        db,
        sourceA.id,
        {
          kind: "fetched",
          newItems: 2,
          etag: "w/new",
          lastModified: "Wed, 28 Oct 2026 09:00:00 GMT",
        },
        now,
      );

      const { data, error } = await client
        .from("sources")
        .select("etag,last_modified,last_success_at,last_error")
        .eq("id", sourceA.id)
        .single();
      expect(error).toBeNull();
      expect(data?.etag).toBe("w/new");
      expect(data?.last_modified).toBe("Wed, 28 Oct 2026 09:00:00 GMT");
      expect(data?.last_error).toBeNull();
      expect(Date.parse(data?.last_success_at ?? "")).toBeGreaterThan(0);
    });
  },
);
