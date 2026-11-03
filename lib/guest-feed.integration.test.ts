import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

const enabled = process.env.SUPABASE_INTEGRATION === "1";
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };

describe.skipIf(!enabled || !anonKey || !serviceKey)("public guest metadata", () => {
  const anonymous = anonKey ? createClient(url, anonKey, options) : null;
  const service = serviceKey ? createClient(url, serviceKey, options) : null;
  const activeId = randomUUID();
  const inactiveId = randomUUID();
  const articleId = randomUUID();
  const videoId = randomUUID();
  const hiddenIds = Array.from({ length: 6 }, () => randomUUID());
  const ids = [articleId, videoId, ...hiddenIds];
  const recent = new Date(Date.now() - 3_600_000).toISOString();

  beforeAll(async () => {
    if (!service) throw new Error("Missing local service client");
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const sources = await service.from("sources").insert(
      [activeId, inactiveId].map((id) => ({
        id,
        name: `Guest preview ${id}`,
        feed_url: `https://guest-test.example/${id}/feed`,
        kind: "rss",
        language: "en",
        is_active: id === activeId,
      })),
    );
    expect(sources.error).toBeNull();
    const base = (id: string) => ({
      id, source_id: activeId, title: "Public story", type: "article",
      url: `https://guest-test.example/${id}`, language: "en",
      summary: "A public summary", summary_origin: "feed",
      enrichment_status: "completed", published_at: recent,
    });
    const items = await service.from("content_items").insert([
      base(articleId),
      { ...base(videoId), type: "video" },
      { ...base(hiddenIds[0]!), source_id: inactiveId },
      { ...base(hiddenIds[1]!), summary: null, summary_origin: null, enrichment_status: "pending" },
      { ...base(hiddenIds[2]!), summary: "   ", summary_origin: null, enrichment_status: "pending" },
      { ...base(hiddenIds[3]!), url: `javascript:alert('${hiddenIds[3]}')` },
      { ...base(hiddenIds[4]!), published_at: new Date(Date.now() + 3_600_000).toISOString() },
      { ...base(hiddenIds[5]!), published_at: new Date(Date.now() - 8 * 86_400_000).toISOString() },
    ]);
    expect(items.error).toBeNull();
  });

  afterAll(async () => {
    if (!service) return;
    await service.from("content_items").delete().in("id", ids);
    await service.from("sources").delete().in("id", [activeId, inactiveId]);
  });

  it("allows the exact public projection and source join, with no internal columns", async () => {
    const result = await anonymous!.from("content_items")
      .select("id,source_id,url,title,summary,summary_origin,type,language,thumbnail_url,published_at,sources(id,name)")
      .in("id", ids);
    expect(result.error).toBeNull();
    expect(result.data?.map((item) => item.id).sort()).toEqual([articleId, videoId].sort());
    expect(result.data?.[0]?.sources).toEqual({ id: activeId, name: `Guest preview ${activeId}` });
    const sources = await anonymous!.from("sources").select("id,name").in("id", [activeId, inactiveId]);
    expect(sources.error).toBeNull();
    expect(sources.data?.map((source) => source.id)).toEqual([activeId]);
  });

  it("enforces exact article/video time boundaries using the database clock", () => {
    // One transaction freezes now(); rollback restores the disposable fixtures.
    const output = execFileSync("docker", [
      "exec", "-i", "supabase_db_ai-feed", "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-At",
    ], {
      encoding: "utf8", input: `
      begin;
      update public.content_items set published_at = now() - interval '7 days' where id = '${articleId}';
      update public.content_items set published_at = now() - interval '30 days' where id = '${videoId}';
      set local role anon;
      select count(*) = 2 from public.content_items where id in ('${articleId}', '${videoId}');
      reset role;
      update public.content_items set published_at = published_at - interval '1 microsecond'
        where id in ('${articleId}', '${videoId}');
      set local role anon;
      select count(*) = 0 from public.content_items where id in ('${articleId}', '${videoId}');
      reset role;
      update public.content_items set published_at = now() where id = '${articleId}';
      set local role anon;
      select count(*) = 1 from public.content_items where id = '${articleId}';
      reset role;
      update public.content_items set published_at = now() + interval '1 microsecond' where id = '${articleId}';
      set local role anon;
      select count(*) = 0 from public.content_items where id = '${articleId}';
      rollback;
    ` });
    expect(output.split("\n").filter((line) => line === "t")).toHaveLength(4);
    expect(output.split("\n")).not.toContain("f");
  });

  it.each([
    ["sources", "*"], ["sources", "feed_url"], ["sources", "last_error"],
    ["sources", "is_active"], ["content_items", "*"], ["content_items", "embedding"],
    ["content_items", "embedding_model"], ["content_items", "enrichment_status"],
    ["content_items", "enrichment_error"], ["content_items", "categories"],
    ["content_items", "created_at"],
  ])("denies anonymous %s.%s reads", async (table, column) => {
    const result = await anonymous!.from(table).select(column).limit(1);
    expect(result.error?.code).toBe("42501");
  });

  it("denies writes to both tables and leaves data unchanged", async () => {
    for (const [table, id, change] of [
      ["sources", activeId, { name: "Forbidden change" }],
      ["content_items", articleId, { title: "Forbidden change" }],
    ] as const) {
      const original = await service!.from(table).select("*").eq("id", id).single();
      expect(original.error).toBeNull();
      const insertion = await anonymous!.from(table).insert({ ...original.data, id: randomUUID() });
      const update = await anonymous!.from(table).update(change).eq("id", id);
      const deletion = await anonymous!.from(table).delete().eq("id", id);
      expect(insertion.error?.code).toBe("42501");
      expect(update.error?.code).toBe("42501");
      expect(deletion.error?.code).toBe("42501");
      const unchanged = await service!.from(table).select("*").eq("id", id).single();
      expect(unchanged.data).toEqual(original.data);
    }
  });

  it("keeps personal data, language means, and personalized RPCs protected", async () => {
    for (const table of ["feedback", "embedding_language_means"]) {
      const result = await anonymous!.from(table).select("*");
      expect(result.error?.code).toBe("42501");
    }
    for (const [name, args] of [
      ["get_feed", { p_limit: 12 }],
      ["set_feedback", { p_item_id: articleId, p_kind: "like", p_via: "button" }],
    ] as const) {
      const result = await anonymous!.rpc(name, args);
      expect(result.error?.code).toBe("42501");
    }
  });
});
