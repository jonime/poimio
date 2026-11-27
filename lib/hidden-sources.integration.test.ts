/** Integration coverage for per-user hidden sources and the hide RPC. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setSourceVisible } from "../app/feedback/actions";
import { createClient as createRequestClient } from "./supabase/server";

vi.mock("./supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const enabled = process.env.SUPABASE_INTEGRATION === "1";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const options = {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
};

function parseSingleRow(output: string): Record<string, boolean> {
  let searchFrom = 0;
  for (;;) {
    const start = output.indexOf("{", searchFrom);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) break;
    searchFrom = end + 1;
    try {
      const parsed: unknown = JSON.parse(output.slice(start, end + 1));
      if (typeof parsed !== "object" || parsed === null) continue;
      if ("rows" in parsed && Array.isArray(parsed.rows)) {
        const row = parsed.rows[0];
        if (typeof row === "object" && row !== null && "hidden_rls" in row) {
          return row as Record<string, boolean>;
        }
      }
      if ("hidden_rls" in parsed) return parsed as Record<string, boolean>;
    } catch {
      // CLI status lines can precede the query result.
    }
  }
  throw new Error("Supabase CLI returned no hidden-source schema row.");
}

describe.skipIf(!enabled || !anonKey || !serviceKey)("hidden sources", () => {
  const anonymous: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
  const service: SupabaseClient | null = serviceKey ? createClient(url, serviceKey, options) : null;
  const userAClient: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
  const userBClient: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
  const suffix = randomUUID();
  const password = `Hidden-source-test-${randomUUID()}Aa1!`;
  const sourceIds: string[] = [];
  let itemId: string;
  let userAId: string;
  let userBId: string;

  function ready() {
    if (!anonymous || !service || !userAClient || !userBClient) {
      throw new Error("Local integration credentials are unavailable.");
    }
    return { anonymous, service, userAClient, userBClient };
  }

  beforeAll(async () => {
    const { service: serviceClient, userAClient: clientA, userBClient: clientB } = ready();
    const [userA, userB] = await Promise.all([
      serviceClient.auth.admin.createUser({
        email: `hidden-source-a-${suffix}@example.test`,
        password,
        email_confirm: true,
      }),
      serviceClient.auth.admin.createUser({
        email: `hidden-source-b-${suffix}@example.test`,
        password,
        email_confirm: true,
      }),
    ]);
    if (userA.error || !userA.data.user) throw new Error(userA.error?.message ?? "User A missing");
    if (userB.error || !userB.data.user) throw new Error(userB.error?.message ?? "User B missing");
    userAId = userA.data.user.id;
    userBId = userB.data.user.id;

    const [signInA, signInB] = await Promise.all([
      clientA.auth.signInWithPassword({
        email: `hidden-source-a-${suffix}@example.test`,
        password,
      }),
      clientB.auth.signInWithPassword({
        email: `hidden-source-b-${suffix}@example.test`,
        password,
      }),
    ]);
    if (signInA.error || signInB.error) {
      throw new Error(signInA.error?.message ?? signInB.error?.message ?? "Sign-in failed");
    }

    const source = await serviceClient
      .from("sources")
      .insert({
        name: `Hidden source ${suffix}`,
        feed_url: `https://hidden-source.example/${suffix}`,
        kind: "rss",
        language: "en",
        is_active: true,
      })
      .select("id")
      .single();
    if (source.error || !source.data) {
      throw new Error(source.error?.message ?? "Source was not created");
    }
    sourceIds.push(source.data.id);

    const item = await serviceClient
      .from("content_items")
      .insert({
        source_id: source.data.id,
        type: "article",
        url: `https://hidden-source.example/${suffix}/item`,
        title: "Old rated item",
        summary: "A readable item from an inactive source.",
        summary_origin: "feed",
        enrichment_status: "completed",
        language: "en",
        published_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        embedding_model: "text-embedding-3-small@512",
        embedding: `[${Array.from({ length: 512 }, () => 0).join(",")}]`,
      })
      .select("id")
      .single();
    if (item.error || !item.data) {
      throw new Error(item.error?.message ?? "Item was not created");
    }
    itemId = item.data.id;
  });

  afterAll(async () => {
    const { service: serviceClient } = ready();
    await serviceClient.auth.admin.deleteUser(userAId);
    await serviceClient.auth.admin.deleteUser(userBId);
    if (itemId) {
      const { error } = await serviceClient.from("content_items").delete().eq("id", itemId);
      if (error) throw new Error(`deleting hidden-source fixture item failed: ${error.message}`);
    }
    if (sourceIds.length > 0) {
      const { error } = await serviceClient.from("sources").delete().in("id", sourceIds);
      if (error) throw new Error(`deleting hidden-source fixtures failed: ${error.message}`);
    }
  });

  it("has owner-only RLS and the required function security contract", () => {
    const query = `
      select
        (select relrowsecurity from pg_class where oid = 'public.hidden_sources'::regclass) as hidden_rls,
        (select count(*) = 3 from pg_policies where schemaname = 'public' and tablename = 'hidden_sources') as policies,
        has_table_privilege('authenticated', 'public.hidden_sources', 'SELECT') as owner_select,
        has_table_privilege('authenticated', 'public.hidden_sources', 'INSERT') as owner_insert,
        has_table_privilege('authenticated', 'public.hidden_sources', 'DELETE') as owner_delete,
        not has_table_privilege('authenticated', 'public.hidden_sources', 'UPDATE') as update_denied,
        not has_table_privilege('anon', 'public.hidden_sources', 'SELECT') as anon_table_denied,
        has_function_privilege('authenticated', 'public.hide_source_of_item(uuid)', 'EXECUTE') as auth_function,
        not has_function_privilege('anon', 'public.hide_source_of_item(uuid)', 'EXECUTE') as anon_function_denied,
        not (select prosecdef from pg_proc where oid = 'public.hide_source_of_item(uuid)'::regprocedure) as invoker,
        (select 'search_path=""' = any(proconfig) from pg_proc where oid = 'public.hide_source_of_item(uuid)'::regprocedure) as empty_search_path`;
    const output = execFileSync(
      "supabase",
      ["db", "query", "--local", "--output-format", "json", query],
      { encoding: "utf8" },
    );
    expect(parseSingleRow(output)).toEqual({
      hidden_rls: true,
      policies: true,
      owner_select: true,
      owner_insert: true,
      owner_delete: true,
      update_denied: true,
      anon_table_denied: true,
      auth_function: true,
      anon_function_denied: true,
      invoker: true,
      empty_search_path: true,
    });
  });

  it("prevents one user from reading, inserting for, updating, or deleting another user's row", async () => {
    const { service: serviceClient, userAClient: clientA } = ready();
    const sourceId = sourceIds[0];
    expect(sourceId).toBeDefined();
    const bRow = await serviceClient.from("hidden_sources").insert({
      user_id: userBId,
      source_id: sourceId,
    });
    expect(bRow.error).toBeNull();

    const foreignRead = await clientA
      .from("hidden_sources")
      .select("source_id")
      .eq("user_id", userBId);
    expect(foreignRead.error).toBeNull();
    expect(foreignRead.data).toEqual([]);

    const forged = await clientA.from("hidden_sources").insert({
      user_id: userBId,
      source_id: sourceId,
    });
    expect(forged.error).not.toBeNull();

    const updated = await clientA
      .from("hidden_sources")
      .update({ source_id: randomUUID() })
      .eq("user_id", userBId);
    expect(updated.error?.code).toBe("42501");

    const deleted = await clientA.from("hidden_sources").delete().eq("source_id", sourceId);
    expect(deleted.error).toBeNull();
    const stillPresent = await serviceClient
      .from("hidden_sources")
      .select("source_id")
      .eq("user_id", userBId)
      .eq("source_id", sourceId);
    expect(stillPresent.data).toHaveLength(1);
  });

  it("sets visibility idempotently without changing another user's row", async () => {
    const { userAClient: clientA, userBClient: clientB } = ready();
    const sourceId = sourceIds[0];
    expect(
      (
        await clientB
          .from("hidden_sources")
          .upsert({ source_id: sourceId }, { ignoreDuplicates: true })
      ).error,
    ).toBeNull();
    vi.mocked(createRequestClient).mockResolvedValue(clientA);

    for (const visible of [false, false, true, true]) {
      await expect(setSourceVisible(sourceId, visible)).resolves.toEqual({
        ok: true,
        sourceId,
        visible,
      });
      const own = await clientA
        .from("hidden_sources")
        .select("source_id")
        .eq("source_id", sourceId);
      expect(own.error).toBeNull();
      expect(own.data).toEqual(visible ? [] : [{ source_id: sourceId }]);
    }

    await expect(setSourceVisible(randomUUID(), false)).resolves.toEqual({
      ok: false,
      error: "save_failed",
    });
    const own = await clientA.from("hidden_sources").select("source_id");
    expect(own.error).toBeNull();
    expect(own.data).toEqual([]);
    const other = await clientB
      .from("hidden_sources")
      .select("source_id")
      .eq("source_id", sourceId);
    expect(other.error).toBeNull();
    expect(other.data).toEqual([{ source_id: sourceId }]);
  });

  it("hides an old rated item idempotently from an inactive source for only the caller", async () => {
    const { service: serviceClient, userAClient: clientA, userBClient: clientB } = ready();
    const sourceId = sourceIds[0];
    expect(sourceId).toBeDefined();
    await serviceClient.from("hidden_sources").delete().in("user_id", [userAId, userBId]);
    await serviceClient.from("sources").update({ is_active: false }).eq("id", sourceId);
    const feedback = await clientA.from("feedback").insert({
      item_id: itemId,
      kind: "seen",
      via: "button",
    });
    expect(feedback.error).toBeNull();

    const first = await clientA.rpc("hide_source_of_item", { p_item_id: itemId });
    const second = await clientA.rpc("hide_source_of_item", { p_item_id: itemId });
    expect(first.error).toBeNull();
    expect(second.data).toEqual(first.data);
    expect(first.data).toEqual([{ source_id: sourceId, source_name: `Hidden source ${suffix}` }]);

    const own = await clientA.from("hidden_sources").select("source_id").eq("source_id", sourceId);
    expect(own.data).toEqual([{ source_id: sourceId }]);
    const other = await clientB
      .from("hidden_sources")
      .select("source_id")
      .eq("source_id", sourceId);
    expect(other.data).toEqual([]);
  });

  it("raises a generic error and inserts nothing for null or unknown items", async () => {
    const { service: serviceClient, userAClient: clientA } = ready();
    await serviceClient.from("hidden_sources").delete().eq("user_id", userAId);
    const before = await serviceClient
      .from("hidden_sources")
      .select("source_id", { count: "exact", head: true })
      .eq("user_id", userAId);

    const nullItem = await clientA.rpc("hide_source_of_item", { p_item_id: null });
    const unknownItem = await clientA.rpc("hide_source_of_item", { p_item_id: randomUUID() });
    expect(nullItem.error).not.toBeNull();
    expect(nullItem.error?.message).toBe(unknownItem.error?.message);
    const after = await serviceClient
      .from("hidden_sources")
      .select("source_id", { count: "exact", head: true })
      .eq("user_id", userAId);
    expect(after.count).toBe(before.count);
  });

  it("denies anonymous access and cascades rows when the owner is deleted", async () => {
    const { anonymous: anon, service: serviceClient } = ready();
    expect((await anon.from("hidden_sources").select("source_id")).error?.code).toBe("42501");
    expect((await anon.rpc("hide_source_of_item", { p_item_id: itemId })).error?.code).toBe(
      "42501",
    );

    const userC = await serviceClient.auth.admin.createUser({
      email: `hidden-source-c-${suffix}@example.test`,
      password,
      email_confirm: true,
    });
    if (userC.error || !userC.data.user) throw new Error(userC.error?.message ?? "User C missing");
    const inserted = await serviceClient.from("hidden_sources").insert({
      user_id: userC.data.user.id,
      source_id: sourceIds[0],
    });
    expect(inserted.error).toBeNull();
    const deleted = await serviceClient.auth.admin.deleteUser(userC.data.user.id);
    expect(deleted.error).toBeNull();
    const rows = await serviceClient
      .from("hidden_sources")
      .select("source_id")
      .eq("user_id", userC.data.user.id);
    expect(rows.data).toEqual([]);
  });
});
