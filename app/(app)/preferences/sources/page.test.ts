import { JSDOM } from "jsdom";
import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SourcesPage from "./page";

const { auth, createClient, from, select, eq } = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  createClient: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/app/feedback/actions", () => ({ setSourceVisible: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (destination: string): never => {
    throw new Error(`REDIRECT:${destination}`);
  },
}));

const claims = { data: { claims: { sub: "user-a" } }, error: null };
const sources = [
  { id: "c", name: "Zebra", language: "fi", kind: "rss", description: null, is_active: true },
  {
    id: "b",
    name: "alpha",
    language: "en",
    kind: "youtube",
    description: "Video description.",
    is_active: true,
  },
  { id: "a", name: "Alpha", language: "fi", kind: "rss", description: null, is_active: true },
  { id: "d", name: "Inactive", language: "en", kind: "rss", description: null, is_active: false },
];

beforeEach(() => {
  vi.resetAllMocks();
  createClient.mockResolvedValue({ auth, from });
  auth.getClaims.mockResolvedValue(claims);
  from.mockReturnValue({ select });
  select.mockReturnValue({ eq });
  eq.mockImplementation(async (column, value) => ({
    data:
      column === "is_active"
        ? sources.filter((source) => source.is_active === value)
        : [{ source_id: "b" }, { source_id: "d" }],
    error: null,
  }));
});

async function html() {
  const stream = await renderToReadableStream(SourcesPage());
  await stream.allReady;
  return new Response(stream).text();
}

describe("Sources page", () => {
  it("lists active sources, sorted by case-insensitive name then ID, with caller visibility", async () => {
    const dom = new JSDOM(await html());
    const document = dom.window.document;
    expect(document.querySelector("h1")?.textContent).toBe("Sources");
    expect(document.body.textContent).toContain("Changes apply on the next feed load or refresh.");
    expect(from.mock.calls).toEqual([["sources"], ["hidden_sources"]]);
    expect(select.mock.calls).toEqual([["id,name,language,kind,description"], ["source_id"]]);
    expect(eq.mock.calls).toEqual([
      ["is_active", true],
      ["user_id", "user-a"],
    ]);
    const rows = [...document.querySelectorAll('[data-slot="field"]')];
    expect(rows.map((row) => row.querySelector("label")?.textContent)).toEqual([
      "Alpha",
      "alpha",
      "Zebra",
    ]);
    expect(
      rows.map((row) =>
        [...row.querySelectorAll('[data-slot="badge"]')].map((badge) => badge.textContent),
      ),
    ).toEqual([["fi"], ["en", "Videos"], ["fi"]]);
    expect(
      rows.map((row) => row.querySelector('[data-slot="field-description"]')?.textContent),
    ).toEqual([undefined, "Video description.", undefined]);
    expect(
      rows.map((row) => row.querySelector('[role="switch"]')?.getAttribute("aria-checked")),
    ).toEqual(["true", "false", "true"]);
    dom.window.close();
  });

  it("shows an empty state when there are no active sources", async () => {
    eq.mockResolvedValueOnce({ data: [], error: null });
    expect(await html()).toContain("No active sources");
  });

  it.each(["sources", "hidden_sources"])("shows a destructive alert if %s fails", async (table) => {
    const selectRows = eq.getMockImplementation();
    eq.mockImplementation((column, value) =>
      (column === "is_active") === (table === "sources")
        ? Promise.resolve({ data: null, error: new Error("query failed") })
        : selectRows?.(column, value),
    );
    const body = await html();
    expect(body).toContain('role="alert"');
    expect(body).toContain("Sources could not be loaded");
    expect(body).not.toContain('role="switch"');
  });

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { ...claims, error: new Error("Unverified claims") },
  ])("redirects to login without verified claims", async (result) => {
    auth.getClaims.mockResolvedValue(result);
    const errors: unknown[] = [];
    const stream = await renderToReadableStream(SourcesPage(), {
      onError: (error) => {
        errors.push(error);
      },
    });
    await stream.allReady;
    await new Response(stream).text();
    expect(errors).toEqual([expect.objectContaining({ message: "REDIRECT:/login" })]);
    expect(from).not.toHaveBeenCalled();
  });
});
