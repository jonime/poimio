import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIngestDb } from "./db.ts";
import { scanInactiveCatalog } from "./source-discovery-scan.ts";

const enabled = process.env.SUPABASE_INTEGRATION === "1";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!enabled || anonKey == null || serviceKey == null)(
  "source discovery database access",
  () => {
    const options = {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    };
    const anonymous = anonKey ? createClient(url, anonKey, options) : null;
    const service = serviceKey ? createClient(url, serviceKey, options) : null;
    const userA = anonKey ? createClient(url, anonKey, options) : null;
    const userB = anonKey ? createClient(url, anonKey, options) : null;
    const adminB = anonKey ? createClient(url, anonKey, options) : null;
    const testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const password = `Discovery-${testId}-Aa1!`;
    const emails = [
      `discovery-a-${testId}@example.test`,
      `discovery-b-${testId}@example.test`,
      `discovery-admin-b-${testId}@example.test`,
    ] as const;
    let userAId: string;
    let userBId: string;
    let adminBId: string;
    const sourceIds: string[] = [];
    const candidateIds: string[] = [];
    const runIds: string[] = [];
    let fixtureCandidateId: string;
    let fixtureSourceId: string;

    function ready() {
      if (!anonymous || !service || !userA || !userB || !adminB) {
        throw new Error("source discovery integration environment is not ready");
      }
      return { anonymous, service, userA, userB, adminB };
    }

    async function addCatalogCandidate(
      suffix: string,
      sourceFeedUrl = `https://discovery-${suffix}-${testId}.example/feed`,
      candidateFeedUrl = sourceFeedUrl,
    ) {
      const { service: db } = ready();
      const { data: source, error: sourceError } = await db
        .from("sources")
        .insert({
          name: `Discovery ${suffix}`,
          feed_url: sourceFeedUrl,
          kind: "rss",
          language: "en",
          is_active: false,
        })
        .select("id")
        .single();
      if (sourceError) throw new Error(`creating discovery source failed: ${sourceError.message}`);
      sourceIds.push(source.id);

      const { data: candidate, error: candidateError } = await db
        .from("source_candidates")
        .insert({
          origin: "catalog",
          source_id: source.id,
          name: `Discovery ${suffix}`,
          feed_url: candidateFeedUrl,
          kind: "rss",
          language: "en",
          status: "pending",
        })
        .select("id")
        .single();
      if (candidateError) {
        throw new Error(`creating discovery candidate failed: ${candidateError.message}`);
      }
      candidateIds.push(candidate.id);
      return { sourceId: source.id, candidateId: candidate.id };
    }

    async function addInactiveSource(suffix: string) {
      const { service: db } = ready();
      const feedUrl = `https://discovery-${suffix}-${testId}.example/feed`;
      const { data: source, error } = await db
        .from("sources")
        .insert({
          name: `Discovery ${suffix}`,
          feed_url: feedUrl,
          kind: "rss",
          language: "en",
          is_active: false,
        })
        .select("id")
        .single();
      if (error) throw new Error(`creating inactive discovery source failed: ${error.message}`);
      sourceIds.push(source.id);
      return { id: source.id, feedUrl };
    }

    beforeAll(async () => {
      const { service: db, userA: clientA, userB: clientB, adminB: clientAdminB } = ready();
      const created = await Promise.all(
        emails.map((email) => db.auth.admin.createUser({ email, password, email_confirm: true })),
      );
      for (const [index, result] of created.entries()) {
        if (result.error) {
          throw new Error(`creating discovery test user failed: ${result.error.message}`);
        }
        if (index === 0) userAId = result.data.user.id;
        if (index === 1) userBId = result.data.user.id;
        if (index === 2) adminBId = result.data.user.id;
      }

      const signIns = await Promise.all([
        clientA.auth.signInWithPassword({ email: emails[0], password }),
        clientB.auth.signInWithPassword({ email: emails[1], password }),
        clientAdminB.auth.signInWithPassword({ email: emails[2], password }),
      ]);
      for (const result of signIns) {
        if (result.error) {
          throw new Error(`signing in discovery test user failed: ${result.error.message}`);
        }
      }

      const { error: adminError } = await db
        .from("admins")
        .insert([{ user_id: userAId }, { user_id: adminBId }]);
      if (adminError) throw new Error(`creating admin fixtures failed: ${adminError.message}`);

      const fixture = await addCatalogCandidate("visibility");
      fixtureCandidateId = fixture.candidateId;
      fixtureSourceId = fixture.sourceId;
    });

    afterAll(async () => {
      const { service: db } = ready();
      if (candidateIds.length > 0) {
        await db.from("source_candidates").delete().in("id", candidateIds);
      }
      if (sourceIds.length > 0) await db.from("sources").delete().in("id", sourceIds);
      if (runIds.length > 0) await db.from("source_discovery_runs").delete().in("id", runIds);
      if (userAId) await db.from("admins").delete().eq("user_id", userAId);
      if (adminBId) await db.from("admins").delete().eq("user_id", adminBId);
      for (const id of [userAId, userBId, adminBId]) {
        if (id) await db.auth.admin.deleteUser(id);
      }
    });

    it("limits admins membership to each user's own row", async () => {
      const { userA: clientA, userB: clientB, adminB: clientAdminB } = ready();
      const [a, b, adminBMembership] = await Promise.all([
        clientA.from("admins").select("user_id"),
        clientB.from("admins").select("user_id"),
        clientAdminB.from("admins").select("user_id"),
      ]);
      expect(a.error).toBeNull();
      expect(a.data?.map((row) => row.user_id)).toEqual([userAId]);
      expect(b.error).toBeNull();
      expect(b.data).toEqual([]);
      expect(adminBMembership.error).toBeNull();
      expect(adminBMembership.data?.map((row) => row.user_id)).toEqual([adminBId]);
    });

    it("exposes candidates and runs only to admins", async () => {
      const { userA: clientA, userB: clientB, service: db } = ready();
      const run = await db
        .from("source_discovery_runs")
        .insert({
          kind: "catalog",
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        })
        .select("id")
        .single();
      if (run.error) throw new Error(`creating discovery run failed: ${run.error.message}`);
      const runId = run.data.id;
      runIds.push(runId);

      const [adminCandidates, userCandidates, adminRuns, userRuns] = await Promise.all([
        clientA.from("source_candidates").select("id"),
        clientB.from("source_candidates").select("id"),
        clientA.from("source_discovery_runs").select("id").eq("id", runId),
        clientB.from("source_discovery_runs").select("id").eq("id", runId),
      ]);
      expect(adminCandidates.error).toBeNull();
      expect(adminCandidates.data?.some((row) => row.id === fixtureCandidateId)).toBe(true);
      expect(userCandidates.error).toBeNull();
      expect(userCandidates.data).toEqual([]);
      expect(adminRuns.error).toBeNull();
      expect(adminRuns.data?.map((row) => row.id)).toEqual([runId]);
      expect(userRuns.error).toBeNull();
      expect(userRuns.data).toEqual([]);

      await db.from("source_discovery_runs").delete().eq("id", runId);
    });

    it("restricts duplicate-URL lookup to the service role", async () => {
      const { service: db, userA: admin } = ready();
      const { data, error } = await db.rpc("find_existing_content_item_urls", {
        p_urls: [`https://duplicate-check-${testId}.example/item`],
      });
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { error: userError } = await admin.rpc("find_existing_content_item_urls", {
        p_urls: [`https://duplicate-check-${testId}.example/item`],
      });
      expect(userError?.code).toBe("42501");
    });

    it("denies anonymous reads and client writes on all discovery tables", async () => {
      const { anonymous: anon, userA: admin, service: db } = ready();
      const { data: run, error: runError } = await db
        .from("source_discovery_runs")
        .insert({ kind: "catalog", lease_expires_at: new Date().toISOString() })
        .select("id")
        .single();
      if (runError) throw new Error(`creating run fixture failed: ${runError.message}`);
      const anonymousReads = await Promise.all([
        anon.from("admins").select("*"),
        anon.from("source_candidates").select("*"),
        anon.from("source_discovery_runs").select("*"),
      ]);
      expect(anonymousReads.map((result) => result.error?.code)).toEqual([
        "42501",
        "42501",
        "42501",
      ]);

      const writeResults = await Promise.all([
        admin.from("admins").insert({ user_id: userBId }),
        admin.from("admins").update({ user_id: userBId }).eq("user_id", userAId),
        admin.from("admins").delete().eq("user_id", userAId),
        admin.from("source_candidates").insert({
          origin: "catalog",
          source_id: fixtureSourceId,
          name: "Forbidden",
          feed_url: `https://forbidden-${testId}.example/feed`,
          kind: "rss",
          language: "en",
        }),
        admin.from("source_candidates").update({ status: "failed" }).eq("id", fixtureCandidateId),
        admin.from("source_candidates").delete().eq("id", fixtureCandidateId),
        admin
          .from("source_discovery_runs")
          .insert({ kind: "catalog", lease_expires_at: new Date().toISOString() }),
        admin.from("source_discovery_runs").update({ status: "completed" }).eq("id", run.id),
        admin.from("source_discovery_runs").delete().eq("id", run.id),
      ]);
      expect(writeResults.map((result) => result.error?.code)).toEqual(
        new Array(writeResults.length).fill("42501"),
      );
      await db.from("source_discovery_runs").delete().eq("id", run.id);

      const { error: anonDecisionError } = await anon.rpc("decide_source_candidate", {
        p_candidate_id: fixtureCandidateId,
        p_decision: "reject",
      });
      const { error: userDecisionError } = await admin.rpc("decide_source_candidate", {
        p_candidate_id: fixtureCandidateId,
        p_decision: "reject",
      });
      expect(anonDecisionError?.code).toBe("42501");
      expect(userDecisionError?.code).toBe("42501");

      const { data: adminCheck, error: adminCheckError } = await admin.rpc("is_admin");
      const { error: anonCheckError } = await anon.rpc("is_admin");
      expect(adminCheckError).toBeNull();
      expect(adminCheck).toBe(true);
      expect(anonCheckError?.code).toBe("42501");
    });

    it("rejects, activates, and safely reports stale catalog decisions", async () => {
      const { service: db } = ready();
      const rejected = await addCatalogCandidate("rejected");
      const approved = await addCatalogCandidate(
        "approved",
        `HTTPS://Discovery-Approved-${testId}.example:443/feed?x=1#old`,
        `https://discovery-approved-${testId}.example/feed?x=1`,
      );
      const stale = await addCatalogCandidate(
        "stale",
        `https://discovery-stale-${testId}.example/feed`,
        `https://different-${testId}.example/feed`,
      );

      const decisions = await Promise.all([
        db.rpc("decide_source_candidate", {
          p_candidate_id: rejected.candidateId,
          p_decision: "reject",
        }),
        db.rpc("decide_source_candidate", {
          p_candidate_id: approved.candidateId,
          p_decision: "approve",
        }),
        db.rpc("decide_source_candidate", {
          p_candidate_id: stale.candidateId,
          p_decision: "approve",
        }),
      ]);
      expect(decisions.map((result) => result.data)).toEqual(["rejected", "approved", "stale"]);
      expect(decisions.every((result) => result.error === null)).toBe(true);

      const { data: source, error: sourceError } = await db
        .from("sources")
        .select("is_active")
        .eq("id", approved.sourceId)
        .single();
      const { data: staleCandidate } = await db
        .from("source_candidates")
        .select("status")
        .eq("id", stale.candidateId)
        .single();
      expect(sourceError).toBeNull();
      expect(source?.is_active).toBe(true);
      expect(staleCandidate?.status).toBe("pending");

      if (!serviceKey) throw new Error("service role key is required for ingestion query test");
      const activeIngestionSources = await createIngestDb({
        NEXT_PUBLIC_SUPABASE_URL: url,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      }).listActiveSources();
      expect(activeIngestionSources.some((source) => source.id === approved.sourceId)).toBe(true);
      expect(activeIngestionSources.some((source) => source.id === rejected.sourceId)).toBe(false);

      const { userA: admin } = ready();
      const { data: sourcePageRows, error: sourcePageError } = await admin
        .from("sources")
        .select("id,name,language,kind,description")
        .eq("is_active", true)
        .in("id", [approved.sourceId, rejected.sourceId]);
      expect(sourcePageError).toBeNull();
      expect(sourcePageRows?.map((row) => row.id)).toEqual([approved.sourceId]);

      const [same, opposite] = await Promise.all([
        db.rpc("decide_source_candidate", {
          p_candidate_id: rejected.candidateId,
          p_decision: "reject",
        }),
        db.rpc("decide_source_candidate", {
          p_candidate_id: rejected.candidateId,
          p_decision: "approve",
        }),
      ]);
      expect(same.error).toBeNull();
      expect(opposite.error).toBeNull();
      expect([same.data, opposite.data].sort()).toEqual(["already_decided", "unchanged"]);
    });

    it("serializes concurrent opposing decisions into one terminal state", async () => {
      const { service: db } = ready();
      const { candidateId, sourceId } = await addCatalogCandidate("concurrent");
      const [approve, reject] = await Promise.all([
        db.rpc("decide_source_candidate", {
          p_candidate_id: candidateId,
          p_decision: "approve",
        }),
        db.rpc("decide_source_candidate", {
          p_candidate_id: candidateId,
          p_decision: "reject",
        }),
      ]);
      expect(approve.error).toBeNull();
      expect(reject.error).toBeNull();
      expect(
        [approve.data, reject.data].filter((value) => value === "approved" || value === "rejected"),
      ).toHaveLength(1);
      expect(
        [approve.data, reject.data].filter((value) => value === "already_decided"),
      ).toHaveLength(1);

      const [{ data: candidate }, { data: source }] = await Promise.all([
        db.from("source_candidates").select("status").eq("id", candidateId).single(),
        db.from("sources").select("is_active").eq("id", sourceId).single(),
      ]);
      expect(candidate?.status).toBe(approve.data === "approved" ? "approved" : "rejected");
      expect(source?.is_active).toBe(approve.data === "approved");
    });

    it("leases catalog scans, replaces expired leases, and expires old runs", async () => {
      const { service: db } = ready();
      const first = await db.rpc("start_source_discovery_run", { p_kind: "catalog" });
      expect(first.error).toBeNull();
      expect(typeof first.data).toBe("string");
      if (typeof first.data !== "string") throw new Error("first scan lease was not created");
      runIds.push(first.data);

      const overlapping = await db.rpc("start_source_discovery_run", { p_kind: "web_search" });
      expect(overlapping.error).toBeNull();
      expect(overlapping.data).toBeNull();
      let fetchedDuringOverlap = false;
      const overlappingScan = await scanInactiveCatalog(db, "test-key", userAId, {
        fetchBatch: async () => {
          fetchedDuringOverlap = true;
          return [];
        },
      });
      expect(overlappingScan.status).toBe("scan_running");
      expect(fetchedDuringOverlap).toBe(false);

      const { error: expireError } = await db
        .from("source_discovery_runs")
        .update({ lease_expires_at: new Date(Date.now() - 1_000).toISOString() })
        .eq("id", first.data);
      expect(expireError).toBeNull();
      const replacement = await db.rpc("start_source_discovery_run", { p_kind: "catalog" });
      expect(replacement.error).toBeNull();
      expect(typeof replacement.data).toBe("string");
      if (typeof replacement.data !== "string") {
        throw new Error("expired scan lease was not replaced");
      }
      runIds.push(replacement.data);

      const { data: expiredRun, error: expiredRunError } = await db
        .from("source_discovery_runs")
        .select("status,finished_at")
        .eq("id", first.data)
        .single();
      expect(expiredRunError).toBeNull();
      expect(expiredRun).toMatchObject({ status: "failed" });
      expect(expiredRun?.finished_at).not.toBeNull();
      const { error: finishError } = await db
        .from("source_discovery_runs")
        .update({ status: "completed", finished_at: new Date().toISOString() })
        .eq("id", replacement.data);
      expect(finishError).toBeNull();
    });

    it("scans fixture feeds, refreshes pending and failed rows, and stores no feed items", async () => {
      const { service: db } = ready();
      const firstSource = await addInactiveSource("scan-a");
      const secondSource = await addInactiveSource("scan-b");
      const urls = Array.from(
        { length: 3 },
        (_, index) => `https://feed-item.example/${testId}/${index}`,
      );
      const xml = `<rss version="2.0"><channel><title>Fixture</title>${urls
        .map(
          (itemUrl, index) =>
            `<item><title>Fixture ${index}</title><link>${itemUrl}</link><description>Fixture summary ${index}</description><pubDate>${new Date(Date.now() - index * 1_000).toUTCString()}</pubDate></item>`,
        )
        .join("")}</channel></rss>`;
      let pass = 0;
      const fetchBatch: NonNullable<Parameters<typeof scanInactiveCatalog>[3]>["fetchBatch"] =
        async (feeds) => {
          pass += 1;
          return feeds.map(({ feedUrl }) => {
            if (pass === 1 && feedUrl === firstSource.feedUrl) {
              return {
                status: "ok",
                body: xml,
                contentType: "application/rss+xml",
              };
            }
            if (pass === 1 || (pass === 2 && feedUrl === firstSource.feedUrl)) {
              return { status: "error", error: "fixture fetch failure" };
            }
            return {
              status: "ok",
              body: xml,
              contentType: "application/rss+xml",
            };
          });
        };
      const embeddingRequest: NonNullable<
        Parameters<typeof scanInactiveCatalog>[3]
      >["embeddingRequest"] = async (items) => items.map(() => Array<number>(512).fill(1));
      const options = {
        sourceIds: [firstSource.id, secondSource.id],
        fetchBatch,
        embeddingRequest,
      };
      const trackLatestRun = async () => {
        const { data: run, error } = await db
          .from("source_discovery_runs")
          .select("id")
          .order("started_at", { ascending: false })
          .limit(1)
          .single();
        if (error) throw new Error(`tracking source discovery run failed: ${error.message}`);
        runIds.push(run.id);
      };

      const firstScan = await scanInactiveCatalog(db, "test-key", userAId, options);
      await trackLatestRun();
      expect(firstScan).toMatchObject({ status: "completed", processed: 2, failed: 1 });
      const { data: initialCandidates, error: initialError } = await db
        .from("source_candidates")
        .select("*")
        .in("source_id", [firstSource.id, secondSource.id]);
      expect(initialError).toBeNull();
      const initialBySource = new Map(
        (initialCandidates ?? []).map((candidate) => [candidate.source_id, candidate]),
      );
      expect(initialBySource.get(firstSource.id)).toMatchObject({
        status: "pending",
        item_count: 3,
        items_per_day: 0.1,
      });
      expect(initialBySource.get(secondSource.id)).toMatchObject({
        status: "failed",
        failure: "fetch_failed",
        relevance: "not_scored",
        mean_match_share: null,
      });
      const candidateFields = Object.keys(initialBySource.get(firstSource.id) ?? {});
      expect(candidateFields).not.toContain("user_id");
      expect(candidateFields).not.toContain("matched_user_count");

      const { data: insertedItems, error: insertedItemsError } = await db
        .from("content_items")
        .select("id")
        .in("url", urls);
      expect(insertedItemsError).toBeNull();
      expect(insertedItems).toEqual([]);

      const secondScan = await scanInactiveCatalog(db, "test-key", userAId, options);
      await trackLatestRun();
      expect(secondScan).toMatchObject({ status: "completed", processed: 2, failed: 1 });
      const { data: rescanned, error: rescannedError } = await db
        .from("source_candidates")
        .select("id,source_id,status,failure,item_count")
        .in("source_id", [firstSource.id, secondSource.id]);
      expect(rescannedError).toBeNull();
      const rescannedBySource = new Map(
        (rescanned ?? []).map((candidate) => [candidate.source_id, candidate]),
      );
      expect(rescannedBySource.get(firstSource.id)).toMatchObject({
        status: "failed",
        failure: "fetch_failed",
        item_count: null,
      });
      expect(rescannedBySource.get(secondSource.id)).toMatchObject({
        status: "pending",
        failure: null,
        item_count: 3,
      });
      const secondCandidateId = rescannedBySource.get(secondSource.id)?.id;
      if (typeof secondCandidateId !== "string")
        throw new Error("pending candidate was not stored");
      candidateIds.push(secondCandidateId);
      const decision = await db.rpc("decide_source_candidate", {
        p_candidate_id: secondCandidateId,
        p_decision: "reject",
      });
      expect(decision.data).toBe("rejected");

      const deadlineScan = await scanInactiveCatalog(db, "test-key", userAId, {
        ...options,
        deadlineMs: 0,
      });
      await trackLatestRun();
      expect(deadlineScan).toMatchObject({ status: "partial", processed: 0 });
      const { data: afterDeadline, error: afterDeadlineError } = await db
        .from("source_candidates")
        .select("source_id,status")
        .in("source_id", [firstSource.id, secondSource.id]);
      expect(afterDeadlineError).toBeNull();
      expect(
        new Map((afterDeadline ?? []).map((candidate) => [candidate.source_id, candidate.status])),
      ).toEqual(
        new Map([
          [firstSource.id, "failed"],
          [secondSource.id, "rejected"],
        ]),
      );

      const thirdScan = await scanInactiveCatalog(db, "test-key", userAId, {
        ...options,
        fetchBatch: async (feeds) =>
          feeds.map(() => ({
            status: "ok",
            body: xml,
            contentType: "application/rss+xml",
          })),
      });
      await trackLatestRun();
      expect(thirdScan).toMatchObject({ status: "completed", processed: 1, failed: 0 });
      const { data: terminalCandidate, error: terminalError } = await db
        .from("source_candidates")
        .select("status")
        .eq("id", secondCandidateId)
        .single();
      expect(terminalError).toBeNull();
      expect(terminalCandidate?.status).toBe("rejected");
    });
  },
);
