/** Integration coverage for item clicks and their owner-only access. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSupabaseQueryResult } from "../test/supabase-query-result.ts";

const enabled = process.env.SUPABASE_INTEGRATION === "1";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const options = {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
};

describe.skipIf(!enabled || anonKey == null || serviceKey == null)("item clicks", () => {
  const anonymous = anonKey ? createClient(url, anonKey, options) : null;
  const service = serviceKey ? createClient(url, serviceKey, options) : null;
  const clientA = anonKey ? createClient(url, anonKey, options) : null;
  const clientB = anonKey ? createClient(url, anonKey, options) : null;
  const suffix = randomUUID();
  const password = `Click-test-${randomUUID()}Aa1!`;
  let userAId: string | undefined;
  let userBId: string | undefined;
  let sourceId: string | undefined;
  let itemId: string | undefined;
  let itemIds: string[] = [];

  function ready() {
    if (!anonymous || !service || !clientA || !clientB) {
      throw new Error("Local integration credentials are unavailable.");
    }
    return { anonymous, service, clientA, clientB };
  }

  beforeAll(async () => {
    const { service, clientA, clientB } = ready();
    const [userA, userB] = await Promise.all([
      service.auth.admin.createUser({
        email: `click-a-${suffix}@example.test`,
        password,
        email_confirm: true,
      }),
      service.auth.admin.createUser({
        email: `click-b-${suffix}@example.test`,
        password,
        email_confirm: true,
      }),
    ]);
    if (userA.error || !userA.data.user) throw new Error(userA.error?.message);
    if (userB.error || !userB.data.user) throw new Error(userB.error?.message);
    userAId = userA.data.user.id;
    userBId = userB.data.user.id;
    const signIns = await Promise.all([
      clientA.auth.signInWithPassword({ email: `click-a-${suffix}@example.test`, password }),
      clientB.auth.signInWithPassword({ email: `click-b-${suffix}@example.test`, password }),
    ]);
    if (signIns.some(({ error }) => error)) throw new Error("Signing in click fixtures failed.");

    const source = await service
      .from("sources")
      .insert({
        name: `Click test ${suffix}`,
        feed_url: `https://click-integration.example/${suffix}/feed`,
        kind: "rss",
        language: "en",
        is_active: true,
      })
      .select("id")
      .single();
    if (source.error) throw new Error(source.error.message);
    sourceId = source.data.id;
    const items = await service
      .from("content_items")
      .insert(
        Array.from({ length: 3 }, (_, index) => ({
          source_id: sourceId,
          type: "article",
          url: `https://click-integration.example/${suffix}/item-${index}`,
          title: `Click integration item ${index}`,
          summary: "Click integration summary",
          summary_origin: "feed",
          enrichment_status: "completed",
          language: "en",
          published_at: new Date().toISOString(),
        })),
      )
      .select("id");
    if (items.error) throw new Error(items.error.message);
    itemIds = items.data.map((item) => item.id);
    itemId = itemIds[0];
  });

  beforeEach(async () => {
    const { service } = ready();
    const result = await service
      .from("item_clicks")
      .delete()
      .in(
        "user_id",
        [userAId, userBId].filter((id): id is string => Boolean(id)),
      );
    expect(result.error).toBeNull();
    const feedbackResult = await service
      .from("feedback")
      .delete()
      .in(
        "user_id",
        [userAId, userBId].filter((id): id is string => Boolean(id)),
      );
    expect(feedbackResult.error).toBeNull();
  });

  afterAll(async () => {
    const { service } = ready();
    if (sourceId) {
      await service.from("sources").delete().eq("id", sourceId);
    }
    for (const userId of [userAId, userBId]) {
      if (userId) await service.auth.admin.deleteUser(userId);
    }
  });

  it("enables RLS and grants only owner select and item insert", () => {
    const result = parseSupabaseQueryResult(
      execFileSync(
        "supabase",
        [
          "db",
          "query",
          "--local",
          "--output-format",
          "json",
          `select
            (select relrowsecurity from pg_class where oid = 'public.item_clicks'::regclass) as rls,
            has_table_privilege('authenticated', 'public.item_clicks', 'SELECT') as can_select,
            has_column_privilege('authenticated', 'public.item_clicks', 'item_id', 'INSERT') as can_insert_item,
            not has_column_privilege('authenticated', 'public.item_clicks', 'user_id', 'INSERT') as cannot_insert_user,
            not has_table_privilege('anon', 'public.item_clicks', 'SELECT') as anon_denied,
            has_function_privilege('authenticated', 'public.record_click(uuid)', 'EXECUTE') as can_record,
            not has_function_privilege('anon', 'public.record_click(uuid)', 'EXECUTE') as anon_record_denied,
            not (select prosecdef from pg_proc where oid = 'public.record_click(uuid)'::regprocedure) as is_invoker,
            (select proconfig from pg_proc where oid = 'public.record_click(uuid)'::regprocedure) = array['search_path=""'] as empty_search_path`,
        ],
        { encoding: "utf8" },
      ),
    );
    expect(result.rows[0]).toEqual({
      rls: true,
      can_select: true,
      can_insert_item: true,
      cannot_insert_user: true,
      can_record: true,
      anon_denied: true,
      anon_record_denied: true,
      is_invoker: true,
      empty_search_path: true,
    });
  });

  it("keeps clicks owner-only and rejects inserts naming another user", async () => {
    const { clientA, clientB } = ready();
    const recorded = await clientA.rpc("record_click", { p_item_id: itemId });
    expect(recorded.error).toBeNull();
    const own = await clientA.from("item_clicks").select("user_id,item_id,clicked_at");
    expect(own.error).toBeNull();
    expect(own.data).toHaveLength(1);
    expect(own.data?.[0]?.user_id).toBe(userAId);
    const other = await clientB.from("item_clicks").select("user_id,item_id");
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
    const impersonation = await clientB.from("item_clicks").insert({
      user_id: userAId,
      item_id: itemId,
    });
    expect(impersonation.error?.code).toBe("42501");
  });

  it("keeps the first clicked_at for repeated clicks", async () => {
    const { clientA } = ready();
    expect((await clientA.rpc("record_click", { p_item_id: itemId })).error).toBeNull();
    const first = await clientA
      .from("item_clicks")
      .select("clicked_at")
      .eq("item_id", itemId)
      .single();
    expect(first.error).toBeNull();
    expect((await clientA.rpc("record_click", { p_item_id: itemId })).error).toBeNull();
    const second = await clientA
      .from("item_clicks")
      .select("clicked_at")
      .eq("item_id", itemId)
      .single();
    expect(second.data?.clicked_at).toBe(first.data?.clicked_at);
  });

  it("denies anonymous access and unknown or unreadable items", async () => {
    const { anonymous, clientA } = ready();
    expect((await anonymous.rpc("record_click", { p_item_id: itemId })).error?.code).toBe("42501");
    expect((await clientA.rpc("record_click", { p_item_id: randomUUID() })).error?.code).toBe(
      "22023",
    );
  });

  it("lists opened-only, seen-only, and combined items once with current flags", async () => {
    const { clientA, service } = ready();
    const [openedId, seenId, bothId] = itemIds;
    if (!openedId || !seenId || !bothId) throw new Error("Click fixtures are missing.");
    expect((await clientA.rpc("record_click", { p_item_id: openedId })).error).toBeNull();
    expect(
      (
        await clientA.rpc("set_feedback", {
          p_item_id: seenId,
          p_kind: "seen",
          p_via: "button",
        })
      ).error,
    ).toBeNull();
    expect((await clientA.rpc("record_click", { p_item_id: bothId })).error).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      (
        await clientA.rpc("set_feedback", {
          p_item_id: bothId,
          p_kind: "seen",
          p_via: "button",
        })
      ).error,
    ).toBeNull();
    const feedback = await service
      .from("feedback")
      .select("updated_at")
      .eq("user_id", userAId)
      .eq("item_id", bothId)
      .single();
    expect(feedback.error).toBeNull();

    const history = await clientA.rpc("get_history", { p_limit: 20 });
    expect(history.error).toBeNull();
    const rows = history.data as Array<{
      id: string;
      opened: boolean;
      seen: boolean;
      event_at: string;
      feedback_kind: string | null;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === openedId)).toMatchObject({
      opened: true,
      seen: false,
      feedback_kind: null,
    });
    expect(rows.find((row) => row.id === seenId)).toMatchObject({
      opened: false,
      seen: true,
      feedback_kind: "seen",
    });
    expect(rows.find((row) => row.id === bothId)).toMatchObject({
      opened: true,
      seen: true,
      event_at: feedback.data?.updated_at,
      feedback_kind: "seen",
    });
  });

  it("paginates equal timestamps without gaps or repeats and clamps the limit", async () => {
    const { clientA, service, clientB, anonymous } = ready();
    for (const id of itemIds) {
      expect((await clientA.rpc("record_click", { p_item_id: id })).error).toBeNull();
    }
    const eventAt = "2026-11-27T10:00:00.123456+00:00";
    const updated = await service
      .from("item_clicks")
      .update({ clicked_at: eventAt })
      .eq("user_id", userAId);
    expect(updated.error).toBeNull();

    const first = await clientA.rpc("get_history", { p_limit: 1 });
    expect(first.error).toBeNull();
    const second = await clientA.rpc("get_history", {
      p_limit: 100,
      p_before_at: (first.data as Array<{ event_at: string }>)[0]?.event_at,
      p_before_id: (first.data as Array<{ id: string }>)[0]?.id,
    });
    expect(second.error).toBeNull();
    const secondRows = (second.data ?? []) as Array<{ id: string; event_at: string }>;
    expect(secondRows).toHaveLength(2);
    const allIds = [
      (first.data as Array<{ id: string }>)[0]?.id,
      ...secondRows.map((row) => row.id),
    ];
    expect(new Set(allIds).size).toBe(3);
    expect((await clientB.rpc("get_history", { p_limit: 20 })).data).toEqual([]);
    expect((await anonymous.rpc("get_history", { p_limit: 20 })).error?.code).toBe("42501");
  });
});
