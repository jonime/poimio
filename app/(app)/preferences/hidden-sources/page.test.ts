import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HiddenSourcesPage from "./page";

const { auth, createClient, from, order } = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  createClient: vi.fn(),
  from: vi.fn(),
  order: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("next/navigation", () => ({
  redirect: (destination: string): never => {
    throw new Error(`REDIRECT:${destination}`);
  },
}));

const claims = { data: { claims: { sub: "user-a" } }, error: null };

beforeEach(() => {
  vi.resetAllMocks();
  createClient.mockResolvedValue({ auth, from });
  auth.getClaims.mockResolvedValue(claims);
  from.mockReturnValue({ select: () => ({ order }) });
  order.mockResolvedValue({ data: [], error: null });
});

async function html() {
  const stream = await renderToReadableStream(await HiddenSourcesPage());
  await stream.allReady;
  return new Response(stream).text();
}

describe("hidden sources page", () => {
  it("loads only the caller's hidden sources", async () => {
    order.mockResolvedValueOnce({
      data: [
        {
          source_id: "source-1",
          created_at: "2026-11-20T12:00:00Z",
          sources: { name: "Example source" },
        },
      ],
      error: null,
    });

    const body = await html();

    expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith();
    expect(from).toHaveBeenCalledExactlyOnceWith("hidden_sources");
    expect(body).toContain("Hidden sources");
    expect(body).toContain("Example source");
    expect(body).toContain("Show again");
    expect(body).not.toContain("Tune feed");
  });

  it("shows the empty and load-error states", async () => {
    expect(await html()).toContain("No hidden sources");
    order.mockResolvedValueOnce({ data: null, error: new Error("database failure") });
    expect(await html()).toContain("Hidden sources could not be loaded");
  });

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { ...claims, error: new Error("Unverified claims") },
  ])("redirects to login when the user is missing or unverified", async (result) => {
    auth.getClaims.mockResolvedValue(result);
    const errors: unknown[] = [];
    const stream = await renderToReadableStream(await HiddenSourcesPage(), {
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
