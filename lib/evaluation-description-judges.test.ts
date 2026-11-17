import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDescriptionJudgeRequest,
  callDescriptionJudge,
  DESCRIPTION_JUDGE_MODELS,
  type DescriptionJudgeCacheRow,
  parseDescriptionJudgeCache,
  parseDescriptionJudgeResponse,
  runDescriptionJudges,
} from "./evaluation-description-judges.ts";
import {
  createDescriptionSample,
  type DescriptionSampleItem,
  descriptionBlindCsv,
} from "./evaluation-description-quality.ts";
import { hashSnapshotRow, sha256 } from "./evaluation-snapshot.ts";
import { descriptionJudgingConfig, setJudgingAnswer } from "./manual-judging.ts";

const item: DescriptionSampleItem = {
  id: "item-1",
  source_id: "source-1",
  title: "Suomen sähköntuotanto kasvoi",
  summary: "Tuulivoiman tuotanto kasvoi Suomessa viime vuonna.",
  language: "fi",
  summary_origin: "feed",
  type: "article",
  url: "https://example.com/story",
};

function jevResponse() {
  return {
    model: "jev-1.14.0",
    answers: {
      usefulness: {
        type: "score",
        score: 1.7,
        confidence: 0.75,
        probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
        legend: { "0": "unusable", "1": "weak", "2": "good" },
      },
      about_publisher: { type: "noul", noul: 0.1 },
      promotional: { type: "noul", noul: 0.2 },
      describes_page: { type: "noul", noul: 0.3 },
    },
    usage: { input_tokens: 1000, output_tokens: 20 },
  };
}
function llmResponse() {
  return {
    model: "gpt-6-luna",
    status: "completed",
    output: [
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: '{"quality":"weak"}' }],
      },
    ],
    usage: { input_tokens: 500, output_tokens: 10 },
  };
}

