import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TuneFeedPage from "./page";

const { auth, createClient, from, preferenceOrder, usageGte } = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  createClient: vi.fn(),
  from: vi.fn(),
  preferenceOrder: vi.fn(),
  usageGte: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("next/navigation", () => ({
  redirect: (destination: string): never => {
    throw new Error(`REDIRECT:${destination}`);
  },
}));

const claims = {
  data: { claims: { sub: "user-a" } },
  error: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  createClient.mockResolvedValue({ auth, from });
  auth.getClaims.mockResolvedValue(claims);
  from.mockImplementation((table: string) => {
    if (table === "feed_preferences") return { select: () => ({ order: preferenceOrder }) };
    return { select: () => ({ eq: () => ({ gte: usageGte }) }) };
  });
  preferenceOrder.mockResolvedValue({ data: [], error: null });
  usageGte.mockResolvedValue({ count: 3, error: null });
});

async function html() {
  const stream = await renderToReadableStream(await TuneFeedPage());
  await stream.allReady;
  return new Response(stream).text();
}

describe("tune feed page", () => {
  it("loads only the caller's preferences and remaining requests", async () => {
    preferenceOrder.mockResolvedValue({
      data: [{ id: "pref-1", label: "Finnish sports", direction: "less" }],
      error: null,
    });
    const body = await html();

    expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith();
    expect(from).toHaveBeenCalledWith("feed_preferences");
    expect(from).toHaveBeenCalledWith("llm_usage");
    expect(from).not.toHaveBeenCalledWith("hidden_sources");
    expect(body).toContain("Tune feed");
    expect(body).toContain("Finnish sports");
    expect(body).toContain("less");
    expect(body).toContain("7 of 10 requests left.");
    expect(body).toContain("Tune feed");
    expect(body).toContain("0 / 300");
    expect(body).not.toContain("Hidden sources");
  });

  it("shows the empty state and the cap message", async () => {
    expect(await html()).toContain("No preferences yet");

    preferenceOrder.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, index) => ({
        id: `pref-${index}`,
        label: `Topic ${index}`,
        direction: "more",
      })),
      error: null,
    });
    const capped = await html();
    expect(capped).toContain("You can have at most 20 preferences. Delete one to add more.");
    expect(capped).toContain("disabled");
  });

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { ...claims, error: new Error("Unverified claims") },
  ])("redirects to login when the user is missing or unverified", async (result) => {
    auth.getClaims.mockResolvedValue(result);
    const errors: unknown[] = [];
    const stream = await renderToReadableStream(await TuneFeedPage(), {
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
