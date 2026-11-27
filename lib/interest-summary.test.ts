import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInterestSummaryRequest,
  clearInterestSummaryForUser,
  INTEREST_SUMMARY_INSTRUCTIONS,
  INTEREST_SUMMARY_MAX_OUTPUT_TOKENS,
  INTEREST_SUMMARY_TIMEOUT_MS,
  type InterestSummaryServiceClient,
  type InterestSummaryUserClient,
  parseInterestSummaryPayload,
  summarizeInterestsForUser,
} from "./interest-summary.ts";

const secretInput = "SECRET_TITLE";
const secretOutput = "SECRET_MODEL_OUTPUT";

function modelPayload(summary: unknown = "Interested in useful technology.", topics: unknown = []) {
  return {
    status: "completed",
    error: null,
    output: [
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify({ summary, topics }) }],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(options?: {
  userId?: string | null;
  claimsError?: boolean;
  liked?: unknown[];
  disliked?: unknown[];
  preferences?: unknown[];
  reserve?: boolean | null | "error";
  usageCount?: number;
  model?: () => Response;
  deleteError?: boolean;
  saveError?: boolean;
}) {
  const liked = options?.liked ?? [
    { item: { title: "First" } },
    { item: { title: "Second" } },
    { item: { title: "Third" } },
  ];
  const disliked = options?.disliked ?? [];
  const preferences = options?.preferences ?? [];
  const userId = options?.userId === undefined ? "user-a" : options.userId;
  const reserve = options?.reserve === undefined ? true : options.reserve;
  const saved: unknown[] = [];
  const deleted: string[] = [];
  const selections: Array<{ table: string; columns: string; limit?: number; orders: unknown[] }> =
    [];

  const query = (
    result: { data: unknown; error: { message: string } | null; count: number | null },
    table: string,
  ) => {
    const filters: unknown[] = [];
    const orders: unknown[] = [];
    const selection = selections.at(-1);
    const fluent = Object.assign(Promise.resolve(result), {
      eq: (column: string, value: string) => {
        filters.push([column, value]);
        if (column === "user_id" && table === "interest_summaries") {
          deleted.push(value);
        }
        return fluent;
      },
      gte: () => fluent,
      order: (column: string, value: { ascending: boolean }) => {
        orders.push([column, value]);
        selection?.orders.push([column, value]);
        return fluent;
      },
      limit: (count: number) => {
        if (selection) selection.limit = count;
        return fluent;
      },
    });
    return fluent;
  };

  const userClient = {
    auth: {
      getClaims: vi.fn(async () => ({
        data: userId === null ? null : { claims: { sub: userId } },
        error: options?.claimsError ? { message: "invalid claims" } : null,
      })),
    },
    rpc: vi.fn(async () => ({
      data: reserve === "error" ? null : reserve,
      error: reserve === "error" ? { message: "database" } : null,
    })),
    from: vi.fn((table: string) => {
      return {
        select: (columns: string) => {
          selections.push({ table, columns, orders: [] });
          const feedbackIndex = selections.filter((entry) => entry.table === "feedback").length;
          const data =
            table === "feedback"
              ? feedbackIndex === 1
                ? liked
                : disliked
              : table === "feed_preferences"
                ? preferences
                : table === "llm_usage"
                  ? null
                  : [{ user_id: userId }];
          return query(
            {
              data,
              error: null,
              count: table === "llm_usage" ? (options?.usageCount ?? 1) : null,
            },
            table,
          );
        },
        delete: () =>
          query(
            {
              data: [],
              error: options?.deleteError ? { message: "delete failed" } : null,
              count: null,
            },
            table,
          ),
      };
    }),
  } as unknown as InterestSummaryUserClient;
  const serviceClient = {
    from: () => ({
      upsert: (row: unknown) => ({
        select: async () => {
          saved.push(row);
          return options?.saveError
            ? { data: [], error: { message: "save failed" }, count: null }
            : { data: [row], error: null, count: null };
        },
      }),
    }),
  } as unknown as InterestSummaryServiceClient;
  const fetchImpl = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      options?.model?.() ?? jsonResponse(modelPayload()),
  );
  return { userClient, serviceClient, fetchImpl, saved, deleted, selections };
}

afterEach(() => vi.restoreAllMocks());

describe("interest summary prompt and validation", () => {
  it("uses the fixed strict request and separate JSON input", () => {
    const interests = {
      liked: ["cars"],
      not_interested: ["politics"],
      more: ["engineering"],
      less: ["celebrities"],
    };
    const request = buildInterestSummaryRequest(interests);
    expect(request).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
      instructions: INTEREST_SUMMARY_INSTRUCTIONS,
      input: JSON.stringify(interests),
      max_output_tokens: INTEREST_SUMMARY_MAX_OUTPUT_TOKENS,
      tools: [],
      store: false,
    });
    expect(request.text.format.schema).toMatchObject({
      type: "object",
      required: ["summary", "topics"],
      additionalProperties: false,
    });
  });

  it("requires a completed valid summary and drops only invalid topics", () => {
    expect(
      parseInterestSummaryPayload(
        modelPayload("Technology and science.", ["Tech", "", "x".repeat(41)]),
      ),
    ).toEqual({
      status: "completed",
      summary: { summary: "Technology and science.", topics: ["Tech"] },
    });
    for (const payload of [
      { ...modelPayload(), status: "incomplete" },
      { status: "completed", error: null, output: [] },
      modelPayload("", []),
      modelPayload("x".repeat(401), []),
      modelPayload("No punctuation", []),
      modelPayload("Valid.", "not-an-array"),
    ]) {
      expect(parseInterestSummaryPayload(payload).status).toBe("rejected");
    }
  });
});

