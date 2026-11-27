import { JSDOM } from "jsdom";
import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminSourcesPage from "./page";

const { auth, rpc, createClient, from, useRouter } = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  rpc: vi.fn(),
  createClient: vi.fn(),
  from: vi.fn(),
  useRouter: vi.fn(() => ({ refresh: vi.fn() })),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("./actions", () => ({
  decideCandidate: vi.fn(),
  scanCatalog: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter,
}));

const claims = { data: { claims: { sub: "admin-user" } }, error: null };
const candidateRows = [
  {
    id: "low",
    origin: "catalog",
    name: "<img src=x onerror=alert(1)>",
    feed_url: "https://feed.example/rss",
    site_url: "javascript:alert(1)",
    kind: "rss",
    language: "fi",
    status: "pending",
    failure: null,
    item_count: 3,
    items_per_day: 1,
    relevance: "low",
    relevance_basis: "all_users",
    mean_match_share: 0.2,
    duplicate_share: 0.1,
    sample_titles: ["<script>alert(1)</script>"],
    scanned_at: "2026-11-28T12:00:00Z",
    decided_at: null,
  },
  {
    id: "high",
    origin: "catalog",
    name: "High relevance source",
    feed_url: "https://high.example/rss",
    site_url: "https://high.example",
    kind: "rss",
    language: "en",
    status: "pending",
    failure: null,
    item_count: 10,
    items_per_day: 2.5,
    relevance: "high",
    relevance_basis: "admin",
    mean_match_share: 0.6,
    duplicate_share: 0.05,
    sample_titles: ["A recent title"],
    scanned_at: "2026-11-28T12:00:00Z",
    decided_at: null,
  },
  {
    id: "failed",
    origin: "catalog",
    name: "Failed source",
    feed_url: "https://failed.example/rss",
    site_url: null,
    kind: "rss",
    language: "fi",
    status: "failed",
    failure: "fetch_failed",
    item_count: null,
    items_per_day: null,
    relevance: "not_scored",
    relevance_basis: null,
    mean_match_share: null,
    duplicate_share: null,
    sample_titles: [],
    scanned_at: "2026-11-28T12:00:00Z",
    decided_at: null,
  },
  {
    id: "decided",
    origin: "catalog",
    name: "Rejected source",
    feed_url: "https://rejected.example/rss",
    site_url: null,
    kind: "rss",
    language: "en",
    status: "rejected",
    failure: null,
    item_count: 4,
    items_per_day: 1,
    relevance: "medium",
    relevance_basis: null,
    mean_match_share: 0.3,
    duplicate_share: 0.1,
    sample_titles: [],
    scanned_at: "2026-11-28T12:00:00Z",
    decided_at: "2026-11-28T13:00:00Z",
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  auth.getClaims.mockResolvedValue(claims);
  rpc.mockResolvedValue({ data: true, error: null });
  const candidateQuery = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: candidateRows, error: null }),
  };
  const runQuery = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        id: "run",
        kind: "catalog",
        started_at: "2026-11-28T12:00:00Z",
        finished_at: "2026-11-28T12:05:00Z",
        status: "completed",
        failures: [],
      },
      error: null,
    }),
  };
  from.mockImplementation((table: string) =>
    table === "source_candidates" ? candidateQuery : runQuery,
  );
  createClient.mockResolvedValue({ auth, rpc, from });
});

async function renderPage(errors: unknown[] = []) {
  const stream = await renderToReadableStream(AdminSourcesPage(), {
    onError: (error) => {
      errors.push(error);
    },
  });
  await stream.allReady;
  return new Response(stream).text();
}

describe("admin source discovery page", () => {
  it.each([
    { claims: { data: null, error: null }, admin: { data: true, error: null } },
    {
      claims: { data: { claims: { sub: "user" } }, error: new Error("claims invalid") },
      admin: { data: true, error: null },
    },
    {
      claims: { data: { claims: { sub: "user" } }, error: null },
      admin: { data: false, error: null },
    },
    {
      claims: { data: { claims: { sub: "user" } }, error: null },
      admin: { data: null, error: new Error("admin lookup failed") },
    },
  ])("returns not-found before reading candidates or runs", async ({ claims, admin }) => {
    auth.getClaims.mockResolvedValue(claims);
    rpc.mockResolvedValue(admin);

    const errors: unknown[] = [];
    await renderPage(errors);
    expect(errors).toEqual([expect.objectContaining({ message: "NOT_FOUND" })]);
    expect(from).not.toHaveBeenCalled();
  });

  it("sorts candidates, separates statuses, hides terminal rows, and renders text safely", async () => {
    const dom = new JSDOM(await renderPage());
    const text = dom.window.document.body.textContent ?? "";
    const names = [...dom.window.document.querySelectorAll('[role="group"]')].map((card) =>
      card.getAttribute("aria-label"),
    );

    expect(text).toContain("Last run:");
    expect(text).toContain("based on your likes");
    expect(names.slice(0, 2)).toEqual(["High relevance source", "<img src=x onerror=alert(1)>"]);
    expect(text).toContain("fetch_failed");
    expect(text).not.toContain("javascript:alert(1)");
    expect(dom.window.document.querySelector("img")).toBeNull();
    expect(
      [...dom.window.document.querySelectorAll("li")].map((item) => item.textContent),
    ).toContain("<script>alert(1)</script>");
    expect(dom.window.document.querySelector("li script")).toBeNull();
    expect(dom.window.document.querySelector("details")?.textContent).toContain("Rejected source");
    expect(dom.window.document.querySelector("details")?.open).toBe(false);
    dom.window.close();
  });
});
