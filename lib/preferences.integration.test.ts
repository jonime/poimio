/** Integration coverage for feed preferences, the 20-row cap, and the LLM-call limit. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const zeroVector = `[${Array.from({ length: 512 }, () => 0).join(",")}]`;

const preferenceSchemaColumns = [
  "preferences_rls",
  "usage_rls",
  "preference_policies",
  "usage_policies",
  "preference_user_default",
  "usage_user_default",
  "preference_select",
  "preference_insert_denied",
  "preference_delete",
  "direction_update",
  "label_update_denied",
  "anon_preference_denied",
  "usage_select",
  "usage_kind_insert",
  "usage_user_insert_denied",
  "usage_created_insert_denied",
  "usage_update_denied",
  "usage_delete_denied",
  "anon_usage_denied",
  "authenticated_reserve",
  "anon_reserve_denied",
  "reserve_is_invoker",
  "reserve_is_volatile",
] as const;

function parseSupabaseQueryResult(output: string): { rows: unknown[] } {
  let searchFrom = 0;
  const observedObjectKeys: string[] = [];
  for (;;) {
    const start = output.indexOf("{", searchFrom);
    if (start === -1) {
      const observed = observedObjectKeys.join("; ") || "none";
      throw new Error(`Supabase CLI returned no query rows object (object keys: ${observed}).`);
    }

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
    if (end === -1) {
      throw new Error("Supabase CLI returned an incomplete JSON object.");
    }

    const candidate = output.slice(start, end + 1);
    searchFrom = end + 1;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null) continue;
      if ("rows" in parsed && Array.isArray(parsed.rows)) return { rows: parsed.rows };
      const keys = Object.keys(parsed);
      observedObjectKeys.push(keys.sort().join(","));
      if (preferenceSchemaColumns.every((column) => column in parsed)) {
        return { rows: [parsed] };
      }
    } catch {
      // Keep scanning; CLI status JSON can precede the query result.
    }
  }
}

describe("parseSupabaseQueryResult", () => {
  it("finds wrapped query rows after other JSON output", () => {
    expect(
      parseSupabaseQueryResult(
        'Connecting to local database...\n{"boundary":"id"}\n{"rows":[{"preferences_rls":true}]}\n{"other":true}',
      ),
    ).toEqual({ rows: [{ preferences_rls: true }] });
  });

  it("accepts a direct schema row from the CLI", () => {
    const row = Object.fromEntries(preferenceSchemaColumns.map((column) => [column, true]));
    expect(parseSupabaseQueryResult(`Connecting...\n${JSON.stringify([row])}`)).toEqual({
      rows: [row],
    });
  });
});

function preferenceRow(userId: string, label: string, direction: "more" | "less" = "more") {
  return {
    user_id: userId,
    label,
    direction,
    description_fi: "Yksi lause suomeksi.",
    description_en: "One sentence in English.",
    embedding_fi: zeroVector,
    embedding_en: zeroVector,
    embedding_model: "text-embedding-3-small@512",
  };
}

describe.skipIf(!enabled)("feed preferences and LLM usage", () => {
  const anonymous: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
  const service: SupabaseClient | null = serviceKey ? createClient(url, serviceKey, options) : null;
  const userAClient: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
  const userBClient: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;

  function ready() {
    if (!anonymous || !service || !userAClient || !userBClient) {
      throw new Error("Local integration credentials are unavailable.");
    }
    return { anonymous, service, userAClient, userBClient };
  }

  const suffix = randomUUID();
  const password = `Preferences-test-${randomUUID()}Aa1!`;
  const emailA = `preferences-a-${suffix}@example.test`;
  const emailB = `preferences-b-${suffix}@example.test`;
  let userAId: string | undefined;
  let userBId: string | undefined;
  let preferenceBId: string | undefined;

  beforeAll(async () => {
    const { service: serviceClient, userAClient: clientA, userBClient: clientB } = ready();
    const userA = await serviceClient.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    });
    if (userA.error) throw new Error(`Creating user A failed: ${userA.error.message}`);
    userAId = userA.data.user.id;

    const userB = await serviceClient.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (userB.error) throw new Error(`Creating user B failed: ${userB.error.message}`);
    userBId = userB.data.user.id;

    const [signInA, signInB] = await Promise.all([
      clientA.auth.signInWithPassword({ email: emailA, password }),
      clientB.auth.signInWithPassword({ email: emailB, password }),
    ]);
    if (signInA.error) throw new Error(`Signing in user A failed: ${signInA.error.message}`);
    if (signInB.error) throw new Error(`Signing in user B failed: ${signInB.error.message}`);

    const preferenceB = await serviceClient
      .from("feed_preferences")
      .insert(preferenceRow(userBId, "B only"))
      .select("id")
      .single();
    if (preferenceB.error) {
      throw new Error(`Creating user B preference failed: ${preferenceB.error.message}`);
    }
    preferenceBId = preferenceB.data.id;

    const usageB = await serviceClient.from("llm_usage").insert({
      user_id: userBId,
      kind: "preferences",
    });
    if (usageB.error) throw new Error(`Creating user B usage failed: ${usageB.error.message}`);
  });

  afterAll(async () => {
    const { service: serviceClient } = ready();
    for (const userId of [userAId, userBId]) {
      if (userId) await serviceClient.auth.admin.deleteUser(userId);
    }
  });

  it("asserts schema, owner policies, column grants, and the invoker limit function", () => {
    const query = `
      select
        (select relrowsecurity from pg_class where oid = 'public.feed_preferences'::regclass) as preferences_rls,
        (select relrowsecurity from pg_class where oid = 'public.llm_usage'::regclass) as usage_rls,
        (select count(*) = 3 from pg_policies where schemaname = 'public' and tablename = 'feed_preferences') as preference_policies,
        (select count(*) = 2 from pg_policies where schemaname = 'public' and tablename = 'llm_usage') as usage_policies,
        (select column_default = 'auth.uid()' from information_schema.columns where table_schema = 'public' and table_name = 'feed_preferences' and column_name = 'user_id') as preference_user_default,
        (select column_default = 'auth.uid()' from information_schema.columns where table_schema = 'public' and table_name = 'llm_usage' and column_name = 'user_id') as usage_user_default,
        has_table_privilege('authenticated', 'public.feed_preferences', 'SELECT') as preference_select,
        not has_table_privilege('authenticated', 'public.feed_preferences', 'INSERT') as preference_insert_denied,
        has_table_privilege('authenticated', 'public.feed_preferences', 'DELETE') as preference_delete,
        has_column_privilege('authenticated', 'public.feed_preferences', 'direction', 'UPDATE') as direction_update,
        not has_column_privilege('authenticated', 'public.feed_preferences', 'label', 'UPDATE') as label_update_denied,
        not has_table_privilege('anon', 'public.feed_preferences', 'SELECT') as anon_preference_denied,
        has_table_privilege('authenticated', 'public.llm_usage', 'SELECT') as usage_select,
        has_column_privilege('authenticated', 'public.llm_usage', 'kind', 'INSERT') as usage_kind_insert,
        not has_column_privilege('authenticated', 'public.llm_usage', 'user_id', 'INSERT') as usage_user_insert_denied,
        not has_column_privilege('authenticated', 'public.llm_usage', 'created_at', 'INSERT') as usage_created_insert_denied,
        not has_table_privilege('authenticated', 'public.llm_usage', 'UPDATE') as usage_update_denied,
        not has_table_privilege('authenticated', 'public.llm_usage', 'DELETE') as usage_delete_denied,
        not has_table_privilege('anon', 'public.llm_usage', 'SELECT') as anon_usage_denied,
        has_function_privilege('authenticated', 'public.reserve_llm_call(text)', 'EXECUTE') as authenticated_reserve,
        not has_function_privilege('anon', 'public.reserve_llm_call(text)', 'EXECUTE') as anon_reserve_denied,
        not (select prosecdef from pg_proc where oid = 'public.reserve_llm_call(text)'::regprocedure) as reserve_is_invoker,
        not (select provolatile = 's' from pg_proc where oid = 'public.reserve_llm_call(text)'::regprocedure) as reserve_is_volatile`;
    const output = execFileSync(
      "supabase",
      ["db", "query", "--local", "--output-format", "json", query],
      {
        encoding: "utf8",
      },
    );
    const result = parseSupabaseQueryResult(output);
    const row = result.rows[0] as Record<string, boolean>;
    expect(row).toEqual({
      preferences_rls: true,
      usage_rls: true,
      preference_policies: true,
      usage_policies: true,
      preference_user_default: true,
      usage_user_default: true,
      preference_select: true,
      preference_insert_denied: true,
      preference_delete: true,
      direction_update: true,
      label_update_denied: true,
      anon_preference_denied: true,
      usage_select: true,
      usage_kind_insert: true,
      usage_user_insert_denied: true,
      usage_created_insert_denied: true,
      usage_update_denied: true,
      usage_delete_denied: true,
      anon_usage_denied: true,
      authenticated_reserve: true,
      anon_reserve_denied: true,
      reserve_is_invoker: true,
      reserve_is_volatile: true,
    });
  });

  it("keeps preferences owner-only and allows only a direction update", async () => {
    const { service: serviceClient, userAClient: clientA } = ready();
    if (!userAId || !preferenceBId) throw new Error("Fixture users are missing.");

    const inserted = await serviceClient
      .from("feed_preferences")
      .insert(preferenceRow(userAId, "A only", "less"))
      .select("id")
      .single();
    expect(inserted.error).toBeNull();
    const preferenceAId = inserted.data?.id;
    if (!preferenceAId) throw new Error("User A preference was not created.");

    const ownRead = await clientA.from("feed_preferences").select("id,label,direction");
    expect(ownRead.error).toBeNull();
    expect(ownRead.data?.map((row) => row.id)).toEqual([preferenceAId]);

    const foreignRead = await clientA.from("feed_preferences").select("id").eq("id", preferenceBId);
    expect(foreignRead.error).toBeNull();
    expect(foreignRead.data).toEqual([]);

    const userInsert = await clientA.from("feed_preferences").insert(preferenceRow(userAId, "no"));
    expect(userInsert.error?.code).toBe("42501");

    const flipped = await clientA
      .from("feed_preferences")
      .update({ direction: "more" })
      .eq("id", preferenceAId)
      .select("direction")
      .single();
    expect(flipped.error).toBeNull();
    expect(flipped.data?.direction).toBe("more");

    const labelUpdate = await clientA
      .from("feed_preferences")
      .update({ label: "changed" })
      .eq("id", preferenceAId);
    expect(labelUpdate.error?.code).toBe("42501");

    const foreignUpdate = await clientA
      .from("feed_preferences")
      .update({ direction: "less" })
      .eq("id", preferenceBId)
      .select("id");
    expect(foreignUpdate.error).toBeNull();
    expect(foreignUpdate.data).toEqual([]);

    const foreignDelete = await clientA.from("feed_preferences").delete().eq("id", preferenceBId);
    expect(foreignDelete.error).toBeNull();
    const stillThere = await serviceClient
      .from("feed_preferences")
      .select("id")
      .eq("id", preferenceBId);
    expect(stillThere.data).toHaveLength(1);

    const deleted = await clientA.from("feed_preferences").delete().eq("id", preferenceAId);
    expect(deleted.error).toBeNull();
    const gone = await serviceClient.from("feed_preferences").select("id").eq("id", preferenceAId);
    expect(gone.data).toEqual([]);
  });

  it("keeps LLM usage owner-only and rejects forged or timestamped inserts", async () => {
    const { service: serviceClient, userAClient: clientA } = ready();
    if (!userAId || !userBId) throw new Error("Fixture users are missing.");

    const ownInsert = await clientA.from("llm_usage").insert({ kind: "preferences" }).select("id");
    expect(ownInsert.error).toBeNull();
    expect(ownInsert.data).toHaveLength(1);

    const otherUser = await clientA
      .from("llm_usage")
      .insert({ user_id: userBId, kind: "preferences" });
    expect(otherUser.error?.code).toBe("42501");

    const stamped = await clientA.from("llm_usage").insert({
      kind: "preferences",
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(stamped.error?.code).toBe("42501");

    const updated = await clientA
      .from("llm_usage")
      .update({ kind: "preferences" })
      .eq("user_id", userAId);
    expect(updated.error?.code).toBe("42501");

    const deleted = await clientA.from("llm_usage").delete().eq("user_id", userAId);
    expect(deleted.error?.code).toBe("42501");

    const foreignRead = await clientA.from("llm_usage").select("id").eq("user_id", userBId);
    expect(foreignRead.error).toBeNull();
    expect(foreignRead.data).toEqual([]);

    const visible = await serviceClient
      .from("llm_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userBId);
    expect(visible.count).toBeGreaterThan(0);
  });

  it("denies anonymous access to both tables and the limit function", async () => {
    const { anonymous: anon } = ready();
    const preferenceRead = await anon.from("feed_preferences").select("id");
    expect(preferenceRead.error?.code).toBe("42501");
    const usageRead = await anon.from("llm_usage").select("id");
    expect(usageRead.error?.code).toBe("42501");
    const reserved = await anon.rpc("reserve_llm_call", { p_kind: "preferences" });
    expect(reserved.error?.code).toBe("42501");
  });

  it("reserves ten calls, ignores rows older than 24 hours, and isolates users", async () => {
    const { service: serviceClient, userAClient: clientA, userBClient: clientB } = ready();
    if (!userAId || !userBId) throw new Error("Fixture users are missing.");

    await serviceClient.from("llm_usage").delete().eq("user_id", userAId);
    const stale = await serviceClient.from("llm_usage").insert({
      user_id: userAId,
      kind: "preferences",
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(stale.error).toBeNull();

    for (let call = 0; call < 10; call += 1) {
      const reserved = await clientA.rpc("reserve_llm_call", { p_kind: "preferences" });
      expect(reserved.error).toBeNull();
      expect(reserved.data).toBe(true);
    }
    const blocked = await clientA.rpc("reserve_llm_call", { p_kind: "preferences" });
    expect(blocked.error).toBeNull();
    expect(blocked.data).toBe(false);

    const recent = await serviceClient
      .from("llm_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userAId)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    expect(recent.count).toBe(10);

    const otherUser = await clientB.rpc("reserve_llm_call", { p_kind: "preferences" });
    expect(otherUser.error).toBeNull();
    expect(otherUser.data).toBe(true);

    const unknown = await clientB.rpc("reserve_llm_call", { p_kind: "other" });
    expect(unknown.error).not.toBeNull();
  });

  it("inserts only one row when two calls reserve the last slot together", async () => {
    const { service: serviceClient, userAClient: clientA } = ready();
    if (!userAId) throw new Error("Fixture user is missing.");

    await serviceClient.from("llm_usage").delete().eq("user_id", userAId);
    const seeded = await serviceClient
      .from("llm_usage")
      .insert(Array.from({ length: 9 }, () => ({ user_id: userAId, kind: "preferences" })));
    expect(seeded.error).toBeNull();

    const [first, second] = await Promise.all([
      clientA.rpc("reserve_llm_call", { p_kind: "preferences" }),
      clientA.rpc("reserve_llm_call", { p_kind: "preferences" }),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect([first.data, second.data].filter(Boolean)).toHaveLength(1);

    const count = await serviceClient
      .from("llm_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userAId);
    expect(count.count).toBe(10);
  });

  it("saves nothing when one insert would exceed 20 and caps concurrent batches at 20", async () => {
    const { service: serviceClient } = ready();
    if (!userAId) throw new Error("Fixture user is missing.");
    const ownerId = userAId;

    await serviceClient.from("feed_preferences").delete().eq("user_id", ownerId);
    const tooMany = await serviceClient
      .from("feed_preferences")
      .insert(Array.from({ length: 21 }, (_, index) => preferenceRow(ownerId, `over-${index}`)));
    expect(tooMany.error).not.toBeNull();
    const afterOverflow = await serviceClient
      .from("feed_preferences")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId);
    expect(afterOverflow.count).toBe(0);

    const seeded = await serviceClient
      .from("feed_preferences")
      .insert(Array.from({ length: 19 }, (_, index) => preferenceRow(ownerId, `seed-${index}`)));
    expect(seeded.error).toBeNull();

    await Promise.all([
      serviceClient
        .from("feed_preferences")
        .insert([preferenceRow(ownerId, "batch-a-1"), preferenceRow(ownerId, "batch-a-2")]),
      serviceClient
        .from("feed_preferences")
        .insert([preferenceRow(ownerId, "batch-b-1"), preferenceRow(ownerId, "batch-b-2")]),
    ]);

    const afterConcurrent = await serviceClient
      .from("feed_preferences")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId);
    expect(afterConcurrent.count).toBeLessThanOrEqual(20);
    expect(afterConcurrent.count).toBe(19);
  });
});
