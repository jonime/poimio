import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_MODEL_VERSION } from "./embeddings.ts";
import {
  buildPreferenceTuningRequest,
  deletePreferenceForUser,
  flipPreferenceForUser,
  PREFERENCE_LIMIT_MESSAGE,
  PREFERENCE_MODEL,
  PREFERENCE_MODEL_MAX_OUTPUT_TOKENS,
  PREFERENCE_MODEL_TIMEOUT_MS,
  type PreferenceServiceClient,
  type PreferenceUserClient,
  parsePreferenceModelPayload,
  parsePreferenceRequestFile,
  tunePreferencesForUser,
} from "./preference-tuning.ts";

const preferenceId = "11111111-1111-4111-8111-111111111111";
const secretRequest = "SECRET_REQUEST_TEXT";
const secretOutput = "SECRET_MODEL_OUTPUT";

function validItem(label = "Cars", direction: "more" | "less" = "more") {
  return {
    label,
    direction,
    description_fi: "Autot ja ajoneuvotekniikka.",
    description_en: "Cars and vehicle technology.",
  };
}

function modelPayload(preferences: unknown, status = "completed") {
  return {
    status,
    error: null,
    output: [
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify({ preferences }) }],
      },
    ],
  };
}

function vector(value: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function embeddingBody(count: number, values?: number[][]) {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: values?.[index] ?? vector(index + 1),
    })),
  };
}

interface Harness {
  userClient: PreferenceUserClient;
  createServiceClient: () => PreferenceServiceClient;
  fetchImpl: ReturnType<typeof vi.fn>;
  inserted: unknown[];
  serviceCalls: number;
  userWrites: string[];
}

function harness(options?: {
  userId?: string | null;
  claimsError?: boolean;
  reserve?: boolean | null | "error";
  usageCount?: number;
  preferenceCount?: number;
  changed?: number | null;
  insertError?: boolean;
  model?: (body: { input?: string }) => Response;
  embed?: (body: { input?: unknown[] }) => Response;
}): Harness {
  const inserted: unknown[] = [];
  const userWrites: string[] = [];
  let serviceCalls = 0;
  const userId = options?.userId === undefined ? "user-a" : options.userId;
  const reserve = options?.reserve === undefined ? true : options.reserve;
  const filter = <T>(result: {
    data: T;
    error: { message: string } | null;
    count: number | null;
  }) => {
    const query = Promise.resolve(result);
    return Object.assign(query, {
      eq: () => filter(result),
      gte: () => filter(result),
      select: () => filter(result),
    });
  };
  const userClient = {
    auth: {
      getClaims: vi.fn(async () => ({
        data: userId === null ? null : { claims: { sub: userId } },
        error: options?.claimsError ? { message: "no session" } : null,
      })),
    },
    rpc: vi.fn(async () => ({
      data: reserve === "error" ? null : reserve,
      error: reserve === "error" ? { message: "database" } : null,
    })),
    from: vi.fn((table: string) => ({
      select: () =>
        filter({
          data: null,
          error: null,
          count:
            table === "llm_usage" ? (options?.usageCount ?? 1) : (options?.preferenceCount ?? 0),
        }),
      update: () => {
        userWrites.push("update");
        return filter({
          data: options?.changed === 0 || options?.changed === null ? [] : [{ id: preferenceId }],
          error: options?.changed === null ? { message: "update failed" } : null,
          count: null,
        });
      },
      delete: () => {
        userWrites.push("delete");
        return filter({
          data: options?.changed === 0 || options?.changed === null ? [] : [{ id: preferenceId }],
          error: options?.changed === null ? { message: "delete failed" } : null,
          count: null,
        });
      },
      insert: () => {
        throw new Error("user client cannot insert preferences");
      },
    })),
  } as unknown as PreferenceUserClient;
  const serviceClient = {
    from: () => ({
      insert: (rows: unknown[]) => ({
        select: async () => {
          inserted.push(...rows);
          return options?.insertError
            ? { data: null, error: { message: "insert failed" }, count: null }
            : {
                data: rows.map((_, index) => ({
                  id: `saved-${index}`,
                  label: "saved",
                  direction: "more" as const,
                })),
                error: null,
                count: null,
              };
        },
      }),
    }),
  } as unknown as PreferenceServiceClient;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input?: string | unknown[] };
    const target = String(url);
    if (target.endsWith("/responses")) {
      return (
        options?.model?.(body as { input?: string }) ?? jsonResponse(modelPayload([validItem()]))
      );
    }
    const inputs = Array.isArray(body.input) ? body.input.length : 0;
    return options?.embed?.(body as { input?: unknown[] }) ?? jsonResponse(embeddingBody(inputs));
  });
  return {
    userClient,
    createServiceClient: () => {
      serviceCalls += 1;
      return serviceClient;
    },
    fetchImpl,
    inserted,
    get serviceCalls() {
      return serviceCalls;
    },
    userWrites,
  };
}

