import { describe, expect, it } from "vitest";
import { displayNameFromClaims, getAppAccessRedirect } from "./app-access";

describe("getAppAccessRedirect", () => {
  it("sends users without verified identity to home", () => {
    expect(getAppAccessRedirect(false)).toBe("/");
  });

  it("does not redirect any verified user", () => {
    expect(getAppAccessRedirect(true)).toBeNull();
  });
});

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
