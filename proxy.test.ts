import { expect, it } from "vitest";
import { sessionRoutes } from "./proxy";

it("refreshes the session on the protected source discovery route", () => {
  expect(sessionRoutes.has("/admin/sources")).toBe(true);
});
