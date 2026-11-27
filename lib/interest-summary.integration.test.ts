import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.SUPABASE_INTEGRATION === "1";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const options = {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
};

describe.skipIf(!enabled)("interest summaries", () => {
  const anonymous: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
  const service: SupabaseClient | null = serviceKey ? createClient(url, serviceKey, options) : null;
  const clientA: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
  const clientB: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
  const suffix = randomUUID();
  const password = `Summary-test-${randomUUID()}Aa1!`;
  let userAId: string | undefined;
  let userBId: string | undefined;

  function ready() {
    if (!anonymous || !service || !clientA || !clientB) {
      throw new Error("Local integration credentials are unavailable.");
    }
    return { anonymous, service, clientA, clientB };
  }

  beforeAll(async () => {
    const { service: admin, clientA: userA, clientB: userB } = ready();
    const emailA = `interest-summary-a-${suffix}@example.test`;
    const emailB = `interest-summary-b-${suffix}@example.test`;
    const [createdA, createdB] = await Promise.all([
      admin.auth.admin.createUser({ email: emailA, password, email_confirm: true }),
      admin.auth.admin.createUser({ email: emailB, password, email_confirm: true }),
    ]);
    if (createdA.error || createdB.error) {
      throw new Error("Could not create interest summary users.");
    }
    userAId = createdA.data.user.id;
    userBId = createdB.data.user.id;
    const [signedA, signedB] = await Promise.all([
      userA.auth.signInWithPassword({ email: emailA, password }),
      userB.auth.signInWithPassword({ email: emailB, password }),
    ]);
    if (signedA.error || signedB.error) throw new Error("Could not sign in summary users.");

    const inserted = await admin.from("interest_summaries").insert([
      {
        user_id: userAId,
        summary: "User A likes technology.",
        topics: ["Technology"],
        like_count: 3,
      },
      {
        user_id: userBId,
        summary: "User B likes science.",
        topics: ["Science"],
        like_count: 3,
      },
    ]);
    if (inserted.error) throw new Error(`Could not seed summaries: ${inserted.error.message}`);
  });

  afterAll(async () => {
    const { service: admin } = ready();
    for (const userId of [userAId, userBId]) {
      if (userId) await admin.auth.admin.deleteUser(userId);
    }
  });

  it("keeps summaries owner-only and denies direct authenticated writes", async () => {
    const { anonymous: anon, clientA: userA, clientB: userB, service: admin } = ready();
    if (!userAId || !userBId) throw new Error("Summary fixture users are missing.");

    const own = await userA.from("interest_summaries").select("user_id,summary");
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ user_id: userAId, summary: "User A likes technology." }]);
    const foreignRead = await userA
      .from("interest_summaries")
      .select("summary")
      .eq("user_id", userBId);
    expect(foreignRead.error).toBeNull();
    expect(foreignRead.data).toEqual([]);

    const inserted = await userA.from("interest_summaries").insert({
      user_id: userAId,
      summary: "Forged.",
      topics: [],
      like_count: 0,
    });
    expect(inserted.error?.code).toBe("42501");
    const updated = await userA
      .from("interest_summaries")
      .update({ summary: "Changed." })
      .eq("user_id", userAId);
    expect(updated.error?.code).toBe("42501");
    const foreignDelete = await userA.from("interest_summaries").delete().eq("user_id", userBId);
    expect(foreignDelete.error).toBeNull();
    const stillPresent = await admin
      .from("interest_summaries")
      .select("user_id")
      .eq("user_id", userBId);
    expect(stillPresent.data).toHaveLength(1);

    const anonymousRead = await anon.from("interest_summaries").select("user_id");
    expect(anonymousRead.error?.code).toBe("42501");
    const anonymousDelete = await anon.from("interest_summaries").delete().eq("user_id", userAId);
    expect(anonymousDelete.error?.code).toBe("42501");

    const deleted = await userA.from("interest_summaries").delete().eq("user_id", userAId);
    expect(deleted.error).toBeNull();
    const remaining = await admin
      .from("interest_summaries")
      .select("user_id")
      .eq("user_id", userAId);
    expect(remaining.data).toEqual([]);
    expect((await userB.from("interest_summaries").select("user_id")).data).toHaveLength(1);
  });

  it("separately limits, expires, and concurrently reserves interest summary calls", async () => {
    const { clientA: userA, clientB: userB, service: admin } = ready();
    if (!userAId || !userBId) throw new Error("Summary fixture users are missing.");

    await admin.from("llm_usage").delete().eq("user_id", userAId);
    const existingPreferenceUse = await admin.from("llm_usage").insert({
      user_id: userAId,
      kind: "preferences",
    });
    expect(existingPreferenceUse.error).toBeNull();
    const stale = await admin.from("llm_usage").insert({
      user_id: userAId,
      kind: "interest_summary",
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(stale.error).toBeNull();

    const reserved = await userA.rpc("reserve_llm_call", { p_kind: "interest_summary" });
    expect(reserved.data).toBe(true);
    const preferencesRemaining = await userA.rpc("reserve_llm_call", { p_kind: "preferences" });
    expect(preferencesRemaining.data).toBe(true);
    const recentPreference = await admin
      .from("llm_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userAId)
      .eq("kind", "preferences")
      .gte("created_at", new Date(Date.now() - 60_000).toISOString());
    expect(recentPreference.count).toBe(2);

    await admin.from("llm_usage").delete().eq("user_id", userAId).eq("kind", "interest_summary");
    const seeded = await admin.from("llm_usage").insert(
      Array.from({ length: 9 }, () => ({
        user_id: userAId,
        kind: "interest_summary",
      })),
    );
    expect(seeded.error).toBeNull();
    const concurrent = await Promise.all([
      userA.rpc("reserve_llm_call", { p_kind: "interest_summary" }),
      userA.rpc("reserve_llm_call", { p_kind: "interest_summary" }),
    ]);
    expect(concurrent.map((result) => result.data).filter(Boolean)).toHaveLength(1);
    const blocked = await userA.rpc("reserve_llm_call", { p_kind: "interest_summary" });
    expect(blocked.data).toBe(false);
    const count = await admin
      .from("llm_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userAId)
      .eq("kind", "interest_summary");
    expect(count.count).toBe(10);

    const otherUser = await userB.rpc("reserve_llm_call", { p_kind: "interest_summary" });
    expect(otherUser.data).toBe(true);
    const unknown = await userB.rpc("reserve_llm_call", { p_kind: "other" });
    expect(unknown.error).not.toBeNull();
    const anonymousReservation = await anonymousResult();
    expect(anonymousReservation.data).toBeNull();
    expect(anonymousReservation.error?.code).toBe("42501");
  });

  async function anonymousResult() {
    const { anonymous: anon } = ready();
    return anon.rpc("reserve_llm_call", { p_kind: "interest_summary" });
  }
});
