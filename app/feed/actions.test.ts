import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMoreFeed } from "./actions";

const { auth, createClient, rpc } = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  createClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("../../lib/supabase/server", () => ({ createClient }));

const validId = "123e4567-e89b-42d3-a456-426614174000";

beforeEach(() => {
  vi.resetAllMocks();
  createClient.mockResolvedValue({ auth, rpc });
  auth.getClaims.mockResolvedValue({
    data: { claims: { sub: "user-a" } },
    error: null,
  });
  rpc.mockResolvedValue({ data: [], error: null });
});

describe("loadMoreFeed", () => {
  it("rejects malformed or oversized exclusion lists", async () => {
    await expect(loadMoreFeed(["not-a-uuid"])).rejects.toThrow("Invalid feed exclusions.");
    await expect(loadMoreFeed(new Array<string>(1001).fill(validId))).rejects.toThrow(
      "Invalid feed exclusions.",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    {
      data: { claims: { sub: "user-a" } },
      error: new Error("Invalid signature"),
    },
  ])("rejects missing or unverified identity before querying", async (result) => {
    auth.getClaims.mockResolvedValueOnce(result);
    await expect(loadMoreFeed([validId])).rejects.toThrow("Authentication required.");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requests the next page using exclusion IDs and the remaining item cap", async () => {
    const excludeIds = [validId, "223e4567-e89b-42d3-a456-426614174000"];
    await loadMoreFeed(excludeIds);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_feed", {
      p_limit: 30,
      p_exclude: excludeIds,
    });

    rpc.mockClear();
    await loadMoreFeed(new Array<string>(990).fill(validId));
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_feed", {
      p_limit: 10,
      p_exclude: new Array<string>(990).fill(validId),
    });
  });

  it("stops at 1,000 shown items without another RPC", async () => {
    await expect(loadMoreFeed(new Array<string>(1000).fill(validId))).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not expose database error details", async () => {
    rpc.mockResolvedValueOnce({ error: new Error("internal database detail") });
    await expect(loadMoreFeed([validId])).rejects.toThrow("Could not load more feed items.");
  });
});
