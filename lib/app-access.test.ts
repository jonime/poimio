import { describe, expect, it } from "vitest";
import { displayNameFromClaims } from "./app-access";

describe("displayNameFromClaims", () => {
  it("shares display-name precedence without falling back to email", () => {
    expect(
      displayNameFromClaims({
        user_metadata: { full_name: "Ada Lovelace", name: "Ada" },
        name: "Other",
      }),
    ).toBe("Ada Lovelace");
    expect(displayNameFromClaims({ user_metadata: { full_name: " ", display_name: "Ada" } })).toBe(
      "Ada",
    );
    expect(displayNameFromClaims({ email: "private@example.test" })).toBeUndefined();
    expect(displayNameFromClaims(null)).toBeUndefined();
  });
});
