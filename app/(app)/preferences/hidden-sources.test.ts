import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { showSource } from "../../feedback/actions";
import { type HiddenSourceListItem, HiddenSources } from "./hidden-sources";

vi.mock("../../feedback/actions", () => ({ showSource: vi.fn() }));

const items: HiddenSourceListItem[] = [
  { sourceId: "source-a", sourceName: "First source", createdAt: "2026-11-20T12:00:00Z" },
  { sourceId: "source-b", sourceName: "Second source", createdAt: "2026-11-19T12:00:00Z" },
];
let dom: JSDOM;
let container: HTMLElement;
let root: Root | undefined;

async function render(itemsToRender: HiddenSourceListItem[], loadFailed = false) {
  assert(root, "React root must exist");
  await act(async () =>
    root?.render(createElement(HiddenSources, { items: itemsToRender, loadFailed })),
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3001" });
  const view = dom.window as unknown as Window & typeof globalThis;
  for (const [name, value] of Object.entries({
    window: view,
    document: view.document,
    navigator: view.navigator,
    HTMLElement: view.HTMLElement,
    Element: view.Element,
    Node: view.Node,
    getComputedStyle: view.getComputedStyle.bind(view),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  container = view.document.createElement("div");
  view.document.body.append(container);
  root = createRoot(container);
  await render(items);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

it("keeps pending and error state on only the selected source", async () => {
  let resolveFirst: ((result: { ok: false; error: "save_failed" }) => void) | undefined;
  vi.mocked(showSource).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFirst = resolve;
    }),
  );
  const first = container.querySelector<HTMLButtonElement>(
    '[aria-label="Show First source again"]',
  );
  const second = container.querySelector<HTMLButtonElement>(
    '[aria-label="Show Second source again"]',
  );
  assert(first && second, "Show again buttons must exist");

  await act(async () => first.click());
  expect(first.disabled).toBe(true);
  expect(second.disabled).toBe(false);
  expect(first.textContent).toContain("Showing");

  resolveFirst?.({ ok: false, error: "save_failed" });
  await act(async () => Promise.resolve());
  expect(first.disabled).toBe(false);
  expect(container.textContent).toContain("The source could not be shown. Please try again.");
  expect(container.textContent).toContain("First source");
});

it("removes a source only after Show again succeeds", async () => {
  vi.mocked(showSource).mockResolvedValueOnce({ ok: true, sourceId: "source-a" });
  const first = container.querySelector<HTMLButtonElement>(
    '[aria-label="Show First source again"]',
  );
  assert(first, "First Show again button must exist");
  await act(async () => {
    first.click();
    await Promise.resolve();
  });

  expect(showSource).toHaveBeenCalledExactlyOnceWith("source-a");
  expect(container.textContent).not.toContain("First source");
  expect(container.textContent).toContain("Second source");
});

it("shows an empty state or a load error for the section", async () => {
  await render([]);
  expect(container.textContent).toContain("No hidden sources");
  await render([], true);
  expect(container.textContent).toContain("Hidden sources could not be loaded");
});
