import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminSourcesReview, type CandidateRow } from "./review";

const { decideCandidate, scanCatalog, refresh } = vi.hoisted(() => ({
  decideCandidate: vi.fn(),
  scanCatalog: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("./actions", () => ({ decideCandidate, scanCatalog }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const candidate: CandidateRow = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  origin: "catalog",
  name: "Fixture source",
  feed_url: "https://example.test/rss",
  site_url: "https://example.test",
  kind: "rss",
  language: "en",
  status: "pending",
  failure: null,
  item_count: 3,
  items_per_day: 0.1,
  relevance: "high",
  relevance_basis: "admin",
  mean_match_share: 0.5,
  duplicate_share: 0,
  sample_titles: ["Recent title"],
  scanned_at: null,
  decided_at: null,
};

let dom: JSDOM;
let container: HTMLElement;
let root: Root | undefined;

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
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    vi.stubGlobal(name, value);
  }
  container = view.document.createElement("div");
  view.document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(AdminSourcesReview, {
        pending: [candidate],
        failed: [],
        decided: [],
        latestRun: null,
      }),
    ),
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

it("shows a pending state and reports an overlapping scan", async () => {
  let resolveScan: (result: unknown) => void = () => {};
  const scanPromise = new Promise((resolve) => {
    resolveScan = resolve;
  });
  scanCatalog.mockReturnValue(scanPromise);
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("Scan catalog"),
  );
  assert(button, "Scan catalog button must exist");

  await act(async () => {
    button.click();
  });
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("Scanning…");

  await act(async () => {
    resolveScan({
      ok: true,
      result: { status: "scan_running", processed: 0, failed: 0 },
    });
    await scanPromise;
  });
  expect(container.textContent).toContain("A source discovery scan is already running.");
  expect(refresh).toHaveBeenCalledExactlyOnceWith();
});

it("shows a decision result returned by the server action", async () => {
  decideCandidate.mockResolvedValue({ ok: true, status: "stale" });
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("Approve"),
  );
  assert(button, "Approve button must exist");

  await act(async () => {
    button.click();
  });
  expect(decideCandidate).toHaveBeenCalledExactlyOnceWith(candidate.id, "approve");
  expect(container.textContent).toContain(
    "The catalog source changed. The candidate remains pending.",
  );
  expect(refresh).toHaveBeenCalledExactlyOnceWith();
});

it("renders candidate details in wrapping cards without a horizontal table", () => {
  expect(container.querySelector("table")).toBeNull();
  expect(container.querySelector("[data-slot='table-container']")).toBeNull();
  expect(container.querySelector('section[aria-label="Pending candidates"]')).not.toBeNull();
  expect([...container.querySelectorAll("dt")].map((item) => item.textContent)).toEqual([
    "Relevance",
    "Match",
    "Duplicate",
    "Items/day",
  ]);
  expect(container.textContent).toContain("Recent titlesRecent title");
});
