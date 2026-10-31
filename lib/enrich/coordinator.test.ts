import { describe, expect, it, vi } from "vitest";
import type { EnrichmentDb, EnrichmentItem } from "../db.ts";
import {
  DESCRIPTION_SUMMARY_MODEL,
  ENRICHMENT_RETRY_DELAYS_MS,
  MAX_ENRICHMENT_ATTEMPTS,
  MAX_SUMMARY_OUTPUT_TOKENS,
  MAX_SUMMARY_REQUESTS_PER_RUN,
  runEnrichment,
  summarizeArticleText,
} from "./coordinator.ts";
import type { PageFetchResult } from "./page.ts";

const fixedNow = new Date("2026-10-31T12:00:00.000Z");
const articleText =
  "The Finnish research team published a new study about renewable energy. " +
  "The researchers measured changes over three years and reported the results in October.";

function item(id: string, attemptCount = 0): EnrichmentItem {
  return {
    id,
    url: `https://${id}.example.com/article`,
    title: `Title ${id}`,
    summary: null,
    language: "fi",
    attemptCount,
  };
}

function page(html: string): PageFetchResult {
  return {
    status: "ok",
    html,
    finalUrl: "https://example.com/article",
    contentType: "text/html; charset=utf-8",
  };
}

class FakeEnrichmentDb implements EnrichmentDb {
  successes: Array<{
    id: string;
    expectedAttemptCount: number;
    summary: string;
    origin: "page_metadata" | "ai_generated";
    attemptedAt: Date;
  }> = [];
  failures: Array<{
    id: string;
    expectedAttemptCount: number;
    attemptedAt: Date;
    nextAttemptAt: Date | null;
    error: string;
    exhausted: boolean;
  }> = [];

  constructor(readonly candidates: EnrichmentItem[]) {}

  async listDueEnrichmentItems(limit: number): Promise<EnrichmentItem[]> {
    return this.candidates.slice(0, limit);
  }

  async saveEnrichedSummary(
    id: string,
    expectedAttemptCount: number,
    summary: string,
    origin: "page_metadata" | "ai_generated",
    attemptedAt: Date,
  ): Promise<boolean> {
    this.successes.push({
      id,
      expectedAttemptCount,
      summary,
      origin,
      attemptedAt,
    });
    return true;
  }

  async saveEnrichmentFailure(
    id: string,
    expectedAttemptCount: number,
    attemptedAt: Date,
    nextAttemptAt: Date | null,
    error: string,
    exhausted: boolean,
  ): Promise<boolean> {
    this.failures.push({
      id,
      expectedAttemptCount,
      attemptedAt,
      nextAttemptAt,
      error,
      exhausted,
    });
    return true;
  }
}

