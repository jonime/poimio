// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppNav } from "./app-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows History only for signed-in navigation", async () => {
  await act(async () => root.render(<AppNav />));
  expect(container.querySelector('a[href="/history"]')?.textContent).toBe("History");

  await act(async () => root.render(<AppNav guest />));
  expect(container.querySelector('a[href="/history"]')).toBeNull();
  expect(container.textContent).toContain("Home");
});