describe("description judge clients", () => {
  it("sends the pinned Jev rubric and minimal state and validates score and diagnostic probabilities", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(jevResponse()));
    const result = await callDescriptionJudge("jev", item, "secret-key", { fetch: fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual(buildDescriptionJudgeRequest("jev", item));
    expect(body.state).toEqual({
      title: item.title,
      description: item.summary,
      language: "Finnish",
      content_type: "news article",
    });
    expect(body.model).toBe("jev-1.14.0");
    expect(body.questions.usefulness.criteria).toHaveLength(3);
    expect(Object.keys(body.questions)).toEqual([
      "usefulness",
      "about_publisher",
      "promotional",
      "describes_page",
    ]);
    expect(result).toMatchObject({
      status: "ok",
      resolvedModel: "jev-1.14.0",
      inputTokens: 1000,
      outputTokens: 20,
      estimatedCostUsd: 0.000042,
      retries: 0,
      judgment: {
        kind: "jev",
        score: 1.7,
        confidence: 0.75,
        probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
        nouls: { about_publisher: 0.1, promotional: 0.2, describes_page: 0.3 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(JSON.stringify(result)).not.toContain(item.summary);
  });

  it("requests strict Responses API output with no tools or storage and the shared rubric", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(llmResponse()));
    const result = await callDescriptionJudge(
      "llm",
      { ...item, language: "en", type: "video" },
      "key",
      { fetch: fetchImpl },
    );
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
      tools: [],
      store: false,
      text: {
        format: {
          type: "json_schema",
          strict: true,
          name: "description_quality",
          schema: {
            type: "object",
            properties: { quality: { type: "string", enum: ["good", "weak", "unusable"] } },
            required: ["quality"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(body.instructions).toContain("untrusted content");
    expect(body.instructions).toContain("Says nothing specific about this item");
    expect(JSON.parse(body.input)).toMatchObject({ language: "English", content_type: "video" });
    expect(result).toMatchObject({
      status: "ok",
      estimatedCostUsd: 0.000055,
      judgment: { kind: "llm", quality: "weak" },
    });
  });

  it.each(["", "  \n", "[...]", "NONE"])(
    "never sends deterministic input %j to either service",
    async (summary) => {
      const fetchImpl = vi.fn<typeof fetch>();
      for (const classifier of ["jev", "llm"] as const) {
        expect(
          await callDescriptionJudge(classifier, { ...item, summary }, "", { fetch: fetchImpl }),
        ).toMatchObject({ status: "deterministic", attempts: [], retries: 0 });
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(["jev", "llm"] as const)(
    "records HTTP 422 without exposing echoed input or credentials for %s",
    async (classifier) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(`private-key ${item.summary}`, { status: 422 }));
      const result = await callDescriptionJudge(classifier, item, "private-key", {
        fetch: fetchImpl,
      });
      expect(result).toMatchObject({
        status: "error",
        error: "http",
        attempts: [{ status: 422, error: "http" }],
        retries: 0,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("private-key");
      expect(JSON.stringify(result)).not.toContain(item.summary);
    },
  );

  it("rejects malformed, incomplete, out-of-range, or inconsistent Jev responses", () => {
    const valid = jevResponse();
    const cases: unknown[] = [
      null,
      {},
      { ...valid, model: "" },
      { ...valid, usage: { input_tokens: -1, output_tokens: 0 } },
      { ...valid, answers: { ...valid.answers, about_publisher: { type: "noul", noul: 1.1 } } },
      {
        ...valid,
        answers: { ...valid.answers, usefulness: { ...valid.answers.usefulness, confidence: 2 } },
      },
      {
        ...valid,
        answers: { ...valid.answers, usefulness: { ...valid.answers.usefulness, score: 0 } },
      },
      {
        ...valid,
        answers: {
          ...valid.answers,
          usefulness: { ...valid.answers.usefulness, probabilities: { "0": 0, "1": 0, "2": 0 } },
        },
      },
      {
        ...valid,
        answers: { ...valid.answers, usefulness: { ...valid.answers.usefulness, legend: {} } },
      },
    ];
    for (const payload of cases)
      expect(() => parseDescriptionJudgeResponse("jev", payload)).toThrow();
  });

  it("rejects invalid labels, missing output, refusals, incomplete responses, and unexpected tools", () => {
    const valid = llmResponse();
    const cases: unknown[] = [
      { ...valid, status: "incomplete" },
      { ...valid, output: [] },
      { ...valid, error: { message: "failed" } },
      { ...valid, output: [{ type: "function_call" }] },
      { ...valid, output: [{ type: "message", status: "incomplete", content: [] }] },
      ...["{}", '{"quality":"bad"}', '{"quality":"good","extra":true}', "not json"].map((text) => ({
        ...valid,
        output: [
          { type: "message", status: "completed", content: [{ type: "output_text", text }] },
        ],
      })),
      {
        ...valid,
        output: [
          { type: "message", status: "completed", content: [{ type: "refusal", refusal: "no" }] },
        ],
      },
    ];
    for (const payload of cases)
      expect(() => parseDescriptionJudgeResponse("llm", payload)).toThrow();
  });

  it.each(["jev", "llm"] as const)(
    "records non-JSON and oversized successful bodies as errors for %s",
    async (classifier) => {
      for (const response of [
        new Response("not JSON"),
        new Response("x".repeat(64_001)),
        new Response("x", { headers: { "content-length": "64001" } }),
      ]) {
        const result = await callDescriptionJudge(classifier, item, "key", {
          fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
        });
        expect(result).toMatchObject({ status: "error", error: "invalid_response", retries: 0 });
      }
    },
  );

  it("records missing LLM labels as errors instead of accepting an empty judgment", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...llmResponse(),
        output: [
          { type: "message", status: "completed", content: [{ type: "output_text", text: "{}" }] },
        ],
      }),
    );
    expect(await callDescriptionJudge("llm", item, "key", { fetch: fetchImpl })).toMatchObject({
      status: "error",
      error: "invalid_response",
      retries: 0,
    });
  });

  it.each(["jev", "llm"] as const)(
    "retries 429 and 529 with Retry-After and records first-attempt latency for %s",
    async (classifier) => {
      let time = 0;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
        time += 20;
        if (fetchImpl.mock.calls.length === 1)
          return new Response("", { status: 429, headers: { "retry-after": "1" } });
        if (fetchImpl.mock.calls.length === 2) return new Response("", { status: 529 });
        return Response.json(classifier === "jev" ? jevResponse() : llmResponse());
      });
      const sleep = vi.fn(async (ms: number) => {
        time += ms;
      });
      const result = await callDescriptionJudge(classifier, item, "key", {
        fetch: fetchImpl,
        sleep,
        now: () => time,
      });
      expect(result).toMatchObject({ status: "ok", retries: 2 });
      expect(result.attempts.map((attempt) => attempt.status)).toEqual([429, 529, 200]);
      expect(result.attempts.map((attempt) => attempt.latencyMs)).toEqual([20, 20, 20]);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000]);
    },
  );

  it("honours HTTP-date Retry-After and stops instead of retrying early on a long wait", async () => {
    const now = Date.parse("2026-11-17T15:00:00Z");
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("", {
          status: 429,
          headers: { "retry-after": new Date(now + 2000).toUTCString() },
        }),
      )
      .mockResolvedValueOnce(Response.json(jevResponse()));
    await callDescriptionJudge("jev", item, "key", { fetch: fetchImpl, sleep, now: () => now });
    expect(sleep).toHaveBeenCalledWith(2000);
    fetchImpl
      .mockReset()
      .mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "60" } }));
    sleep.mockClear();
    expect(
      await callDescriptionJudge("jev", item, "key", { fetch: fetchImpl, sleep }),
    ).toMatchObject({ status: "error", error: "http", retries: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds retries and sanitizes network exception messages", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`private-key ${item.summary}`));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const result = await callDescriptionJudge("jev", item, "private-key", {
      fetch: fetchImpl,
      sleep,
    });
    expect(result).toMatchObject({ status: "error", error: "network", retries: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
    expect(JSON.stringify(result)).not.toContain("private-key");
    expect(JSON.stringify(result)).not.toContain(item.summary);
  });

  it("enforces deadlines even if fetch or the response body stalls", async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
      vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream())),
    ]) {
      const result = await callDescriptionJudge("jev", item, "key", {
        fetch: fetchImpl,
        timeoutMs: 5,
        sleep: async () => {},
      });
      expect(result).toMatchObject({ status: "error", error: "timeout", retries: 2 });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(fetchImpl.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    }
  });
});

