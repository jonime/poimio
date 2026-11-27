// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearInterestSummary, summarizeInterests } from "../../preferences/actions";
import { InterestSummaryCard } from "./interest-summary-card";

vi.mock("../../preferences/actions", () => ({
  summarizeInterests: vi.fn(),
  clearInterestSummary: vi.fn(),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const stored = {
  summary: "You follow technology, space, and Finnish sport.",
  topics: ["Technology", "Space", "Finnish sport"],
  likeCount: 4,
  generatedAt: "2026-11-27T10:30:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  vi.mocked(summarizeInterests).mockResolvedValue({
    ok: true,
    remaining: 9,
    ...stored,
  });
  vi.mocked(clearInterestSummary).mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: Partial<Parameters<typeof InterestSummaryCard>[0]> = {}) {
  await act(async () => {
    root.render(
      <InterestSummaryCard
        initialSummary={null}
        remaining={10}
        positiveSignalCount={3}
        {...props}
      />,
    );
  });
}

function button(label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  assert(result, `Button ${label} must be rendered`);
  return result;
}

it("shows the empty state and disables generation before three positive signals", async () => {
  await render({ positiveSignalCount: 2 });
  expect(container.textContent).toContain("No interest summary yet");
  expect(container.textContent).toContain(
    "Like at least 3 items or add at least 3 positive preferences",
  );
  expect(button("Summarize my interests").disabled).toBe(true);
});

it("renders stored summary topics, like count, date, and Clear", async () => {
  await render({ initialSummary: stored });
  expect(container.textContent).toContain(stored.summary);
  expect(container.textContent).toContain("Technology");
  expect(container.textContent).toContain("Based on 4 likes");
  expect(container.querySelector(`time[datetime="${stored.generatedAt}"]`)).not.toBeNull();
  expect(button("Clear").disabled).toBe(false);
});

it("shows pending, saves a generated summary, and updates remaining requests", async () => {
  let resolveSummary: ((value: Awaited<ReturnType<typeof summarizeInterests>>) => void) | undefined;
  vi.mocked(summarizeInterests).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveSummary = resolve;
    }),
  );
  await render();
  await act(async () => button("Summarize my interests").click());
  expect(container.textContent).toContain("Summarizing...");
  expect(button("Summarizing...").disabled).toBe(true);
  await act(async () => {
    resolveSummary?.({ ok: true, remaining: 9, ...stored });
    await Promise.resolve();
  });
  expect(container.textContent).toContain(stored.summary);
  expect(container.textContent).toContain("9 of 10 requests left.");
});

it("shows limit and action errors without replacing a stored summary", async () => {
  await render({ initialSummary: stored, remaining: 0 });
  expect(button("Summarize my interests").disabled).toBe(true);
  expect(container.textContent).toContain("all 10 interest summary requests");

  vi.mocked(clearInterestSummary).mockResolvedValueOnce({
    ok: false,
    error: "failed",
    message: "Could not clear the interest summary.",
  });
  await act(async () => button("Clear").click());
  expect(container.textContent).toContain(stored.summary);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not clear the interest summary.",
  );
});

it("clears a stored summary back to the empty state", async () => {
  await render({ initialSummary: stored });
  await act(async () => button("Clear").click());
  expect(clearInterestSummary).toHaveBeenCalledExactlyOnceWith();
  expect(container.textContent).toContain("No interest summary yet");
  expect(container.textContent).not.toContain(stored.summary);
});
