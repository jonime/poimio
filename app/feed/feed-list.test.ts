import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { setFeedback, clearFeedback } from "../feedback/actions";
import { toast } from "@/components/ui/toast";
import FeedList from "./feed-list";
import type { FeedItem } from "@/lib/feed-ui";

vi.mock("../feedback/actions", () => ({ setFeedback: vi.fn(), clearFeedback: vi.fn() }));
vi.mock("./actions", () => ({ loadMoreFeed: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn(() => "undo"), close: vi.fn() } }));

const item: FeedItem = {
  id: "test-item",
  url: "https://example.com/story",
  title: "Interactive story",
  summary: "The shared card still supports feedback.",
  summary_origin: "feed",
  type: "article",
  language: "en",
  thumbnail_url: null,
  published_at: "2026-11-03T10:00:00Z",
  source_name: "Example",
  score: 0,
  reason: "recent",
  because_item_id: null,
  because_title: null,
};
let dom: JSDOM;
let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(setFeedback).mockResolvedValue(undefined);
  vi.mocked(clearFeedback).mockResolvedValue(undefined);
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3001/" });
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
  }))
    vi.stubGlobal(name, value);
  container = view.document.createElement("div");
  view.document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(FeedList, {
        initialItems: [item],
        renderedAt: "2026-11-03T11:00:00Z",
      }),
    ),
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom?.window.close();
  vi.unstubAllGlobals();
});

it("keeps the shared card's Like and Seen buttons independent of the article link", async () => {
  const like = container.querySelector<HTMLButtonElement>('button[aria-label="Like"]')!;
  await act(async () => like.click());
  expect(setFeedback).toHaveBeenLastCalledWith(item.id, "like", "button");
  expect(like.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("a")?.getAttribute("href")).toBe(item.url);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Seen"]')!.click(),
  );
  expect(setFeedback).toHaveBeenLastCalledWith(item.id, "seen", "button");
  expect(container.querySelector("[hidden]")).not.toBeNull();
});

it.each([
  [200, "like"],
  [-200, "not_interested"],
] as const)("preserves touch swipe %i and Undo through the shared card", async (delta, kind) => {
  const article = container.querySelector("article")!;
  vi.spyOn(article, "getBoundingClientRect").mockReturnValue({ width: 300 } as DOMRect);
  Object.defineProperty(article, "setPointerCapture", { value: vi.fn() });
  async function pointer(name: string, x: number) {
    const event = dom.window.document.createEvent("Event");
    event.initEvent(name, true, true);
    Object.defineProperties(event, {
      pointerType: { value: "touch" },
      isPrimary: { value: true },
      pointerId: { value: 1 },
      clientX: { value: x },
      clientY: { value: 100 },
    });
    await act(async () => {
      article.dispatchEvent(event);
    });
  }
  await pointer("pointerdown", 200);
  await pointer("pointermove", 200 + delta);
  await pointer("pointerup", 200 + delta);
  expect(setFeedback).toHaveBeenLastCalledWith(item.id, kind, "swipe");
  const undo = vi.mocked(toast.add).mock.lastCall?.[0].actionProps?.onClick;
  expect(undo).toBeTypeOf("function");
  await act(async () => {
    undo?.({} as never);
  });
  expect(clearFeedback).toHaveBeenCalledWith(item.id);
  expect(container.querySelector("[hidden]")).toBeNull();
});
