import { expect, it } from "vitest";
import { parseSupabaseQueryResult } from "./supabase-query-result";

it("reads wrapped rows after status objects with braces in strings", () => {
  expect(
    parseSupabaseQueryResult(
      'Connecting...\n{"boundary":"id"}\n{"rows":[{"value":"brace } and array ] inside"}]}',
    ),
  ).toEqual({ rows: [{ value: "brace } and array ] inside" }] });
});

it("reads direct row arrays from newer CLI output", () => {
  expect(
    parseSupabaseQueryResult('Connecting...\n[{"safe":true},{"safe":false}]\nTrailing'),
  ).toEqual({
    rows: [{ safe: true }, { safe: false }],
  });
});

it("rejects output with no result rows", () => {
  expect(() => parseSupabaseQueryResult('Connecting...\n{"status":"ready"}')).toThrow(
    "Supabase CLI returned no JSON query rows.",
  );
});
