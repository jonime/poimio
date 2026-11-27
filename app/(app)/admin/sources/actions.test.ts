import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideCandidate, scanCatalog } from "./actions";

const {
  auth,
  userRpc,
  createClient,
  createServiceRoleClient,
  serviceRpc,
  scanInactiveCatalog,
  revalidatePath,
} = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  userRpc: vi.fn(),
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  serviceRpc: vi.fn(),
  scanInactiveCatalog: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/service-role", () => ({ createServiceRoleClient }));
vi.mock("@/lib/source-discovery-scan", () => ({ scanInactiveCatalog }));
vi.mock("next/cache", () => ({ revalidatePath }));

const validId = "123e4567-e89b-42d3-a456-426614174000";

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  auth.getClaims.mockResolvedValue({ data: { claims: { sub: "admin-user" } }, error: null });
  userRpc.mockResolvedValue({ data: true, error: null });
  createClient.mockResolvedValue({ auth, rpc: userRpc });
  createServiceRoleClient.mockReturnValue({ rpc: serviceRpc });
  scanInactiveCatalog.mockResolvedValue({
    status: "completed",
    processed: 2,
    failed: 1,
  });
  serviceRpc.mockResolvedValue({ data: "approved", error: null });
  vi.stubEnv("OPENAI_API_KEY", "test-key");
});

describe("scanCatalog", () => {
  it.each([
    { claims: { data: null, error: null }, admin: { data: true, error: null } },
    {
      claims: { data: { claims: { sub: "user" } }, error: new Error("claims invalid") },
      admin: { data: true, error: null },
    },
    {
      claims: { data: { claims: { sub: "user" } }, error: null },
      admin: { data: false, error: null },
    },
    {
      claims: { data: { claims: { sub: "user" } }, error: null },
      admin: { data: null, error: new Error("admin lookup failed") },
    },
  ])("fails closed without using the service role or scanning", async ({ claims, admin }) => {
    auth.getClaims.mockResolvedValue(claims);
    userRpc.mockResolvedValue(admin);

    await expect(scanCatalog()).resolves.toEqual({ ok: false, error: "not_found" });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(scanInactiveCatalog).not.toHaveBeenCalled();
  });

  it("uses the service role only after verified admin access and reports scan-running", async () => {
    scanInactiveCatalog.mockResolvedValue({
      status: "scan_running",
      processed: 0,
      failed: 0,
    });

    await expect(scanCatalog()).resolves.toEqual({
      ok: true,
      result: { status: "scan_running", processed: 0, failed: 0 },
    });
    expect(auth.getClaims).toHaveBeenCalledBefore(userRpc);
    expect(userRpc).toHaveBeenCalledExactlyOnceWith("is_admin");
    expect(createServiceRoleClient).toHaveBeenCalledExactlyOnceWith();
    expect(scanInactiveCatalog).toHaveBeenCalledExactlyOnceWith(
      { rpc: serviceRpc },
      "test-key",
      "admin-user",
    );
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/admin/sources");
  });
});

describe("decideCandidate", () => {
  it("rejects malformed inputs before creating either client", async () => {
    await expect(decideCandidate("bad-id", "approve")).resolves.toEqual({
      ok: false,
      error: "invalid_request",
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("does not create the service client for a non-admin", async () => {
    userRpc.mockResolvedValue({ data: false, error: null });
    await expect(decideCandidate(validId, "reject")).resolves.toEqual({
      ok: false,
      error: "not_found",
    });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it.each([
    { claims: { data: null, error: null }, admin: { data: true, error: null } },
    {
      claims: { data: { claims: { sub: "user" } }, error: new Error("claims invalid") },
      admin: { data: true, error: null },
    },
    {
      claims: { data: { claims: { sub: "user" } }, error: null },
      admin: { data: false, error: null },
    },
    {
      claims: { data: { claims: { sub: "user" } }, error: null },
      admin: { data: null, error: new Error("admin lookup failed") },
    },
  ])(
    "fails closed for decision actions without using the service role",
    async ({ claims, admin }) => {
      auth.getClaims.mockResolvedValue(claims);
      userRpc.mockResolvedValue(admin);

      await expect(decideCandidate(validId, "approve")).resolves.toEqual({
        ok: false,
        error: "not_found",
      });
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(serviceRpc).not.toHaveBeenCalled();
    },
  );

  it.each(["approved", "rejected", "unchanged", "already_decided", "already_known", "stale"])(
    "returns the database decision result %s",
    async (status) => {
      serviceRpc.mockResolvedValue({ data: status, error: null });
      await expect(decideCandidate(validId, "approve")).resolves.toEqual({
        ok: true,
        status,
      });
      expect(auth.getClaims).toHaveBeenCalledBefore(userRpc);
      expect(createServiceRoleClient).toHaveBeenCalledExactlyOnceWith();
      expect(serviceRpc).toHaveBeenCalledExactlyOnceWith("decide_source_candidate", {
        p_candidate_id: validId,
        p_decision: "approve",
      });
    },
  );
});