describe("runEnrichment", () => {
  it("saves usable page metadata without calling the summarizer", async () => {
    const db = new FakeEnrichmentDb([item("metadata")]);
    const summarize = vi.fn(async () => "unexpected");
    const result = await runEnrichment(db, "test-key", {
      now: () => fixedNow,
      fetchPage: async () =>
        page(
          '<meta property="og:description" content="A factual description">',
        ),
      summarize,
    });

    expect(result).toMatchObject({
      selected: 1,
      processed: 1,
      succeeded: 1,
      unresolved: 0,
      summaryRequests: 0,
      byOrigin: { page_metadata: 1, ai_generated: 0 },
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(db.successes[0]).toMatchObject({
      id: "metadata",
      summary: "A factual description",
      origin: "page_metadata",
      expectedAttemptCount: 0,
      attemptedAt: fixedNow,
    });
  });

  it("uses article text only and isolates an item failure from later items", async () => {
    const db = new FakeEnrichmentDb([item("failed"), item("success")]);
    const summarize = vi.fn(async () => "Tiivis kuvaus tutkimuksesta.");
    const result = await runEnrichment(db, "test-key", {
      now: () => fixedNow,
      fetchPage: async (url) =>
        url.includes("failed")
          ? { status: "error", error: "request timed out" }
          : page(
              `<article><h1>Article headline</h1><p>${articleText}</p></article>`,
            ),
      summarize,
    });

    expect(result).toMatchObject({
      selected: 2,
      processed: 2,
      succeeded: 1,
      unresolved: 1,
      failed: 0,
      summaryRequests: 1,
      byOrigin: { page_metadata: 0, ai_generated: 1 },
    });
    expect(summarize).toHaveBeenCalledWith(
      expect.stringContaining(articleText),
      "test-key",
    );
    expect(db.failures[0]).toMatchObject({
      id: "failed",
      nextAttemptAt: new Date(
        fixedNow.getTime() + ENRICHMENT_RETRY_DELAYS_MS[0],
      ),
      exhausted: false,
    });
    expect(db.successes[0]?.origin).toBe("ai_generated");
  });

  it("does not ask the model to summarize title-only pages", async () => {
    const db = new FakeEnrichmentDb([
      { ...item("title-only"), title: "Only a title" },
    ]);
    const summarize = vi.fn(async () => "A generated description");
    const result = await runEnrichment(db, "test-key", {
      now: () => fixedNow,
      fetchPage: async () => page("<article><h1>Only a title</h1></article>"),
      summarize,
    });

    expect(result.unresolved).toBe(1);
    expect(summarize).not.toHaveBeenCalled();
    expect(db.failures[0]?.error).toBe("page has no readable article text");
  });

  it("keeps model requests within the run budget", async () => {
    const db = new FakeEnrichmentDb([item("one"), item("two")]);
    const summarize = vi.fn(async () => "A short summary");
    const result = await runEnrichment(db, "test-key", {
      now: () => fixedNow,
      maxSummaryRequests: 1,
      fetchPage: async () => page(`<article><p>${articleText}</p></article>`),
      summarize,
    });

    expect(result.summaryRequests).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(MAX_SUMMARY_REQUESTS_PER_RUN).toBe(20);
  });

  it.each([0, 1, 2])(
    "uses the bounded retry schedule after attempt count %i",
    async (attemptCount) => {
      const db = new FakeEnrichmentDb([item("retry", attemptCount)]);
      const result = await runEnrichment(db, "test-key", {
        now: () => fixedNow,
        fetchPage: async () => ({
          status: "error",
          error: "request timed out",
        }),
      });
      const failure = db.failures[0];

      expect(result.unresolved).toBe(1);
      expect(failure?.expectedAttemptCount).toBe(attemptCount);
      expect(failure?.exhausted).toBe(
        attemptCount + 1 >= MAX_ENRICHMENT_ATTEMPTS,
      );
      expect(failure?.nextAttemptAt).toEqual(
        attemptCount + 1 >= MAX_ENRICHMENT_ATTEMPTS
          ? null
          : new Date(
              fixedNow.getTime() + ENRICHMENT_RETRY_DELAYS_MS[attemptCount]!,
            ),
      );
    },
  );
});

describe("summarizeArticleText", () => {
  it("uses the approved model, language constraints, no tools, and output cap", async () => {
    let body = "";
    const mockFetch: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "Tiivis kuvaus tutkimuksesta." },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    };

    const result = await summarizeArticleText(articleText, "test-key", {
      fetch: mockFetch,
    });

    expect(result).toBe("Tiivis kuvaus tutkimuksesta.");
    expect(body).toContain(`"model":"${DESCRIPTION_SUMMARY_MODEL}"`);
    expect(body).toContain('"reasoning":{"effort":"none"}');
    expect(body).toContain(`"max_output_tokens":${MAX_SUMMARY_OUTPUT_TOKENS}`);
    expect(body).toContain('"tools":[]');
    expect(body).toContain('"store":false');
    expect(body).toContain("Finnish or English");
    expect(body).toContain("untrusted source content");
    expect(body).toContain(articleText);
    expect(body).not.toContain("Title");
  });

  it("does not expose remote error bodies", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: { message: "private response detail" } }),
        {
          status: 500,
        },
      );

    await expect(
      summarizeArticleText(articleText, "test-key", { fetch: mockFetch }),
    ).rejects.toThrow("summary service returned HTTP 500");
  });
});
