import { beforeEach, describe, expect, it, vi } from "vitest";
import { deletePreference, flipPreference, tunePreferences } from "./actions.ts";

const {
  tunePreferencesForUser,
  flipPreferenceForUser,
  deletePreferenceForUser,
  createClient,
  createServiceRoleClient,
  revalidatePath,
  userClient,
  serviceClient,
} = vi.hoisted(() => ({
  tunePreferencesForUser: vi.fn(),
  flipPreferenceForUser: vi.fn(),
  deletePreferenceForUser: vi.fn(),
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
  revalidatePath: vi.fn(),
  userClient: { kind: "user" },
  serviceClient: { kind: "service" },
}));

vi.mock("../../lib/preference-tuning.ts", () => ({
  tunePreferencesForUser,
  flipPreferenceForUser,
  deletePreferenceForUser,
}));
vi.mock("../../lib/supabase/server.ts", () => ({ createClient }));
vi.mock("../../lib/supabase/service-role.ts", () => ({ createServiceRoleClient }));
vi.mock("next/cache", () => ({ revalidatePath }));

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockReturnValue(serviceClient);
  tunePreferencesForUser.mockResolvedValue({ ok: true, remaining: 9, preferences: [] });
  flipPreferenceForUser.mockResolvedValue({ ok: true });
  deletePreferenceForUser.mockResolvedValue({
    ok: false,
    error: "not_found",
    message: "not found",
  });
});

describe("preference actions", () => {
  it("passes the user client to tune, flip, and delete", async () => {
    await tunePreferences("cars");
    const tuneInput = tunePreferencesForUser.mock.calls[0]?.[0] as {
      userClient: unknown;
      createServiceClient: () => unknown;
    };
    expect(tuneInput.userClient).toBe(userClient);
    expect(tuneInput.createServiceClient()).toBe(serviceClient);
    expect(revalidatePath).toHaveBeenCalledWith("/preferences/tune");
    createServiceRoleClient.mockClear();

    await flipPreference("11111111-1111-4111-8111-111111111111", "less");
    expect(flipPreferenceForUser).toHaveBeenCalledWith({
      userClient,
      preferenceId: "11111111-1111-4111-8111-111111111111",
      direction: "less",
    });

    await deletePreference("11111111-1111-4111-8111-111111111111");
    expect(deletePreferenceForUser).toHaveBeenCalledWith({
      userClient,
      preferenceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});
