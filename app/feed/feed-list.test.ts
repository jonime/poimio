import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "@/components/ui/toast";
import type { FeedItem } from "@/lib/feed-ui";
import { requireDefined } from "@/lib/required";
import { clearFeedback, hideSource, setFeedback, showSource } from "../feedback/actions";
import { loadMoreFeed } from "./actions";
import FeedList from "./feed-list";

vi.mock("../feedback/actions", () => ({
  setFeedback: vi.fn(),
  clearFeedback: vi.fn(),
  hideSource: vi.fn(),
  showSource: vi.fn(),
}));
vi.mock("./actions", () => ({ loadMoreFeed: vi.fn() }));
vi.mock("@/components/ui/dropdown-menu", async () => {
  const React = await import("react");
  type MenuContextValue = { open: boolean; onOpenChange: (open: boolean) => void };
  const MenuContext = React.createContext<MenuContextValue>({
    open: false,
    onOpenChange: () => undefined,
  });
  return {
    DropdownMenu: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) => React.createElement(MenuContext.Provider, { value: { open, onOpenChange } }, children),
    DropdownMenuTrigger: ({
      children,
      render,
    }: {
      children: React.ReactNode;
      render: React.ReactElement<{ onClick?: () => void; "data-slot"?: string }>;
    }) => {
      const menu = React.useContext(MenuContext);
      return React.cloneElement(
        render,
        {
          onClick: () => menu.onOpenChange(!menu.open),
          "data-slot": "dropdown-menu-trigger",
        },
        children,
      );
    },
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      React.useContext(MenuContext).open
        ? React.createElement("div", { "data-slot": "dropdown-menu-content" }, children)
        : null,
    DropdownMenuGroup: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    DropdownMenuItem: ({
      children,
      disabled,
      onClick,
    }: {
      children: React.ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => {
      const menu = React.useContext(MenuContext);
      return React.createElement(
        "button",
        {
          type: "button",
          role: "menuitem",
          disabled,
          "data-slot": "dropdown-menu-item",
          "data-disabled": disabled ? "" : undefined,
          onClick: () => {
            if (disabled) return;
            onClick?.();
            menu.onOpenChange(false);
          },
        },
        children,
      );
    },
  };
});
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
  source_id: "source-a",
  source_name: "Example",
  score: 0,
  reason: "recent",
  because_item_id: null,
  because_title: null,
};
let dom: JSDOM;
let container: HTMLElement;
let root: Root | undefined;

async function renderItems(items: FeedItem[]) {
  assert(root, "React root must exist");
  await act(async () =>
    root?.render(
      createElement(FeedList, {
        key: items.map((item) => item.id).join(","),
        initialItems: items,
        renderedAt: "2026-11-03T11:00:00Z",
      }),
    ),
  );
}

function articleFor(id: string): HTMLElement {
  const article = [...container.querySelectorAll<HTMLElement>("article")].find(
    (candidate) => candidate.dataset.feedItemId === id,
  );
  assert(article, `Article ${id} must be rendered`);
  return article;
}

async function openMenu(trigger: HTMLButtonElement) {
  trigger.focus();
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      trigger.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "pointerdown" ? 1 : 0,
          pointerType: "mouse",
          pointerId: 1,
          isPrimary: true,
        }),
      );
    }
    trigger.click();
    await Promise.resolve();
  });
}

