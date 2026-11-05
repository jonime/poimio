/** Integration coverage for the feedback schema and owner-only access. */
import assert from "node:assert/strict";
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

const feedbackSchemaColumns = [
  "rls_enabled",
  "four_owner_policies",
  "required_columns_not_null",
  "timestamp_defaults",
  "user_defaults_to_auth_uid",
  "authenticated_select",
  "authenticated_insert",
  "authenticated_delete",
  "kind_update",
  "via_update",
  "no_table_update",
  "user_id_immutable",
  "item_id_immutable",
  "authenticated_rpc",
  "anonymous_rpc_denied",
  "rpc_is_invoker",
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
      const character = output.charAt(index);
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

    try {
      const candidate: unknown = JSON.parse(output.slice(start, end + 1));
      if (typeof candidate === "object" && candidate !== null && "rows" in candidate) {
        const rows = candidate.rows;
        if (Array.isArray(rows)) return { rows };
      }
      if (typeof candidate === "object" && candidate !== null) {
        const keys = Object.keys(candidate);
        observedObjectKeys.push(keys.slice(0, 16).join(","));
        if (feedbackSchemaColumns.every((column) => column in candidate)) {
          return { rows: [candidate] };
        }
      }
      searchFrom = end + 1;
    } catch {
      searchFrom = start + 1;
    }
  }
}

describe("parseSupabaseQueryResult", () => {
  it("finds query rows after other JSON output and trailing text", () => {
    expect(
      parseSupabaseQueryResult(
        'Connecting to local database...\n{"boundary":"id"}\n{"rows":[{"value":"brace } inside"}]}\n{"other":true}',
      ),
    ).toEqual({ rows: [{ value: "brace } inside" }] });
  });

  it("accepts a direct feedback schema row from the CLI", () => {
    const row = Object.fromEntries(feedbackSchemaColumns.map((column) => [column, true]));
    expect(parseSupabaseQueryResult(`Connecting...\n${JSON.stringify([row])}`)).toEqual({
      rows: [row],
    });
  });
});