async function tune(text: unknown, options?: Parameters<typeof harness>[0]) {
  const client = harness(options);
  const result = await tunePreferencesForUser({
    text,
    userClient: client.userClient,
    createServiceClient: client.createServiceClient,
    apiKey: "test-key",
    fetchImpl: client.fetchImpl as typeof fetch,
  });
  return { result, client };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preference tuning request", () => {
  it("uses the fixed strict schema and sends only the trimmed user text", () => {
    const request = buildPreferenceTuningRequest("cars");
    expect(request).toMatchObject({
      model: PREFERENCE_MODEL,
      reasoning: { effort: "none" },
      store: false,
      tools: [],
      max_output_tokens: PREFERENCE_MODEL_MAX_OUTPUT_TOKENS,
      input: "cars",
      text: {
        format: {
          type: "json_schema",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["preferences"],
          },
        },
      },
    });
    const item = request.text.format.schema.properties.preferences.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["label", "direction", "description_fi", "description_en"]);
    expect(item.properties.direction.enum).toEqual(["more", "less"]);
    expect(request.text.format.schema.properties.preferences.maxItems).toBe(5);
  });

  it("accepts only a completed object and drops invalid items", () => {
    expect(parsePreferenceModelPayload(modelPayload([validItem(), { label: "x" }]))).toEqual({
      status: "completed",
      preferences: [validItem()],
    });
    expect(parsePreferenceModelPayload(modelPayload([])).preferences).toEqual([]);
    expect(
      parsePreferenceModelPayload({
        status: "incomplete",
        output: modelPayload([validItem()]).output,
      }).status,
    ).toBe("rejected");
    expect(
      parsePreferenceModelPayload({
        status: "completed",
        output: [
          {
            type: "message",
            status: "completed",
            content: [{ type: "refusal", refusal: secretOutput }],
          },
        ],
      }).status,
    ).toBe("rejected");
    expect(parsePreferenceModelPayload(modelPayload("not-json")).status).toBe("rejected");
  });
});

