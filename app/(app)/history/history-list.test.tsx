// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearFeedback, setFeedback } from "@/app/feedback/actions";
import type { HistoryFeedItem } from "@/lib/feed-ui";
import { loadMoreHistory } from "./actions";
import HistoryList from "./history-list";

vi.mock("@/app/feedback/actions", () => ({
  clearFeedback: vi.fn(),
  setFeedback: vi.fn(),
}));
vi.mock("./actions", () => ({ loadMoreHistory: vi.fn() }));

const renderedAt = "2026-11-27T12:00:00.000Z";
const first: HistoryFeedItem = {
  id: "11111111-1111-4111-8111-111111111111",
  url: "https://example.com/first",
  title: "First history item",
  summary: "A saved article",
  summary_origin: "feed",
  type: "article",
  language: "en",
  thumbnail_url: null,
  published_at: renderedAt,
  source_id: "source-1",
  source_name: "Example",
  event_at: renderedAt,
  opened: true,
  seen: false,
  feedback_kind: "like",
};
const second: HistoryFeedItem = {
  ...first,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Second history item",
  opened: true,
  seen: true,
  event_at: "2026-11-26T12:00:00.000Z",
  feedback_kind: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  vi.mocked(setFeedback).mockResolvedValue(undefined);
  vi.mocked(clearFeedback).mockResolvedValue(undefined);
  vi.mocked(loadMoreHistory).mockResolvedValue({ items: [second], hasMore: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(items = [first], hasMore = false) {
  await act(async () => {
    root.render(
      <HistoryList initialItems={items} initialHasMore={hasMore} renderedAt={renderedAt} />,
    );
  });
}

it("shows the empty state", async () => {
  await render([]);
  expect(container.textContent).toContain("No history yet.");
  expect(container.textContent).toContain("Items you open or mark as seen will appear here.");
});

it("shows event badges and starts pressed state from the returned feedback", async () => {
  await render([{ ...second, feedback_kind: "like" }]);
  expect(container.textContent).toContain("Opened");
  expect(container.textContent).toContain("Seen");
  expect(container.querySelector('button[aria-label="Like"]')?.getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(container.querySelector('button[aria-label="Seen"]')?.getAttribute("aria-pressed")).toBe(
    "false",
  );
});

it("updates feedback in place without reloading or reordering cards", async () => {
  await render([first, second]);
  const firstCard = container.querySelector<HTMLElement>(`[data-history-item-id="${first.id}"]`);
  assert(firstCard);
  const like = firstCard.querySelector<HTMLButtonElement>('button[aria-label="Like"]');
  assert(like);
  await act(async () => like.click());
  expect(clearFeedback).toHaveBeenCalledExactlyOnceWith(first.id);
  expect(like.getAttribute("aria-pressed")).toBe("false");
  const seen = firstCard.querySelector<HTMLButtonElement>('button[aria-label="Seen"]');
  assert(seen);
  await act(async () => seen.click());
  expect(setFeedback).toHaveBeenCalledExactlyOnceWith(first.id, "seen", "button");
  expect(seen.getAttribute("aria-pressed")).toBe("true");
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-history-item-id]")].map(
      (card) => card.dataset.historyItemId,
    ),
  ).toEqual([first.id, second.id]);
});

it("appends a deduplicated page with the exact cursor and hides Load more at the end", async () => {
  vi.mocked(loadMoreHistory).mockResolvedValueOnce({
    items: [first, second],
    hasMore: false,
  });
  await render([first], true);
  const loadMore = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Load more",
  );
  assert(loadMore);
  await act(async () => {
    loadMore.click();
    await Promise.resolve();
  });
  expect(loadMoreHistory).toHaveBeenCalledExactlyOnceWith(first.event_at, first.id);
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-history-item-id]")].map(
      (card) => card.dataset.historyItemId,
    ),
  ).toEqual([first.id, second.id]);
  expect(container.textContent).not.toContain("Load more");
});

it("shows feedback, pending, and pagination errors without unmounting the list", async () => {
  let resolveFeedback: (() => void) | undefined;
  vi.mocked(clearFeedback).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      resolveFeedback = resolve;
    }),
  );
  await render([first], true);
  const like = container.querySelector<HTMLButtonElement>('button[aria-label="Like"]');
  assert(like);
  await act(async () => like.click());
  expect(like.disabled).toBe(true);
  await act(async () => {
    resolveFeedback?.();
    await Promise.resolve();
  });

  vi.mocked(loadMoreHistory).mockRejectedValueOnce(new Error("failed"));
  const loadMore = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Load more",
  );
  assert(loadMore);
  await act(async () => loadMore.click());
  expect(container.textContent).toContain("Could not load more history. Please try again.");
  expect(container.querySelector(`[data-history-item-id="${first.id}"]`)).not.toBeNull();
});

it("does not call click recording when a History title is activated", async () => {
  await render([first]);
  const link = container.querySelector<HTMLAnchorElement>("article a[href]");
  assert(link);
  await act(async () => link.click());
  expect(setFeedback).not.toHaveBeenCalled();
  expect(clearFeedback).not.toHaveBeenCalled();
});
