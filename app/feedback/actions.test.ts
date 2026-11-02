import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearFeedback, setFeedback } from "./actions";
import { revalidatePath } from "next/cache";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { auth, createClient, from, rpc, deleteQuery, eq } = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  createClient: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  deleteQuery: vi.fn(),
  eq: vi.fn(),
}));

vi.mock("../../lib/supabase/server", () => ({ createClient }));

const validItemId = "123e4567-e89b-42d3-a456-426614174000";
const verifiedClaims = {
  data: { claims: { sub: "user-a" } },
  error: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  createClient.mockResolvedValue({ auth, from, rpc });
  auth.getClaims.mockResolvedValue(verifiedClaims);
  rpc.mockResolvedValue({ error: null });
  from.mockReturnValue({ delete: deleteQuery });
  deleteQuery.mockReturnValue({ eq });
  eq.mockImplementationOnce(() => ({ eq }));
  eq.mockImplementationOnce(async () => ({ error: null }));
});

describe("setFeedback", () => {
  it.each(["like", "not_interested", "seen"] as const)(
    "invalidates the liked page after saving %s feedback",
    async (kind) => {
      await setFeedback(validItemId, kind, "button");
      expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/liked");
      expect(vi.mocked(revalidatePath).mock.invocationCallOrder[0]).toBeGreaterThan(
        rpc.mock.invocationCallOrder[0],
      );
    },
  );

  it("rejects malformed UUIDs before creating a client", async () => {
    await expect(setFeedback("not-a-uuid", "like", "button")).rejects.toThrow(
      "Invalid item ID.",
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-uuid", "123e4567e89b42d3a456426614174000"])(
    "rejects malformed item ID %s without creating a client",
    async (itemId) => {
      await expect(setFeedback(itemId, "like", "button")).rejects.toThrow(
        "Invalid item ID.",
      );
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it.each(["", "dislike", "LIKE"])(
    "rejects unknown kind %s before creating a client",
    async (kind) => {
      await expect(
        setFeedback(validItemId, kind as "like", "button"),
      ).rejects.toThrow("Invalid feedback kind.");
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it.each(["", "gesture", "BUTTON"])(
    "rejects unknown via %s before creating a client",
    async (via) => {
      await expect(
        setFeedback(validItemId, "like", via as "button"),
      ).rejects.toThrow("Invalid feedback source.");
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { ...verifiedClaims, error: new Error("Invalid signature") },
  ])(
    "rejects a missing or unverified session without writing",
    async (result) => {
      auth.getClaims.mockResolvedValueOnce(result);
      await expect(setFeedback(validItemId, "like", "button")).rejects.toThrow(
        "Authentication required.",
      );
      expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith();
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    },
  );

  it("uses verified identity then writes through the RPC", async () => {
    await setFeedback(validItemId, "not_interested", "swipe");
    expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("set_feedback", {
      p_item_id: validItemId,
      p_kind: "not_interested",
      p_via: "swipe",
    });
    expect(rpc.mock.invocationCallOrder[0]).toBeGreaterThan(
      auth.getClaims.mock.invocationCallOrder[0],
    );
    expect(createClient).toHaveBeenCalledExactlyOnceWith();
    expect(from).not.toHaveBeenCalled();
  });

  it("does not expose database error details", async () => {
    rpc.mockResolvedValueOnce({ error: new Error("internal database detail") });
    await expect(setFeedback(validItemId, "like", "button")).rejects.toThrow(
      "Could not save feedback.",
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("clearFeedback", () => {
  it("rejects malformed UUIDs without creating a client", async () => {
    await expect(clearFeedback("not-a-uuid")).rejects.toThrow(
      "Invalid item ID.",
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { ...verifiedClaims, error: new Error("Invalid signature") },
  ])(
    "rejects a missing or unverified session without deleting",
    async (result) => {
      auth.getClaims.mockResolvedValueOnce(result);
      await expect(clearFeedback(validItemId)).rejects.toThrow(
        "Authentication required.",
      );
      expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith();
      expect(from).not.toHaveBeenCalled();
    },
  );

  it("deletes only the verified user's row for the requested item", async () => {
    await clearFeedback(validItemId);
    expect(from).toHaveBeenCalledExactlyOnceWith("feedback");
    expect(deleteQuery).toHaveBeenCalledExactlyOnceWith();
    expect(eq).toHaveBeenNthCalledWith(1, "user_id", "user-a");
    expect(eq).toHaveBeenNthCalledWith(2, "item_id", validItemId);
    expect(auth.getClaims.mock.invocationCallOrder[0]).toBeLessThan(
      from.mock.invocationCallOrder[0],
    );
    expect(createClient).toHaveBeenCalledExactlyOnceWith();
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/liked");
  });

  it("does not expose database error details", async () => {
    eq.mockReset();
    eq.mockImplementationOnce(() => ({ eq }));
    eq.mockImplementationOnce(async () => ({
      error: new Error("internal database detail"),
    }));
    await expect(clearFeedback(validItemId)).rejects.toThrow(
      "Could not clear feedback.",
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
