// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearFeedback } from "@/app/feedback/actions";
import type { LikedFeedItem } from "@/lib/feed-ui";
import LikedList from "./liked-list";

vi.mock("@/app/feedback/actions", () => ({ clearFeedback: vi.fn() }));

const renderedAt = "2026-11-02T12:00:00.000Z";
const item: LikedFeedItem = {
  id: "item-1",
  title: "First liked article",
  url: "https://example.com/first",
  summary: "Article summary",
  summary_origin: "feed",
  type: "article",
  language: "en",
  thumbnail_url: null,
  published_at: renderedAt,
  source_name: "Example News",
  liked_at: renderedAt,
};
const otherItem: LikedFeedItem = {
  ...item,
  id: "item-2",
  title: "Second liked video",
  summary: null,
  source_name: "Päivän uutiset",
  type: "video",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function searchInput() {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]');
  assert(input, "Search field must be rendered");
  return input;
}

async function search(value: string) {
  const input = searchInput();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert(setValue);
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function titles() {
  return Array.from(container.querySelectorAll("h2"), (heading) => heading.textContent);
}

function resultCount() {
  return container.querySelector('[role="status"]')?.textContent;
}

it("shows fresh server items when an already mounted liked list is updated", async () => {
  await act(async () => {
    root.render(<LikedList items={[]} renderedAt={renderedAt} />);
  });
  expect(container.textContent).toContain("No liked items yet.");

  await act(async () => {
    root.render(<LikedList items={[item]} renderedAt={renderedAt} />);
  });
  expect(container.textContent).toContain(item.title);
  expect(container.textContent).not.toContain("No liked items yet.");

  await act(async () => {
    root.render(<LikedList items={[]} renderedAt={renderedAt} />);
  });
  expect(container.textContent).not.toContain(item.title);
  expect(container.textContent).toContain("No liked items yet.");
});

it("filters by title, full summary, or source using a literal case-insensitive substring", async () => {
  const longSummary = { ...item, summary: `${"Article summary ".repeat(40)}Tail [detail]` };
  await act(async () => {
    root.render(<LikedList items={[longSummary, otherItem]} renderedAt={renderedAt} />);
  });

  expect(searchInput().labels?.[0]?.textContent).toBe("Search liked items");
  expect(resultCount()).toBe("Showing 2 of 2 loaded liked items");
  await search("  FIRST LIKED  ");
  expect(titles()).toEqual([item.title]);
  expect(resultCount()).toBe("Showing 1 of 2 loaded liked items");
  await search("tail [DETAIL]");
  expect(titles()).toEqual([item.title]);
  await search("PÄIVÄN");
  expect(titles()).toEqual([otherItem.title]);

  for (const query of ["paivan", "tail detail", "first  liked", "article example"]) {
    await search(query);
    expect(titles()).toEqual([]);
  }
  expect(resultCount()).toBe("Showing 0 of 2 loaded liked items");
  expect(container.textContent).toContain("No matching liked items.");
  expect(container.textContent).toContain("Try another search or clear it.");

  await search("   ");
  expect(titles()).toEqual([item.title, otherItem.title]);
  expect(container.textContent).not.toContain("Clear search");
  await search("");
  expect(searchInput().value).toBe("");
  expect(titles()).toEqual([item.title, otherItem.title]);
  expect(resultCount()).toBe("Showing 2 of 2 loaded liked items");
});

it("recomputes matches from refreshed server items after Unlike while preserving the query", async () => {
  await act(async () => {
    root.render(<LikedList items={[item, otherItem]} renderedAt={renderedAt} />);
  });
  await search("video");
  const unlike = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Unlike ${otherItem.title}"]`,
  );
  assert(unlike);
  await act(async () => unlike.click());
  expect(clearFeedback).toHaveBeenCalledExactlyOnceWith(otherItem.id);

  await act(async () => {
    root.render(<LikedList items={[item]} renderedAt={renderedAt} />);
  });
  expect(searchInput().value).toBe("video");
  expect(resultCount()).toBe("Showing 0 of 1 loaded liked items");
  expect(container.textContent).toContain("No matching liked items.");

  await act(async () => {
    root.render(<LikedList items={[]} renderedAt={renderedAt} />);
  });
  expect(container.textContent).toContain("No liked items yet.");
  expect(container.querySelector('a[href="/"]')?.textContent).toBe("Browse your feed");
  expect(container.querySelector('input[type="search"]')).toBeNull();
  expect(resultCount()).toBeUndefined();
});

it("keeps the query and matching like visible and shows an error if Unlike fails", async () => {
  vi.mocked(clearFeedback).mockRejectedValueOnce(new Error("Save failed"));
  await act(async () => {
    root.render(<LikedList items={[item, otherItem]} renderedAt={renderedAt} />);
  });
  await search("first");

  await act(async () => {
    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Unlike ${item.title}"]`,
    );
    assert(button, "Unlike button must be rendered");
    button.click();
  });
  expect(clearFeedback).toHaveBeenCalledExactlyOnceWith(item.id);
  expect(searchInput().value).toBe("first");
  expect(titles()).toEqual([item.title]);
  expect(container.textContent).toContain("Could not remove this like.");
});