async function chooseHideItem(index: number) {
  const triggers = [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label="More actions"]'),
  ];
  const trigger = triggers[index];
  assert(trigger, `Menu trigger ${index} must be rendered`);
  await openMenu(trigger);
  const menuItems = [
    ...dom.window.document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]'),
  ];
  const menuItem = menuItems.at(-1);
  assert(menuItem, "Hide menu item must be rendered");
  await act(async () => {
    menuItem.click();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(setFeedback).mockResolvedValue(undefined);
  vi.mocked(clearFeedback).mockResolvedValue(undefined);
  vi.mocked(hideSource).mockResolvedValue({
    ok: true,
    sourceId: "source-a",
    sourceName: "Example",
  });
  vi.mocked(showSource).mockResolvedValue({ ok: true, sourceId: "source-a" });
  vi.mocked(loadMoreFeed).mockResolvedValue([]);
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3001/" });
  const view = dom.window as unknown as Window & typeof globalThis;
  class TestPointerEvent extends view.MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "";
      this.isPrimary = init.isPrimary ?? false;
    }
  }
  Object.defineProperty(view, "PointerEvent", { configurable: true, value: TestPointerEvent });
  for (const [name, value] of Object.entries({
    window: view,
    document: view.document,
    navigator: view.navigator,
    HTMLElement: view.HTMLElement,
    Element: view.Element,
    Node: view.Node,
    PointerEvent: TestPointerEvent,
    getComputedStyle: view.getComputedStyle.bind(view),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(name, value);
  const heading = view.document.createElement("h1");
  heading.id = "feed-heading";
  heading.tabIndex = -1;
  heading.textContent = "Your feed";
  view.document.body.append(heading);
  container = view.document.createElement("div");
  view.document.body.append(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await renderItems([item]);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom?.window.close();
  vi.unstubAllGlobals();
});

it("keeps the shared card's Like and Seen buttons independent of the article link", async () => {
  const like = container.querySelector<HTMLButtonElement>('button[aria-label="Like"]');
  assert(like, "Like button must be rendered");
  await act(async () => like.click());
  expect(setFeedback).toHaveBeenLastCalledWith(item.id, "like", "button");
  expect(like.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("a")?.getAttribute("href")).toBe(item.url);
  const seen = container.querySelector<HTMLButtonElement>('button[aria-label="Seen"]');
  assert(seen, "Seen button must be rendered");
  await act(async () => seen.click());
  expect(setFeedback).toHaveBeenLastCalledWith(item.id, "seen", "button");
  expect(container.querySelector("[hidden]")).not.toBeNull();
});

it.each([
  [200, "like"],
  [-200, "not_interested"],
] as const)("preserves touch swipe %i and Undo through the shared card", async (delta, kind) => {
  const article = requireDefined(container.querySelector("article"), "rendered article");
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

it("masks cards by source ID while same-name cards stay mounted and visible", async () => {
  const first = { ...item, id: "source-a-first" };
  const sameName = { ...item, id: "source-b", source_id: "source-b" };
  const second = { ...item, id: "source-a-second" };
  await renderItems([first, sameName, second]);
  const seen = container.querySelector<HTMLButtonElement>('button[aria-label="Seen"]');
  assert(seen, "Seen button must be rendered");
  await act(async () => seen.click());

  await chooseHideItem(0);

  expect(hideSource).toHaveBeenCalledExactlyOnceWith(first.id);
  expect(articleFor(first.id).closest("[hidden]")).not.toBeNull();
  expect(articleFor(second.id).closest("[hidden]")).not.toBeNull();
  expect(articleFor(sameName.id).closest("[hidden]")).toBeNull();
  expect([...container.querySelectorAll("article")].map((node) => node.dataset.feedItemId)).toEqual(
    [first.id, sameName.id, second.id],
  );
  expect(articleFor(first.id).getAttribute("aria-busy")).toBe("false");
});

it("Undo restores visibility without changing card order or feedback state", async () => {
  const second = { ...item, id: "source-b", source_id: "source-b", source_name: "Other" };
  await renderItems([item, second]);
  const like = container.querySelector<HTMLButtonElement>('button[aria-label="Like"]');
  assert(like, "Like button must be rendered");
  await act(async () => like.click());
  await chooseHideItem(0);

  const undo = vi.mocked(toast.add).mock.lastCall?.[0].actionProps?.onClick;
  assert(undo, "Undo action must be available");
  await act(async () => {
    undo({} as never);
    await Promise.resolve();
  });

  expect(showSource).toHaveBeenCalledExactlyOnceWith(item.source_id);
  expect(articleFor(item.id).closest("[hidden]")).toBeNull();
  expect(
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Like"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect([...container.querySelectorAll("article")].map((node) => node.dataset.feedItemId)).toEqual(
    [item.id, second.id],
  );
});

it("leaves the source visible on hide failure and masked on Undo failure", async () => {
  await renderItems([item]);
  vi.mocked(hideSource).mockResolvedValueOnce({ ok: false, error: "save_failed" });
  await chooseHideItem(0);
  expect(articleFor(item.id).closest("[hidden]")).toBeNull();
  expect(vi.mocked(toast.add).mock.lastCall?.[0].title).toBe("Could not hide this source");

  vi.mocked(showSource).mockResolvedValueOnce({ ok: false, error: "save_failed" });
  await chooseHideItem(0);
  expect(articleFor(item.id).closest("[hidden]")).not.toBeNull();
  const undo = vi.mocked(toast.add).mock.lastCall?.[0].actionProps?.onClick;
  assert(undo, "Undo action must be available");
  await act(async () => {
    undo({} as never);
    await Promise.resolve();
  });
  expect(articleFor(item.id).closest("[hidden]")).not.toBeNull();
  expect(vi.mocked(toast.add).mock.lastCall?.[0].description).toBe("Show it again from Sources.");
});

it("sends one hide request while the source is pending and moves focus to a visible card", async () => {
  let resolveHide: ((result: { ok: false; error: "save_failed" }) => void) | undefined;
  vi.mocked(hideSource).mockReturnValue(
    new Promise((resolve) => {
      resolveHide = resolve;
    }),
  );
  const other = { ...item, id: "other-item", source_id: "source-b", source_name: "Other" };
  await renderItems([item, other]);
  const triggers = [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label="More actions"]'),
  ];
  assert(triggers[0], "First menu trigger must exist");
  await openMenu(triggers[0]);
  const menuItem = [
    ...dom.window.document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]'),
  ].at(-1);
  assert(menuItem, "Hide menu item must exist");
  await act(async () => menuItem.click());
  await openMenu(triggers[0]);
  const pendingItem = [
    ...dom.window.document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]'),
  ].at(-1);
  assert(pendingItem, "Pending menu item must exist");
  expect(pendingItem.getAttribute("data-disabled")).not.toBeNull();
  await act(async () => pendingItem.click());
  expect(hideSource).toHaveBeenCalledTimes(1);
  await openMenu(triggers[0]);

  vi.mocked(hideSource).mockResolvedValue({
    ok: true,
    sourceId: "source-a",
    sourceName: "Example",
  });
  resolveHide?.({ ok: false, error: "save_failed" });
  await act(async () => Promise.resolve());
  vi.mocked(hideSource).mockResolvedValue({
    ok: true,
    sourceId: "source-a",
    sourceName: "Example",
  });
  await chooseHideItem(0);
  expect(articleFor(other.id).contains(dom.window.document.activeElement)).toBe(true);
});

it("keeps masked cards in pagination exclusions", async () => {
  const initialItems = Array.from({ length: 30 }, (_, index) => ({
    ...item,
    id: `loaded-${index}`,
    source_id: index % 2 === 0 ? "source-a" : "source-b",
  }));
  await renderItems(initialItems);
  await chooseHideItem(0);
  const loadMore = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Load more",
  );
  assert(loadMore, "Load more button must exist");
  await act(async () => {
    loadMore.click();
    await Promise.resolve();
  });
  expect(loadMoreFeed).toHaveBeenCalledExactlyOnceWith(
    initialItems.map((candidate) => candidate.id),
  );
});

