import { describe, expect, it } from "vitest";
import { readPages } from "./source-discovery-scan.ts";

describe("source discovery database pagination", () => {
  it("reads every row beyond the PostgREST 1,000-row page limit", async () => {
    const calls: Array<[number, number]> = [];
    const rows = await readPages(async (from, to) => {
      calls.push([from, to]);
      return {
        data: Array.from({ length: Math.min(1_001 - from, to - from + 1) }, (_, index) => ({
          id: from + index,
        })),
        error: null,
      };
    }, "fixture rows");

    expect(rows).toHaveLength(1_001);
    expect(rows[0]?.id).toBe(0);
    expect(rows[1_000]?.id).toBe(1_000);
    expect(calls).toEqual([
      [0, 999],
      [1_000, 1_999],
    ]);
  });
});