describe("tunePreferencesForUser", () => {
  it("rejects unauthenticated calls and invalid text before any request", async () => {
    const unauthenticated = await tune("cars", { userId: null });
    expect(unauthenticated.result).toMatchObject({ ok: false, error: "unauthenticated" });
    expect(unauthenticated.client.fetchImpl).not.toHaveBeenCalled();
    expect(unauthenticated.client.serviceCalls).toBe(0);
    expect(unauthenticated.client.userClient.rpc).not.toHaveBeenCalled();

    for (const text of ["", "   ", "x".repeat(301), 12, null]) {
      const rejected = await tune(text);
      expect(rejected.result).toMatchObject({ ok: false, error: "invalid_input" });
      expect(rejected.client.fetchImpl).not.toHaveBeenCalled();
      expect(rejected.client.userClient.rpc).not.toHaveBeenCalled();
    }
  });

  it("does not call OpenAI when the reservation fails", async () => {
    for (const reserve of [false, null, "error"] as const) {
      const { result, client } = await tune("cars", { reserve, usageCount: 10 });
      expect(result).toMatchObject({
        ok: false,
        error: "limit",
        message: PREFERENCE_LIMIT_MESSAGE,
        remaining: 0,
      });
      expect(client.fetchImpl).not.toHaveBeenCalled();
      expect(client.inserted).toEqual([]);
    }
  });

  it("saves nothing for refusals, incomplete output, malformed output, or an empty result", async () => {
    const cases = [
      jsonResponse({
        status: "completed",
        output: [
          {
            type: "message",
            status: "completed",
            content: [{ type: "refusal", refusal: secretOutput }],
          },
        ],
      }),
      jsonResponse(modelPayload([validItem()], "incomplete")),
      jsonResponse({
        status: "completed",
        output: [
          { type: "message", status: "completed", content: [{ type: "output_text", text: "{" }] },
        ],
      }),
      jsonResponse(modelPayload([{ label: secretOutput, direction: "up" }])),
      jsonResponse(modelPayload([])),
    ];
    for (const response of cases) {
      const { result, client } = await tune(secretRequest, { model: () => response });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toContain(secretOutput);
      expect(client.inserted).toEqual([]);
      expect(client.fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("drops invalid items, enforces the cap, and saves the caller id with ordered embeddings", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const dropped = await tune("cars", {
      model: () => jsonResponse(modelPayload([validItem("Kept"), { label: "bad" }])),
    });
    expect(dropped.result).toMatchObject({
      ok: true,
      preferences: [{ id: "saved-0", direction: "more" }],
    });
    expect(dropped.client.inserted).toEqual([
      expect.objectContaining({
        user_id: "user-a",
        label: "Kept",
        embedding_model: EMBEDDING_MODEL_VERSION,
        embedding_fi: `[${vector(1).join(",")}]`,
        embedding_en: `[${vector(2).join(",")}]`,
      }),
    ]);
    expect(timeout).toHaveBeenCalledWith(PREFERENCE_MODEL_TIMEOUT_MS);
    timeout.mockRestore();

    const capped = await tune("cars", {
      preferenceCount: 19,
      model: () => jsonResponse(modelPayload([validItem(), validItem("Second")])),
    });
    expect(capped.result).toMatchObject({ ok: false, error: "cap" });
    expect(capped.client.inserted).toEqual([]);
    expect(capped.client.fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends at most 10 embedding inputs and saves nothing when embeddings are unusable", async () => {
    const items = ["One", "Two", "Three", "Four", "Five"].map((label) => validItem(label));
    const full = await tune("cars", { model: () => jsonResponse(modelPayload(items)) });
    const embedCall = full.client.fetchImpl.mock.calls[1];
    const embedBody = JSON.parse(String(embedCall?.[1]?.body)) as {
      model: string;
      dimensions: number;
      input: string[];
    };
    expect(embedBody.model).toBe(EMBEDDING_MODEL);
    expect(embedBody.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(embedBody.input).toHaveLength(10);

    const mismatch = await tune("cars", {
      embed: () => jsonResponse(embeddingBody(1)),
    });
    expect(mismatch.result).toMatchObject({ ok: false, error: "failed" });
    expect(mismatch.client.inserted).toEqual([]);

    const shortVector = await tune("cars", {
      embed: () =>
        jsonResponse({
          data: [
            { index: 0, embedding: [1, 2] },
            { index: 1, embedding: vector(1) },
          ],
        }),
    });
    expect(shortVector.result).toMatchObject({ ok: false, error: "failed" });
    expect(shortVector.client.inserted).toEqual([]);
  });

  it("does not log the request text or model output", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { result } = await tune(secretRequest, {
      model: () => jsonResponse({ error: { message: secretOutput } }, 500),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(secretRequest);
      expect(result.message).not.toContain(secretOutput);
    }
    const logged = [...error.mock.calls, ...log.mock.calls].flat().join(" ");
    expect(logged).not.toContain(secretRequest);
    expect(logged).not.toContain(secretOutput);
    expect(logged).toContain("500");
  });
});

describe("flip and delete", () => {
  it("verify the user and write only through the user client", async () => {
    const unauthenticated = harness({ userId: null });
    expect(
      await flipPreferenceForUser({
        userClient: unauthenticated.userClient,
        preferenceId,
        direction: "less",
      }),
    ).toMatchObject({ ok: false, error: "unauthenticated" });
    expect(unauthenticated.userWrites).toEqual([]);

    const invalid = harness();
    expect(
      await deletePreferenceForUser({
        userClient: invalid.userClient,
        preferenceId: "not-a-uuid",
      }),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(
      await flipPreferenceForUser({
        userClient: invalid.userClient,
        preferenceId,
        direction: "up",
      }),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(invalid.userWrites).toEqual([]);

    const missing = harness({ changed: 0 });
    expect(
      await flipPreferenceForUser({
        userClient: missing.userClient,
        preferenceId,
        direction: "less",
      }),
    ).toMatchObject({ ok: false, error: "not_found", message: "not found" });
    expect(
      await deletePreferenceForUser({ userClient: missing.userClient, preferenceId }),
    ).toMatchObject({ ok: false, error: "not_found", message: "not found" });
    expect(missing.userWrites).toEqual(["update", "delete"]);
    expect(missing.serviceCalls).toBe(0);
  });
});

describe("preference request file", () => {
  it("requires the 12 committed review requests", async () => {
    const file = JSON.parse(await readFile("evaluation/preference-requests.json", "utf8"));
    const requests = parsePreferenceRequestFile(file);
    expect(requests).toHaveLength(12);
    expect(requests.filter((request) => request.language === "fi")).toHaveLength(6);
    expect(requests.filter((request) => request.kind === "negation")).toHaveLength(2);
  });
});
