import { describe, expect, it } from "vitest";
import { isLocalSupabaseProjectUrl } from "./local-project.ts";

describe("local Supabase project URL", () => {
  it.each(["http://localhost:55321", "http://127.0.0.1:55321"])("accepts %s", (url) => {
    expect(isLocalSupabaseProjectUrl(url)).toBe(true);
  });

  it.each([
    "https://localhost:55321",
    "http://localhost:54321",
    "http://localhost.evil.example:55321",
    "http://localhost:55321@evil.example",
    "https://example.supabase.co",
    "",
  ])("rejects %s", (url) => {
    expect(isLocalSupabaseProjectUrl(url)).toBe(false);
  });
});