describe("summarizeInterestsForUser", () => {
  it("makes no reservation or fetch without verified claims or three positive signals", async () => {
    for (const client of [
      harness({ userId: null }),
      harness({
        liked: [{ item: { title: "One" } }],
        preferences: [{ direction: "more", label: "Two" }],
      }),
    ]) {
      const result = await summarizeInterestsForUser({
        userClient: client.userClient,
        createServiceClient: () => client.serviceClient,
        apiKey: "key",
        fetchImpl: client.fetchImpl as typeof fetch,
      });
      expect(result.ok).toBe(false);
      expect(client.userClient.rpc).not.toHaveBeenCalled();
      expect(client.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("checks the separate quota before fetching", async () => {
    for (const reserve of [false, null, "error"] as const) {
      const client = harness({ reserve, usageCount: 10 });
      const result = await summarizeInterestsForUser({
        userClient: client.userClient,
        createServiceClient: () => client.serviceClient,
        apiKey: "key",
        fetchImpl: client.fetchImpl as typeof fetch,
      });
      expect(result).toMatchObject({ ok: false, error: "limit", remaining: 0 });
      expect(client.userClient.rpc).toHaveBeenCalledExactlyOnceWith("reserve_llm_call", {
        p_kind: "interest_summary",
      });
      expect(client.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("sends only trimmed and bounded positive, negative, more, and less inputs", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const client = harness({
      liked: [{ item: [{ title: `  ${"L".repeat(250)}  ` }] }, { item: { title: " Two " } }],
      disliked: [{ item: { title: " Avoid this " } }],
      preferences: [
        { label: "More", direction: "more" },
        { label: "Less", direction: "less" },
        { label: "Ignored", direction: "other" },
        { label: secretInput, direction: "less" },
      ],
    });
    await summarizeInterestsForUser({
      userClient: client.userClient,
      createServiceClient: () => client.serviceClient,
      apiKey: "test-key",
      fetchImpl: client.fetchImpl as typeof fetch,
    });
    const body = JSON.parse(String(client.fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.input).toBe(
      JSON.stringify({
        liked: ["L".repeat(200), "Two"],
        not_interested: ["Avoid this"],
        more: ["More"],
        less: ["Less", secretInput],
      }),
    );
    expect(body.instructions).toBe(INTEREST_SUMMARY_INSTRUCTIONS);
    expect(Object.keys(JSON.parse(body.input)).sort()).toEqual([
      "less",
      "liked",
      "more",
      "not_interested",
    ]);
    expect(timeout).toHaveBeenCalledWith(INTEREST_SUMMARY_TIMEOUT_MS);
    expect(client.selections.filter((entry) => entry.table === "feedback")).toEqual([
      expect.objectContaining({ limit: 50 }),
      expect.objectContaining({ limit: 20 }),
    ]);
  });

  it("keeps the previous row on model failures and saves no status-derived details", async () => {
    for (const response of [
      jsonResponse({ ...modelPayload(), status: "incomplete" }),
      jsonResponse({ status: "completed", output: [{ content: secretOutput }] }),
      jsonResponse(modelPayload("", [])),
      jsonResponse({ error: { message: secretOutput } }, 500),
    ]) {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = harness({ model: () => response });
      const result = await summarizeInterestsForUser({
        userClient: client.userClient,
        createServiceClient: () => client.serviceClient,
        apiKey: secretInput,
        fetchImpl: client.fetchImpl as typeof fetch,
      });
      expect(result.ok).toBe(false);
      expect(client.saved).toEqual([]);
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).not.toContain(secretInput);
      expect(logged).not.toContain(secretOutput);
      log.mockRestore();
    }
  });

  it("saves valid topics with the verified owner, like count, and generation time", async () => {
    const client = harness({
      liked: [{ item: { title: "One" } }, { item: { title: "Two" } }, { item: { title: "Three" } }],
      disliked: [{ item: { title: "Negative" } }],
      model: () =>
        jsonResponse(
          modelPayload("Technology and science.", ["Tech", "", "x".repeat(41), "Science"]),
        ),
    });
    const result = await summarizeInterestsForUser({
      userClient: client.userClient,
      createServiceClient: () => client.serviceClient,
      apiKey: "key",
      fetchImpl: client.fetchImpl as typeof fetch,
    });
    expect(result).toMatchObject({
      ok: true,
      summary: "Technology and science.",
      topics: ["Tech", "Science"],
      likeCount: 3,
      remaining: 9,
    });
    expect(client.saved).toEqual([
      {
        user_id: "user-a",
        summary: "Technology and science.",
        topics: ["Tech", "Science"],
        like_count: 3,
        generated_at: expect.any(String),
      },
    ]);
  });
});

describe("clearInterestSummaryForUser", () => {
  it("verifies claims and deletes only the caller row through the user client", async () => {
    const unauthenticated = harness({ userId: null });
    expect(
      await clearInterestSummaryForUser({ userClient: unauthenticated.userClient }),
    ).toMatchObject({ ok: false, error: "unauthenticated" });
    expect(unauthenticated.userClient.from).not.toHaveBeenCalled();

    const client = harness();
    expect(await clearInterestSummaryForUser({ userClient: client.userClient })).toEqual({
      ok: true,
    });
    expect(client.userClient.from).toHaveBeenCalledExactlyOnceWith("interest_summaries");
    expect(client.deleted).toEqual(["user-a"]);
  });
});
