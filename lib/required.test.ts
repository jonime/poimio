import { describe, expect, it } from "vitest";
import { requireDefined } from "./required";

describe("requireDefined", () => {
  it.each([null, undefined])("rejects %s with context", (value) => {
    expect(() => requireDefined(value, "fixture item")).toThrow("Missing fixture item");
  });

  it.each([0, false, ""])('preserves defined value "%s"', (value) => {
    expect(requireDefined(value, "value")).toBe(value);
  });

  it("preserves object identity", () => {
    const value = { id: "item" };
    expect(requireDefined(value, "item")).toBe(value);
  });
});
