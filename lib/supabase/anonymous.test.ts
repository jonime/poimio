import { afterEach, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAnonymousClient } from "./anonymous";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());

it("creates a separate public client without cookies, persistence, or token refresh", () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:55321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "must-never-be-used");
  createAnonymousClient();
  expect(createClient).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:55321", "public-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
});
