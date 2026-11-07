import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";
import { createIngestDb } from "../db.ts";
import { EMBEDDING_MODEL_VERSION } from "../embeddings.ts";
import { parseThumbnailCursor, runThumbnailBackfill } from "./backfill.ts";
import { NASA_RELEASES_FEED_URL } from "./publisher.ts";

const enabled = process.env.SUPABASE_INTEGRATION === "1";
const url = "http://127.0.0.1:55321";

it.skipIf(!enabled)(
  "backfills recent NASA thumbnails on local Supabase with a stable cursor and guarded writes",
  async () => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key || process.env.SUPABASE_URL !== url) throw new Error("Local Supabase is required");
    const client = createClient(url, key);
    const db = createIngestDb({ NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key });
    const nasa = await client
      .from("sources")
      .select("id")
      .eq("feed_url", NASA_RELEASES_FEED_URL)
      .single();
    if (nasa.error) throw nasa.error;

    // Freeze a separate seven-day window to avoid touching the developer's data.
    const now = new Date("2042-11-07T17:00:00Z");
    const runId = crypto.randomUUID();
    const html = readFileSync(
      new URL("../../test/fixtures/thumbnails/nasa-valid-upload.html", import.meta.url),
      "utf8",
    );
    const image = "https://www.nasa.gov/wp-content/uploads/2026/10/mou10242026.jpg";
    const small = `${image}?resize=300,227`;
    const concurrentImage = "https://www.nasa.gov/wp-content/uploads/newer.jpg";
    const row = (
      slug: string,
      thumbnail_url: string | null,
      published_at = "2042-11-06T12:00:00.123456Z",
    ) => ({
      id: crypto.randomUUID(),
      source_id: nasa.data.id,
      title: slug,
      url: `https://www.nasa.gov/news-release/${slug}-${runId}/`,
      type: "article",
      language: "en",
      summary: "Existing summary",
      summary_origin: "feed",
      enrichment_status: "completed",
      embedding: Array.from({ length: 512 }, () => 0.1),
      embedding_model: EMBEDDING_MODEL_VERSION,
      published_at,
      thumbnail_url,
    });
    const missing = row("missing", null, "2042-11-07T10:00:00Z");
    const legacy = row("legacy", small, "2042-11-07T09:00:00Z");
    const concurrent = row("concurrent", small, "2042-11-07T08:00:00Z");
    const omitted = row("omit", small, "2042-11-07T07:00:00Z");
    const unsafe = row("unsafe", small, "2042-11-07T06:00:00Z");
    const unresolved = Array.from({ length: 18 }, (_, index) => row(`unresolved-${index}`, null));
    const older = row("older", null, "2042-11-05T12:00:00Z");
    const suitable = row("suitable", `${image}?resize=960,727`, "2042-11-07T12:00:00Z");
    const apod = {
      ...row("apod", null),
      url: `https://science.nasa.gov/image-article/apod-${runId}/`,
    };
    const outside = row("outside", null, "2042-10-30T12:00:00Z");
    const future = row("future", null, "2042-11-08T12:00:00Z");
    const rows = [
      missing,
      legacy,
      concurrent,
      omitted,
      unsafe,
      ...unresolved,
      older,
      suitable,
      apod,
      outside,
      future,
    ];
    const ids = rows.map(({ id }) => id);
    async function stored() {
      const result = await client.from("content_items").select("*").in("id", ids).order("id");
      if (result.error) throw result.error;
      return result.data;
    }

    try {
      expect((await client.from("content_items").insert(rows)).error).toBeNull();
      const before = await stored();
      const requests: string[] = [];
      const pageFetch = {
        resolve: async () => [{ address: "1.1.1.1", family: 4 }],
        request: async (page: URL) => {
          requests.push(page.href);
          if (page.href === concurrent.url) {
            expect(
              (
                await client
                  .from("content_items")
                  .update({ thumbnail_url: concurrentImage })
                  .eq("id", concurrent.id)
              ).error,
            ).toBeNull();
          }
          const status = page.href === unsafe.url ? 503 : 200;
          const hasImage = [missing, legacy, concurrent, older].some(
            (item) => item.url === page.href,
          );
          return {
            status,
            headers: { "content-type": "text/html" },
            body: new TextEncoder().encode(hasImage ? html : "<html></html>"),
          };
        },
      };

      const dry = await runThumbnailBackfill(db, { dryRun: true, now, pageFetch });
      expect(dry.candidates).toHaveLength(20);
      expect(dry.candidates.slice(0, 5).map(({ id }) => id)).toEqual(
        [missing, legacy, concurrent, omitted, unsafe].map(({ id }) => id),
      );
      expect(requests).toHaveLength(0);
      expect(await stored()).toEqual(before);

      const first = await runThumbnailBackfill(db, { now, pageFetch });
      expect(first).toMatchObject({
        found: 3,
        upgraded: 2,
        omitted: 16,
        fetchFailures: 1,
        concurrentChanges: 1,
      });
      expect(first.cursor).toBe(dry.cursor);
      if (!first.cursor) throw new Error("Expected a continuation cursor");
      expect(first.cursor).toContain(".123456");

      const next = await runThumbnailBackfill(db, {
        now,
        cursor: parseThumbnailCursor(first.cursor),
        pageFetch,
      });
      expect(next.candidates).toHaveLength(4);
      expect(
        next.candidates.every(
          ({ id }) => !first.candidates.some((candidate) => candidate.id === id),
        ),
      ).toBe(true);
      expect(next.candidates.at(-1)?.id).toBe(older.id);
      expect(next.upgraded).toBe(1);
      expect(next.cursor).toBeNull();

      const rerun = await runThumbnailBackfill(db, { dryRun: true, now });
      expect(rerun.candidates.map(({ id }) => id)).not.toContain(missing.id);
      expect(rerun.candidates.map(({ id }) => id)).not.toContain(legacy.id);
      expect(rerun.candidates.map(({ id }) => id)).not.toContain(older.id);

      const changed = new Map([
        [missing.id, image],
        [legacy.id, image],
        [concurrent.id, concurrentImage],
        [omitted.id, null],
        [older.id, image],
      ]);
      expect(await stored()).toEqual(
        before.map((item) =>
          changed.has(item.id) ? { ...item, thumbnail_url: changed.get(item.id) } : item,
        ),
      );
    } finally {
      expect((await client.from("content_items").delete().in("id", ids)).error).toBeNull();
    }
  },
  15_000,
);
