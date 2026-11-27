import { beforeEach, expect, it, vi } from "vitest";
import { loadMoreHistory } from "./actions";

const { auth, createClient, rpc } = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  createClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

const id = "11111111-1111-4111-8111-111111111111";
const beforeAt = "2026-11-27T12:00:00.123456+00:00";

beforeEach(() => {
  vi.resetAllMocks();
  createClient.mockResolvedValue({ auth, rpc });
  auth.getClaims.mockResolvedValue({ data: { claims: { sub: "user-a" } }, error: null });
  rpc.mockResolvedValue({ data: [], error: null });
});

it("verifies the user and preserves the exact timestamp cursor", async () => {
  await expect(loadMoreHistory(beforeAt, id)).resolves.toEqual({ items: [], hasMore: false });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("get_history", {
    p_limit: 21,
    p_before_at: beforeAt,
    p_before_id: id,
  });
  expect(auth.getClaims).toHaveBeenCalledBefore(rpc);
});

it.each([
  ["", id],
  ["not-a-date", id],
  [beforeAt, "not-a-uuid"],
])("rejects invalid cursors without reading the database", async (timestamp, itemId) => {
  await expect(loadMoreHistory(timestamp, itemId)).rejects.toThrow("Invalid history cursor.");
  expect(createClient).not.toHaveBeenCalled();
});

it("does not load history for unverified claims", async () => {
  auth.getClaims.mockResolvedValueOnce({ data: null, error: null });
  await expect(loadMoreHistory(beforeAt, id)).rejects.toThrow("Authentication required.");
  expect(rpc).not.toHaveBeenCalled();
});

it("returns a generic pagination failure", async () => {
  rpc.mockResolvedValueOnce({ error: new Error("database detail") });
  await expect(loadMoreHistory(beforeAt, id)).rejects.toThrow("Could not load more history.");
});