describe.skipIf(!enabled || anonKey == null || serviceKey == null)(
  "feedback schema and row-level security against local Supabase",
  () => {
    const anonymous: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
    const service: SupabaseClient | null = serviceKey
      ? createClient(url, serviceKey, options)
      : null;
    const userAClient: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;
    const userBClient: SupabaseClient | null = anonKey ? createClient(url, anonKey, options) : null;

    function ready() {
      if (!anonymous || !service || !userAClient || !userBClient) {
        throw new Error("Local integration credentials are unavailable.");
      }
      return { anonymous, service, userAClient, userBClient };
    }

    const suffix = randomUUID();
    const password = `Feedback-test-${randomUUID()}Aa1!`;
    const emailA = `feedback-a-${suffix}@example.test`;
    const emailB = `feedback-b-${suffix}@example.test`;
    const feedUrl = `https://feedback-integration.example/${suffix}/feed`;
    const itemUrl = `https://feedback-integration.example/${suffix}/item`;
    let userAId: string | undefined;
    let userBId: string | undefined;
    let sourceId: string | undefined;
    let itemId: string | undefined;

    beforeAll(async () => {
      const { service, userAClient, userBClient } = ready();
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

      const source = await service
        .from("sources")
        .insert({
          name: "Feedback integration test",
          feed_url: feedUrl,
          kind: "rss",
          language: "en",
          is_active: true,
        })
        .select("id")
        .single();
      if (source.error) throw new Error(`Creating fixture source failed: ${source.error.message}`);
      sourceId = source.data.id;

      const item = await service
        .from("content_items")
        .insert({
          source_id: sourceId,
          type: "article",
          url: itemUrl,
          title: "Feedback integration test item",
          language: "en",
          published_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (item.error) throw new Error(`Creating fixture item failed: ${item.error.message}`);
      itemId = item.data.id;
    });

    afterAll(async () => {
      const { service } = ready();
      for (const userId of [userAId, userBId]) {
        if (userId) await service.auth.admin.deleteUser(userId);
      }
      if (itemId) await service.from("content_items").delete().eq("id", itemId);
      if (sourceId) await service.from("sources").delete().eq("id", sourceId);
    });

    it("asserts schema, nullability, defaults, RLS policies, grants, and invoker RPC", () => {
      const query = `
        select
          (select relrowsecurity from pg_class where oid = 'public.feedback'::regclass) as rls_enabled,
          (select count(*) = 4 from pg_policies where schemaname = 'public' and tablename = 'feedback') as four_owner_policies,
          (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'feedback' and column_name in ('kind', 'via', 'created_at', 'updated_at') and is_nullable = 'NO') as required_columns_not_null,
          (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'feedback' and column_name in ('created_at', 'updated_at') and data_type = 'timestamp with time zone' and column_default = 'now()') as timestamp_defaults,
          (select column_default = 'auth.uid()' from information_schema.columns where table_schema = 'public' and table_name = 'feedback' and column_name = 'user_id') as user_defaults_to_auth_uid,
          has_table_privilege('authenticated', 'public.feedback', 'SELECT') as authenticated_select,
          has_table_privilege('authenticated', 'public.feedback', 'INSERT') as authenticated_insert,
          has_table_privilege('authenticated', 'public.feedback', 'DELETE') as authenticated_delete,
          has_column_privilege('authenticated', 'public.feedback', 'kind', 'UPDATE') as kind_update,
          has_column_privilege('authenticated', 'public.feedback', 'via', 'UPDATE') as via_update,
          not has_table_privilege('authenticated', 'public.feedback', 'UPDATE') as no_table_update,
          not has_column_privilege('authenticated', 'public.feedback', 'user_id', 'UPDATE') as user_id_immutable,
          not has_column_privilege('authenticated', 'public.feedback', 'item_id', 'UPDATE') as item_id_immutable,
          has_function_privilege('authenticated', 'public.set_feedback(uuid,text,text)', 'EXECUTE') as authenticated_rpc,
          not has_function_privilege('anon', 'public.set_feedback(uuid,text,text)', 'EXECUTE') as anonymous_rpc_denied,
          not (select prosecdef from pg_proc where oid = 'public.set_feedback(uuid,text,text)'::regprocedure) as rpc_is_invoker`;
      const output = execFileSync(
        "supabase",
        ["db", "query", "--local", "--output-format", "json", query],
        { encoding: "utf8" },
      );
      const result = parseSupabaseQueryResult(output);
      if (result.rows.length === 0) {
        throw new Error("Supabase CLI JSON query result did not contain rows.");
      }
      const row = result.rows[0] as Record<string, boolean>;
      expect(row).toEqual({
        rls_enabled: true,
        four_owner_policies: true,
        required_columns_not_null: true,
        timestamp_defaults: true,
        user_defaults_to_auth_uid: true,
        authenticated_select: true,
        authenticated_insert: true,
        authenticated_delete: true,
        kind_update: true,
        via_update: true,
        no_table_update: true,
        user_id_immutable: true,
        item_id_immutable: true,
        authenticated_rpc: true,
        anonymous_rpc_denied: true,
        rpc_is_invoker: true,
      });
    });

    it("rejects null and unknown kind or via values", async () => {
      const { service } = ready();
      const invalidRows = [
        { user_id: userAId, item_id: itemId, kind: null, via: "button" },
        { user_id: userAId, item_id: itemId, kind: "like", via: null },
        { user_id: userAId, item_id: itemId, kind: "unknown", via: "button" },
        { user_id: userAId, item_id: itemId, kind: "like", via: "unknown" },
      ];
      for (const row of invalidRows) {
        const { error } = await service.from("feedback").insert(row as never);
        expect(error).not.toBeNull();
        expect(["23502", "23514"]).toContain(error?.code);
      }
    });

    it("lets A create, read, and replace their own feedback with a newer timestamp", async () => {
      const { service, userAClient } = ready();
      const firstWrite = await userAClient.rpc("set_feedback", {
        p_item_id: itemId,
        p_kind: "like",
        p_via: "button",
      });
      expect(firstWrite.error).toBeNull();

      const firstRead = await service
        .from("feedback")
        .select("created_at,updated_at")
        .eq("user_id", userAId)
        .eq("item_id", itemId)
        .single();
      if (firstRead.error || !firstRead.data) {
        throw new Error(
          `Reading initial feedback failed: ${firstRead.error?.message ?? "row missing"}`,
        );
      }
      expect(Date.parse(firstRead.data.created_at)).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondWrite = await userAClient.rpc("set_feedback", {
        p_item_id: itemId,
        p_kind: "not_interested",
        p_via: "swipe",
      });
      expect(secondWrite.error).toBeNull();

      const latestRead = await userAClient
        .from("feedback")
        .select("kind,via,updated_at")
        .eq("item_id", itemId)
        .single();
      if (latestRead.error || !latestRead.data) {
        throw new Error(
          `Reading updated feedback failed: ${latestRead.error?.message ?? "row missing"}`,
        );
      }
      expect(latestRead.data.kind).toBe("not_interested");
      expect(latestRead.data.via).toBe("swipe");
      expect(Date.parse(latestRead.data.updated_at)).toBeGreaterThan(
        Date.parse(firstRead.data.updated_at),
      );

      const { count, error } = await service
        .from("feedback")
        .select("item_id", { count: "exact", head: true })
        .eq("user_id", userAId)
        .eq("item_id", itemId);
      expect(error).toBeNull();
      expect(count).toBe(1);
    });

    it("allows A to update only action columns and delete their own row", async () => {
      const { userAClient } = ready();
      const { error: updateError } = await userAClient
        .from("feedback")
        .update({ kind: "seen", via: "button" })
        .eq("item_id", itemId);
      expect(updateError).toBeNull();

      const { error: immutableError } = await userAClient
        .from("feedback")
        .update({ user_id: userBId })
        .eq("item_id", itemId);
      expect(immutableError?.code).toBe("42501");

      const { error: deleteError } = await userAClient
        .from("feedback")
        .delete()
        .eq("item_id", itemId);
      expect(deleteError).toBeNull();
    });

    it("prevents A from reading, updating, or deleting B's row", async () => {
      const { service, userAClient, userBClient } = ready();
      const { error: writeError } = await userBClient.rpc("set_feedback", {
        p_item_id: itemId,
        p_kind: "like",
        p_via: "button",
      });
      expect(writeError).toBeNull();

      const { data: readData, error: readError } = await userAClient
        .from("feedback")
        .select("item_id")
        .eq("item_id", itemId);
      expect(readError).toBeNull();
      expect(readData).toEqual([]);

      const { data: updatedRows, error: updateError } = await userAClient
        .from("feedback")
        .update({ kind: "seen" })
        .eq("user_id", userBId)
        .eq("item_id", itemId)
        .select("item_id");
      expect(updateError).toBeNull();
      expect(updatedRows).toEqual([]);

      const { data: deletedRows, error: deleteError } = await userAClient
        .from("feedback")
        .delete()
        .eq("user_id", userBId)
        .eq("item_id", itemId)
        .select("item_id");
      expect(deleteError).toBeNull();
      expect(deletedRows).toEqual([]);

      const { data: bRow, error: bReadError } = await service
        .from("feedback")
        .select("kind")
        .eq("user_id", userBId)
        .eq("item_id", itemId)
        .single();
      if (bReadError || !bRow) {
        throw new Error(`Reading user B feedback failed: ${bReadError?.message ?? "row missing"}`);
      }
      expect(bRow.kind).toBe("like");
    });

    it("rejects forged owners and immutable item IDs", async () => {
      const { service, userAClient } = ready();
      const { error: forgedInsert } = await userAClient.from("feedback").insert({
        user_id: userBId,
        item_id: itemId,
        kind: "like",
        via: "button",
      });
      expect(forgedInsert?.code).toBe("42501");

      const { error: itemUpdate } = await userAClient
        .from("feedback")
        .update({ item_id: randomUUID() })
        .eq("item_id", itemId);
      expect(itemUpdate?.code).toBe("42501");

      const { error: itemDelete } = await service.from("content_items").delete().eq("id", itemId);
      expect(itemDelete?.code).toBe("23503");
    });

    it("denies anonymous reads, writes, and RPC execution", async () => {
      const { anonymous } = ready();
      const { error: readError } = await anonymous
        .from("feedback")
        .select("item_id")
        .eq("item_id", itemId);
      expect(readError?.code).toBe("42501");

      const { error: writeError } = await anonymous.from("feedback").insert({
        item_id: itemId,
        kind: "like",
        via: "button",
      });
      expect(writeError?.code).toBe("42501");

      const { error: rpcError } = await anonymous.rpc("set_feedback", {
        p_item_id: itemId,
        p_kind: "like",
        p_via: "button",
      });
      expect(rpcError).not.toBeNull();
    });

    it("deletes a user's feedback when the user is deleted", async () => {
      const { service, userBClient } = ready();
      assert(userBId, "User B fixture ID must exist");
      const deletedUserId = userBId;
      const { error: writeError } = await userBClient.rpc("set_feedback", {
        p_item_id: itemId,
        p_kind: "seen",
        p_via: "button",
      });
      expect(writeError).toBeNull();

      const { error: deleteUserError } = await service.auth.admin.deleteUser(deletedUserId);
      expect(deleteUserError).toBeNull();
      userBId = undefined;

      const { data, error } = await service
        .from("feedback")
        .select("item_id")
        .eq("user_id", deletedUserId);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  },
);
