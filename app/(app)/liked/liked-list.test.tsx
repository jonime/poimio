// @vitest-environment jsdom

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

it("keeps the like visible and shows an error if Unlike fails", async () => {
  vi.mocked(clearFeedback).mockRejectedValueOnce(new Error("Save failed"));
  await act(async () => {
    root.render(<LikedList items={[item]} renderedAt={renderedAt} />);
  });

  await act(async () => {
    container.querySelector("button")!.click();
  });
  expect(clearFeedback).toHaveBeenCalledExactlyOnceWith(item.id);
  expect(container.textContent).toContain(item.title);
  expect(container.textContent).toContain("Could not remove this like.");
});
