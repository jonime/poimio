import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserMenu } from "./user-menu";

vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    createElement("a", { ...props, href }, children),
}));
vi.mock("@/components/ui/dropdown-menu", async () => {
  const React = await import("react");
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuTrigger: ({
      children,
      render,
    }: {
      children: React.ReactNode;
      render: React.ReactElement<{ children?: React.ReactNode }>;
    }) => React.cloneElement(render, {}, children),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { role: "menu" }, children),
    DropdownMenuGroup: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { role: "group" }, children),
    DropdownMenuLinkItem: ({
      children,
      render,
    }: {
      children: React.ReactNode;
      render: React.ReactElement<{ children?: React.ReactNode }>;
    }) => React.cloneElement(render, {}, children),
    DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) =>
      React.createElement("button", { type: "button", role: "menuitem", onClick }, children),
  };
});

let dom: JSDOM;
let container: HTMLElement;
let root: Root | undefined;

beforeEach(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3001" });
  const view = dom.window as unknown as Window & typeof globalThis;
  for (const [name, value] of Object.entries({
    window: view,
    document: view.document,
    navigator: view.navigator,
    HTMLElement: view.HTMLElement,
    Element: view.Element,
    Node: view.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  container = view.document.createElement("div");
  view.document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(UserMenu, { displayName: "Joni Mertoniemi" })));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

it("links the user menu to tune feed and hidden sources", () => {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="User menu"]');
  assert(trigger, "User menu trigger must exist");
  expect(trigger.textContent).toContain("Joni");
  expect(trigger.textContent).not.toContain("Mertoniemi");
  expect(container.querySelector('a[href="/preferences/tune"]')?.textContent).toContain(
    "Tune feed",
  );
  expect(container.querySelector('a[href="/preferences/sources"]')?.textContent).toContain(
    "Sources",
  );
  expect(container.querySelector('a[href="/admin/sources"]')).toBeNull();
});

it("shows source discovery only when the server-derived admin flag is true", async () => {
  await act(async () =>
    root?.render(createElement(UserMenu, { displayName: "Joni Mertoniemi", isAdmin: true })),
  );
  expect(container.querySelector('a[href="/admin/sources"]')?.textContent).toContain(
    "Source discovery",
  );
});

it("submits the hidden sign-out form from the Log out item", async () => {
  const form = container.querySelector("form");
  assert(form, "Sign-out form must exist");
  const requestSubmit = vi.fn();
  form.requestSubmit = requestSubmit;
  const logout = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.includes("Log out"),
  );
  assert(logout, "Log out menu item must exist");
  await act(async () => logout.click());
  expect(requestSubmit).toHaveBeenCalledExactlyOnceWith();
});
