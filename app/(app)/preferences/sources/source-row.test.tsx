import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setSourceVisible } from "@/app/feedback/actions";
import { SourceRow } from "./source-row";

vi.mock("@/app/feedback/actions", () => ({ setSourceVisible: vi.fn() }));

const firstSource = {
  id: "a",
  name: "First source",
  language: "en",
  kind: "rss",
  description: null,
};
const secondSource = { ...firstSource, id: "b", name: "Second source" };

let dom: JSDOM;
let container: HTMLElement;
let root: Root;

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
  await act(async () =>
    root.render(
      <>
        <SourceRow source={firstSource} visible />
        <SourceRow source={secondSource} visible={false} />
      </>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

function switches() {
  const [first, second] = container.querySelectorAll<HTMLButtonElement>('button[role="switch"]');
  assert(first && second);
  return { first, second };
}

it("guards repeated activation and leaves other labelled, keyboard-focusable switches enabled", async () => {
  const request = Promise.withResolvers<Awaited<ReturnType<typeof setSourceVisible>>>();
  vi.mocked(setSourceVisible)
    .mockReturnValueOnce(request.promise)
    .mockResolvedValueOnce({ ok: true, sourceId: "b", visible: true });
  const { first, second } = switches();
  expect(first.labels?.[0]?.textContent).toBe("First source");
  expect(second.labels?.[0]?.textContent).toBe("Second source");
  second.focus();
  expect(document.activeElement).toBe(second);

  await act(async () => {
    first.click();
    first.click();
  });
  expect(setSourceVisible).toHaveBeenCalledExactlyOnceWith("a", false);
  expect(first.getAttribute("aria-checked")).toBe("false");
  expect(first.disabled).toBe(true);
  expect(second.disabled).toBe(false);
  await act(async () => second.click());
  expect(setSourceVisible).toHaveBeenLastCalledWith("b", true);
  expect(second.getAttribute("aria-checked")).toBe("true");

  await act(async () => request.resolve({ ok: true, sourceId: "a", visible: false }));
  expect(first.disabled).toBe(false);
  expect(first.getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it.each(["returned", "thrown"])(
  "reverts the switch and shows an inline error on a %s failure",
  async (failure) => {
    if (failure === "returned") {
      vi.mocked(setSourceVisible).mockResolvedValueOnce({ ok: false, error: "save_failed" });
    } else {
      vi.mocked(setSourceVisible).mockRejectedValueOnce(new Error("network"));
    }
    const { first, second } = switches();
    await act(async () => first.click());
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(first.disabled).toBe(false);
    expect(second.getAttribute("aria-checked")).toBe("false");
    const error = document.getElementById(first.getAttribute("aria-describedby") ?? "");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("Could not save this change");
  },
);