describe("description judge cache", () => {
  beforeEach(() => {
    vi.stubEnv("CI", "false");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resumes cached rows, keys changed text and runs separately, and routes placeholders without calls", async () => {
    const cache: DescriptionJudgeCacheRow[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(String(url).includes("typesafe") ? jevResponse() : llmResponse()),
      );
    const input = {
      items: [item, { ...item, id: "placeholder", summary: "None" }],
      classifiers: ["jev", "llm"] as const,
      run: 1,
      keys: { jev: "key", llm: "key" },
      cache,
      append: async (row: DescriptionJudgeCacheRow) => {
        cache.push(row);
      },
      options: { fetch: fetchImpl },
    };
    expect(await runDescriptionJudges(input)).toEqual({
      called: 2,
      deterministic: 2,
      cached: 0,
      errors: 0,
    });
    expect(
      parseDescriptionJudgeCache(`${cache.map((row) => JSON.stringify(row)).join("\n")}\n`),
    ).toEqual(cache);
    expect(await runDescriptionJudges({ ...input, keys: {} })).toEqual({
      called: 0,
      deterministic: 0,
      cached: 4,
      errors: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await runDescriptionJudges({
      ...input,
      items: [{ ...item, summary: `${item.summary} changed` }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await runDescriptionJudges({ ...input, run: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    const row = cache[0];
    expect(() =>
      parseDescriptionJudgeCache(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`),
    ).toThrow(/duplicate/u);
    expect(() =>
      parseDescriptionJudgeCache(JSON.stringify({ ...row, model: "other-model" })),
    ).toThrow(/Invalid/u);
    expect(() =>
      parseDescriptionJudgeCache(JSON.stringify({ ...row, result: { status: "ok" } })),
    ).toThrow(/Invalid/u);
    expect(() => parseDescriptionJudgeCache("{")).toThrow(/invalid JSON/u);
  });

  it("records failures without retrying cached errors silently and does not cache append failures", async () => {
    const cache: DescriptionJudgeCacheRow[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret", { status: 422 }));
    const input = {
      items: [item],
      classifiers: ["jev"] as const,
      run: 1,
      keys: { jev: "key" },
      cache,
      append: async (row: DescriptionJudgeCacheRow) => {
        cache.push(row);
      },
      options: { fetch: fetchImpl },
    };
    expect(await runDescriptionJudges(input)).toMatchObject({ called: 1, errors: 1 });
    expect(await runDescriptionJudges(input)).toMatchObject({ cached: 1, errors: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parseDescriptionJudgeCache(JSON.stringify(cache[0]))).toEqual(cache);
    await expect(
      runDescriptionJudges({
        ...input,
        items: [{ ...item, summary: "None" }],
        cache: [],
        append: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
  });

  it("preflights all needed keys before making any calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      runDescriptionJudges({
        items: [item],
        classifiers: ["jev", "llm"],
        run: 1,
        keys: { jev: "key" },
        cache: [],
        append: async () => {},
        options: { fetch: fetchImpl },
      }),
    ).rejects.toThrow("Missing OPENAI_API_KEY");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("description judge command", () => {
  it("blocks CI and premature test runs before accessing files or keys", () => {
    for (const [args, ci, message] of [
      [["run", "--set", "dev"], "true", "must not run in CI"],
      [["run", "--set", "test"], "false", "Only --set dev"],
      [["run", "--set", "dev", "--run", "0"], "false", "positive safe integer"],
    ] as const) {
      const result = spawnSync(process.execPath, ["scripts/description-quality.mts", ...args], {
        env: { ...process.env, CI: ci },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });

  it("runs a fake dev experiment, resumes it, protects labels, and locks concurrent cache access", () => {
    const directory = mkdtempSync(resolve("test/.description-judges-"));
    try {
      const snapshot = resolve(directory, "snapshot");
      const output = resolve(directory, "output");
      mkdirSync(snapshot);
      mkdirSync(output);
      const items = Array.from({ length: 40 }, (_, index) => ({
        ...item,
        id: `item-${index}`,
        summary: `Unique description ${index}`,
      }));
      const rows = items.map((entry) => ({ ...entry, enrichment_status: "completed" }));
      const manifestText = JSON.stringify({
        schemaVersion: 1,
        provisional: false,
        itemIds: rows.map((row) => row.id),
        itemRowHashes: Object.fromEntries(rows.map((row) => [row.id, hashSnapshotRow(row)])),
      });
      const sample = createDescriptionSample({
        items,
        snapshotManifestHash: sha256(manifestText),
        seed: 1,
        testSize: 8,
      });
      const ids = new Set([...sample.sets.dev, ...sample.sets.test].map((entry) => entry.itemId));
      writeFileSync(resolve(snapshot, "manifest.json"), manifestText);
      writeFileSync(
        resolve(snapshot, "items.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n"),
      );
      writeFileSync(resolve(output, "sample.json"), JSON.stringify(sample));
      writeFileSync(
        resolve(output, "items.jsonl"),
        items
          .filter((entry) => ids.has(entry.id))
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      let labels = descriptionBlindCsv(sample.sets.dev, items);
      for (let index = 0; index < 30; index += 1) {
        labels = setJudgingAnswer(labels, index, "quality", "good", descriptionJudgingConfig);
        labels = setJudgingAnswer(labels, index, "reason", "none", descriptionJudgingConfig);
      }
      writeFileSync(resolve(output, "labels-dev.csv"), labels);
      const fake = `globalThis.fetch = async (url) => Response.json(String(url).includes("typesafe") ? ${JSON.stringify(jevResponse())} : ${JSON.stringify(llmResponse())});`;
      const run = (script = fake) =>
        spawnSync(
          process.execPath,
          [
            "--import",
            `data:text/javascript,${encodeURIComponent(script)}`,
            "scripts/description-quality.mts",
            "run",
            "--set",
            "dev",
            "--snapshot",
            snapshot,
            "--output",
            output,
          ],
          {
            env: {
              ...process.env,
              CI: "false",
              TYPESAFE_API_KEY: "fake-key",
              OPENAI_API_KEY: "fake-key",
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
      const first = run();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('"called":60');
      expect(first.stdout).not.toContain(item.title);
      expect(first.stdout).not.toContain("fake-key");
      const cache = readFileSync(resolve(output, "judge-cache.jsonl"), "utf8");
      expect(parseDescriptionJudgeCache(cache)).toHaveLength(60);
      expect(
        parseDescriptionJudgeCache(cache).every(
          (row) => row.model === DESCRIPTION_JUDGE_MODELS[row.classifier],
        ),
      ).toBe(true);
      const resumed = run('globalThis.fetch = () => { throw new Error("Unexpected call"); };');
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain('"cached":60');
      expect(readFileSync(resolve(output, "judge-cache.jsonl"), "utf8")).toBe(cache);
      writeFileSync(resolve(output, ".judge-cache.lock"), "");
      expect(run().status).toBe(1);
      rmSync(resolve(output, ".judge-cache.lock"));
      writeFileSync(resolve(output, "labels-dev.csv"), labels.replace('"good"', '""'));
      expect(run().stderr).toContain("Dev labels are incomplete");
      expect(readFileSync(resolve(output, "judge-cache.jsonl"), "utf8")).toBe(cache);
      writeFileSync(resolve(output, "labels-dev.csv"), labels);
      const frozen = readFileSync(resolve(output, "items.jsonl"), "utf8");
      writeFileSync(
        resolve(output, "items.jsonl"),
        frozen.replace('"language":"fi"', '"language":"en"'),
      );
      expect(run().stderr).toContain("metadata mismatch");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
