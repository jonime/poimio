import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hideSource, setSourceVisible, showSource } from "./actions";

const { auth, createClient, from, rpc, deleteQuery, insert, eq, select } = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  createClient: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  deleteQuery: vi.fn(),
  insert: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
}));

vi.mock("../../lib/supabase/server", () => ({ createClient }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const itemId = "123e4567-e89b-42d3-a456-426614174000";
const sourceId = "223e4567-e89b-42d3-a456-426614174000";

beforeEach(() => {
  vi.resetAllMocks();
  createClient.mockResolvedValue({ auth, from, rpc });
  auth.getClaims.mockResolvedValue({ data: { claims: { sub: "user-a" } }, error: null });
  rpc.mockResolvedValue({
    data: [{ source_id: sourceId, source_name: "Example source" }],
    error: null,
  });
  from.mockReturnValue({ delete: deleteQuery, insert });
  deleteQuery.mockReturnValue({ eq });
  eq.mockImplementationOnce(() => ({ eq }));
  eq.mockImplementationOnce(() => ({ select }));
  select.mockResolvedValue({ data: [{ source_id: sourceId }], error: null });
});

describe("hideSource", () => {
  it("rejects invalid IDs before creating a client", async () => {
    await expect(hideSource("not-a-uuid")).rejects.toThrow("Invalid item ID.");
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { data: { claims: { sub: "user-a" } }, error: new Error("bad claims") },
  ])("rejects an unauthenticated call", async (claims) => {
    auth.getClaims.mockResolvedValueOnce(claims);
    await expect(hideSource(itemId)).rejects.toThrow("Authentication required.");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("hides through the verified user's client and revalidates only Sources", async () => {
    await expect(hideSource(itemId)).resolves.toEqual({
      ok: true,
      sourceId,
      sourceName: "Example source",
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("hide_source_of_item", { p_item_id: itemId });
    expect(auth.getClaims).toHaveBeenCalledBefore(rpc);
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/preferences/sources");
  });

  it("returns a narrow error without revalidating on a database failure", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error("database detail") });
    await expect(hideSource(itemId)).resolves.toEqual({ ok: false, error: "save_failed" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("showSource", () => {
  it("rejects invalid IDs before creating a client", async () => {
    await expect(showSource("not-a-uuid")).rejects.toThrow("Invalid source ID.");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated call without deleting", async () => {
    auth.getClaims.mockResolvedValueOnce({ data: null, error: null });
    await expect(showSource(sourceId)).rejects.toThrow("Authentication required.");
    expect(from).not.toHaveBeenCalled();
  });

  it("deletes only the verified user's row and revalidates Sources", async () => {
    await expect(showSource(sourceId)).resolves.toEqual({ ok: true, sourceId });
    expect(from).toHaveBeenCalledExactlyOnceWith("hidden_sources");
    expect(eq).toHaveBeenNthCalledWith(1, "user_id", "user-a");
    expect(eq).toHaveBeenNthCalledWith(2, "source_id", sourceId);
    expect(auth.getClaims).toHaveBeenCalledBefore(from);
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/preferences/sources");
  });

  it("returns not_found without revalidating when the caller has no row", async () => {
    select.mockResolvedValueOnce({ data: [], error: null });
    await expect(showSource(sourceId)).resolves.toEqual({ ok: false, error: "not_found" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns save_failed without exposing database errors", async () => {
    select.mockResolvedValueOnce({ data: null, error: new Error("database detail") });
    await expect(showSource(sourceId)).resolves.toEqual({ ok: false, error: "save_failed" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setSourceVisible", () => {
  it("validates the ID and boolean before accessing the database", async () => {
    await expect(setSourceVisible("bad-id", true)).rejects.toThrow("Invalid source ID.");
    await expect(setSourceVisible(sourceId, "false")).rejects.toThrow("Invalid source visibility.");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated call", async () => {
    auth.getClaims.mockResolvedValueOnce({ data: null, error: null });
    await expect(setSourceVisible(sourceId, false)).rejects.toThrow("Authentication required.");
    expect(from).not.toHaveBeenCalled();
  });

  it.each([null, { code: "23505" }])(
    "hides idempotently with a plain insert (%j)",
    async (error) => {
      insert.mockResolvedValueOnce({ error });
      await expect(setSourceVisible(sourceId, false)).resolves.toEqual({
        ok: true,
        sourceId,
        visible: false,
      });
      expect(auth.getClaims).toHaveBeenCalledBefore(from);
      expect(from).toHaveBeenCalledExactlyOnceWith("hidden_sources");
      expect(insert).toHaveBeenCalledExactlyOnceWith({ user_id: "user-a", source_id: sourceId });
      expect(deleteQuery).not.toHaveBeenCalled();
      expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/preferences/sources");
    },
  );

  it("shows idempotently through an owner-scoped delete without requiring a row", async () => {
    eq.mockReset().mockReturnValueOnce({ eq }).mockResolvedValueOnce({ error: null });
    await expect(setSourceVisible(sourceId, true)).resolves.toEqual({
      ok: true,
      sourceId,
      visible: true,
    });
    expect(eq).toHaveBeenNthCalledWith(1, "user_id", "user-a");
    expect(eq).toHaveBeenNthCalledWith(2, "source_id", sourceId);
    expect(insert).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/preferences/sources");
  });

  it.each([true, false])(
    "does not revalidate or expose details on failure (visible=%s)",
    async (visible) => {
      const result = { error: { code: "23503", message: "database detail" } };
      insert.mockResolvedValueOnce(result);
      eq.mockReset().mockReturnValueOnce({ eq }).mockResolvedValueOnce(result);
      await expect(setSourceVisible(sourceId, visible)).resolves.toEqual({
        ok: false,
        error: "save_failed",
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});
