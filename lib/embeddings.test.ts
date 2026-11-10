import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { UnembeddedItem } from "./db";
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_VERSION,
  embedPendingItems,
} from "./embeddings";

class FakeEmbeddingDb {
  embeddings = new Map<string, { vector: number[]; model: string }>();

  constructor(readonly items: UnembeddedItem[]) {}

  async listUnembeddedItems(): Promise<UnembeddedItem[]> {
    return this.items.filter((item) => !this.embeddings.has(item.id));
  }

  async saveEmbedding(id: string, vector: number[], model: string): Promise<boolean> {
    if (this.embeddings.has(id)) return false;
    this.embeddings.set(id, { vector, model });
    return true;
  }
}

function vectors(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    embedding: Array<number>(EMBEDDING_DIMENSIONS).fill(index),
  }));
}

function captureEmbeddingInputs(requests: string[][]): typeof fetch {
  return async (_input, init) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    requests.push(input);
    return Response.json({ data: vectors(input.length) });
  };
}

describe("embedPendingItems", () => {
  it("sends ordered text in batches of at most 100 with the required model and dimensions", async () => {
    const items = [
      {
        id: "1",
        title: "  Yle kertoo säästä  ",
        summary: " \tSää lämpenee huomenna.\n ",
        summaryOrigin: "feed" as const,
      },
      {
        id: "2",
        title: "Title two",
        summary: "Summary two",
        summaryOrigin: "feed" as const,
      },
      {
        id: "3",
        title: "Title three",
        summary: "Summary three",
        summaryOrigin: "feed" as const,
      },
    ];
    const db = new FakeEmbeddingDb(items);
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        dimensions: number;
        input: string[];
      };
      requests.push(request);
      return new Response(
        JSON.stringify({
          data: vectors(request.input.length).reverse(),
        }),
        { status: 200 },
      );
    };

    const result = await embedPendingItems(db, "test-key", {
      fetch: fetchImpl,
    });

    expect(result).toEqual({ embedded: 3, failedBatches: [] });
    expect(requests).toEqual([
      {
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input: [
          "  Yle kertoo säästä  \n\nSää lämpenee huomenna.",
          "Title two\n\nSummary two",
          "Title three\n\nSummary three",
        ],
      },
    ]);
    expect(db.embeddings.get("1")?.vector[0]).toBe(0);
    expect(db.embeddings.get("2")?.vector[0]).toBe(1);
    expect(db.embeddings.get("3")?.vector[0]).toBe(2);
    expect(db.embeddings.get("1")?.model).toBe(EMBEDDING_MODEL_VERSION);
  });

  it.each([
    { character: "ä", bytes: 2 },
    { character: "界", bytes: 3 },
    { character: "😀", bytes: 4 },
  ])("keeps $character whole at both byte caps", async ({ character, bytes }) => {
    const exactTitle = "t".repeat(512 - bytes) + character;
    const exactSummary = "s".repeat(2_400 - bytes) + character;
    const shortTitle = "t".repeat(512 - bytes + 1);
    const shortSummary = "s".repeat(2_400 - bytes + 1);
    const db = new FakeEmbeddingDb([
      { id: "exact", title: exactTitle, summary: exactSummary, summaryOrigin: "feed" },
      {
        id: "crossing",
        title: `${shortTitle}${character}t`,
        summary: `${shortSummary}${character}s`,
        summaryOrigin: "feed",
      },
    ]);
    const requests: string[][] = [];

    expect(
      await embedPendingItems(db, "test-key", { fetch: captureEmbeddingInputs(requests) }),
    ).toEqual({ embedded: 2, failedBatches: [] });
    expect(requests).toEqual([
      [`${exactTitle}\n\n${exactSummary}`, `${shortTitle}\n\n${shortSummary}`],
    ]);
  });

  it("caps both fields independently in a full batch", async () => {
    const title = "😀".repeat(5_000);
    const summary = `  ${"界".repeat(1_000)}  `;
    const db = new FakeEmbeddingDb(
      Array.from({ length: 100 }, (_, index) => ({
        id: `item-${index}`,
        title,
        summary,
        summaryOrigin: "feed",
      })),
    );
    const requests: string[][] = [];

    expect(
      await embedPendingItems(db, "test-key", { fetch: captureEmbeddingInputs(requests) }),
    ).toEqual({ embedded: 100, failedBatches: [] });
    expect(requests).toHaveLength(1);
    const inputs = requests.flat();
    expect(inputs).toHaveLength(100);
    const expectedInput = `${"😀".repeat(128)}\n\n${"界".repeat(800)}`;
    expect(inputs.every((input) => input === expectedInput)).toBe(true);
    expect(inputs.reduce((bytes, input) => bytes + Buffer.byteLength(input, "utf8"), 0)).toBe(
      291_400,
    );
  });

  it("embeds a stored oversized item with its neighbors and skips them on rerun", async () => {
    const title = "t".repeat(20_000);
    const summary = "  Stored summary  ";
    const stored = { id: "stored", title, summary, summaryOrigin: "feed" as const };
    const db = new FakeEmbeddingDb([
      { id: "first", title: "First", summary: "First summary", summaryOrigin: "feed" },
      stored,
      { id: "last", title: "Last", summary: "Last summary", summaryOrigin: "feed" },
    ]);
    const requests: string[][] = [];
    const options = { fetch: captureEmbeddingInputs(requests) };

    expect(await embedPendingItems(db, "test-key", options)).toEqual({
      embedded: 3,
      failedBatches: [],
    });
    expect(stored).toMatchObject({ title, summary });
    expect(await embedPendingItems(db, "test-key", options)).toEqual({
      embedded: 0,
      failedBatches: [],
    });
    expect(requests).toEqual([
      ["First\n\nFirst summary", `${"t".repeat(512)}\n\nStored summary`, "Last\n\nLast summary"],
    ]);
  });

  it("leaves a failed batch pending and retries it on the next run", async () => {
    const items = Array.from({ length: EMBEDDING_BATCH_SIZE + 1 }, (_, index) => ({
      id: `item-${index}`,
      title: `Title ${index}`,
      summary: `Summary ${index}`,
      summaryOrigin: "feed" as const,
    }));
    const db = new FakeEmbeddingDb(items);
    let requestCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestCount++;
      const request = JSON.parse(String(init?.body)) as { input: string[] };
      if (requestCount === 1) {
        return new Response(JSON.stringify({ error: { message: "temporary failure" } }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ data: vectors(request.input.length) }), {
        status: 200,
      });
    };

    const firstRun = await embedPendingItems(db, "test-key", {
      fetch: fetchImpl,
    });
    expect(firstRun.embedded).toBe(1);
    expect(firstRun.failedBatches).toEqual([
      {
        itemIds: items.slice(0, EMBEDDING_BATCH_SIZE).map((item) => item.id),
        error: "temporary failure",
      },
    ]);
    expect((await db.listUnembeddedItems()).map((item) => item.id)).toEqual(
      items.slice(0, EMBEDDING_BATCH_SIZE).map((item) => item.id),
    );

    const retryRun = await embedPendingItems(db, "test-key", {
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { input: string[] };
        return new Response(JSON.stringify({ data: vectors(request.input.length) }), {
          status: 200,
        });
      },
    });

    expect(retryRun).toEqual({
      embedded: EMBEDDING_BATCH_SIZE,
      failedBatches: [],
    });
    expect(await db.listUnembeddedItems()).toEqual([]);
  });

  it("never embeds items with missing or whitespace-only summaries", async () => {
    const db = new FakeEmbeddingDb([
      {
        id: "missing",
        title: "Title only",
        summary: null,
        summaryOrigin: null,
      },
      {
        id: "blank",
        title: "Blank description",
        summary: "  ",
        summaryOrigin: "feed",
      },
    ]);
    let requestCount = 0;

    const result = await embedPendingItems(db, "test-key", {
      fetch: async () => {
        requestCount++;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });

    expect(result).toEqual({ embedded: 0, failedBatches: [] });
    expect(requestCount).toBe(0);
    expect(db.embeddings.size).toBe(0);
  });

  it("embeds only selected recovery IDs within the configured limit", async () => {
    const db = new FakeEmbeddingDb([
      {
        id: "first",
        title: "First title",
        summary: "First summary",
        summaryOrigin: "feed",
      },
      {
        id: "second",
        title: "Second title",
        summary: "Second summary",
        summaryOrigin: "ai_generated",
      },
    ]);
    let requestBody = "";

    const result = await embedPendingItems(db, "test-key", {
      itemIds: ["second"],
      limit: 1,
      fetch: async (_input, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ data: vectors(1) }), {
          status: 200,
        });
      },
    });

    expect(result.embedded).toBe(1);
    expect(requestBody).toContain("Second title\\n\\nSecond summary");
    expect(db.embeddings.has("first")).toBe(false);
    expect(db.embeddings.has("second")).toBe(true);
  });
});