it("masks a source in a page that arrives after hiding", async () => {
  const initialItems = Array.from({ length: 30 }, (_, index) => ({
    ...item,
    id: `loaded-${index}`,
    source_id: index % 2 === 0 ? "source-a" : "source-b",
  }));
  const lateHidden = {
    ...item,
    id: "late-hidden",
    source_id: "source-a",
    title: "Late hidden item",
  };
  const lateVisible = {
    ...item,
    id: "late-visible",
    source_id: "source-b",
    title: "Late visible item",
  };
  let resolvePage: ((nextItems: FeedItem[]) => void) | undefined;
  vi.mocked(loadMoreFeed).mockReturnValue(
    new Promise((resolve) => {
      resolvePage = resolve;
    }),
  );
  await renderItems(initialItems);
  const loadMore = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Load more",
  );
  assert(loadMore, "Load more button must exist");
  await act(async () => loadMore.click());
  await chooseHideItem(0);
  await act(async () => {
    resolvePage?.([lateHidden, lateVisible]);
    await Promise.resolve();
  });

  expect(articleFor(lateHidden.id).closest("[hidden]")).not.toBeNull();
  expect(articleFor(lateVisible.id).closest("[hidden]")).toBeNull();
});

it("does not start swiping from the menu trigger or an open menu", async () => {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
  assert(trigger, "Menu trigger must exist");
  const pointer = (target: Element, name: string, x: number) => {
    const event = new PointerEvent(name, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: 100,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
    });
    target.dispatchEvent(event);
  };
  await act(async () => {
    pointer(trigger, "pointerdown", 200);
    pointer(trigger, "pointermove", 0);
    pointer(trigger, "pointerup", 0);
  });
  expect(setFeedback).not.toHaveBeenCalled();

  await openMenu(trigger);
  const menuItem = dom.window.document.querySelector<HTMLElement>(
    '[data-slot="dropdown-menu-item"]',
  );
  assert(menuItem, "Menu item must exist");
  await act(async () => {
    pointer(menuItem, "pointerdown", 200);
    pointer(menuItem, "pointermove", 0);
    pointer(menuItem, "pointerup", 0);
  });
  expect(setFeedback).not.toHaveBeenCalled();
});
