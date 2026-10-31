import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import Home from "../(app)/page";
import Login from "../login/page";
import PrivacyPage, { metadata as privacyMetadata } from "../privacy/page";
import { AppHeader } from "@/components/app-header";
import { PasswordSignInForm } from "../login/password-sign-in-form";
import { signInWithPassword, signOut } from "./actions";
import { GET } from "./callback/route";

const { auth, createClient, rpc } = vi.hoisted(() => ({
  auth: {
    getClaims: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    exchangeCodeForSession: vi.fn(),
  },
  rpc: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("../../lib/supabase/server", () => ({ createClient }));
vi.mock("next/navigation", () => ({
  redirect: (destination: string): never => {
    throw new Error(`REDIRECT:${destination}`);
  },
  usePathname: () => "/",
  useRouter: () => ({ refresh: vi.fn() }),
}));

const verifiedClaims = {
  data: { claims: { sub: "user-a", email: "user-a@example.com" } },
  error: null,
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  createClient.mockResolvedValue({ auth, rpc });
  auth.getClaims.mockResolvedValue(verifiedClaims);
  auth.signOut.mockResolvedValue({ error: null });
  auth.signInWithPassword.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({ data: [], error: null });
  auth.exchangeCodeForSession.mockResolvedValue({ error: null });
});

describe("signed-in page", () => {
  it("independently verifies identity before rendering the feed", async () => {
    await Home({ searchParams: Promise.resolve({}) });
    expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith();
  });

  it("shows only the first name, navigation, and sign-out in the shared header", () => {
    const html = renderToStaticMarkup(
      createElement(AppHeader, { displayName: "Joni Mertoniemi" }),
    );
    expect(html).toContain(">Joni</span>");
    expect(html).not.toContain("Mertoniemi");
    expect(html).not.toContain("user-a@example.com");
    expect(html).toContain("Sign out");
    expect(html).toContain("Liked");
    expect(html).toContain('aria-current="page"');
  });

  it("omits the identity label when no display name is available", () => {
    const html = renderToStaticMarkup(createElement(AppHeader, {}));
    expect(html).not.toContain("@example.com");
    expect(html).toContain("Sign out");
  });

  it("loads and renders the first feed page with a refresh control", async () => {
    rpc.mockResolvedValueOnce({
      data: [
        {
          id: "item-1",
          url: "https://publisher.example/story",
          title: "A useful article",
          summary: "A short summary",
          summary_origin: "feed",
          type: "article",
          language: "en",
          thumbnail_url: "https://publisher.example/image.jpg",
          published_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          source_name: "Example News",
          score: 0.9,
          reason: "similar",
          because_item_id: "liked-1",
          because_title: "A liked article",
        },
      ],
      error: null,
    });

    const html = renderToStaticMarkup(
      await Home({ searchParams: Promise.resolve({}) }),
    );

    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_feed", { p_limit: 30 });
    expect(html).toContain("A useful article");
    expect(html).toContain("Example News");
    expect(html).toContain("1 hour ago");
    expect(html).toContain("A short summary");
    expect(html).toContain("Similar to A liked article, which you liked");
    expect(html).toContain('href="https://publisher.example/story"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('action="/" method="get"');
    expect(html).toContain("Refresh feed");
  });

  it.each([
    { origin: "ai_generated", visible: true },
    { origin: "feed", visible: false },
    { origin: "page_metadata", visible: false },
  ])(
    "shows the AI summary badge only for $origin provenance",
    async ({ origin, visible }) => {
      rpc.mockResolvedValueOnce({
        data: [
          {
            id: "item-provenance",
            url: "https://publisher.example/story",
            title: "A useful article",
            summary: "A short summary",
            summary_origin: origin,
            type: "article",
            language: "en",
            thumbnail_url: null,
            published_at: new Date().toISOString(),
            source_name: "Example News",
            score: 0.9,
            reason: "recent",
            because_item_id: null,
            because_title: null,
          },
        ],
        error: null,
      });

      const html = renderToStaticMarkup(
        await Home({ searchParams: Promise.resolve({}) }),
      );

      expect(html.includes("AI summary")).toBe(visible);
    },
  );

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { ...verifiedClaims, error: new Error("Unverified claims") },
  ])(
    "rejects missing or unverified identity independently of proxy",
    async (result) => {
      auth.getClaims.mockResolvedValueOnce(result);
      await expect(Home({ searchParams: Promise.resolve({}) })).rejects.toThrow(
        "REDIRECT:/login",
      );
    },
  );

  it("shows a retry message when sign-out fails", async () => {
    const html = renderToStaticMarkup(
      await Home({ searchParams: Promise.resolve({ error: "sign-out" }) }),
    );
    expect(html).toContain("Sign-out failed. Please try again.");
  });
});

describe("login page", () => {
  it("links to the public privacy policy", async () => {
    const html = renderToStaticMarkup(
      await Login({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("Privacy policy");
  });

  it("offers Google as the only sign-in method outside local development", async () => {
    const html = renderToStaticMarkup(
      await Login({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("Sign in with Google");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('type="password"');
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "also offers email/password in development with %s Supabase",
    async (hostname) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://${hostname}:55321`);
      const html = renderToStaticMarkup(
        await Login({ searchParams: Promise.resolve({}) }),
      );
      expect(html).toContain("Sign in with Google");
      expect(html).toContain("Local sign-in");
      expect(html.match(/<button/g)).toHaveLength(2);
    },
  );

  it("renders the local email/password form fields", () => {
    const html = renderToStaticMarkup(createElement(PasswordSignInForm));
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain("Sign in with email");
  });

  it.each([
    ["production", "http://127.0.0.1:55321"],
    ["development", "https://project.supabase.co"],
    ["development", "http://localhost.evil.example:55321"],
    ["development", "not a URL"],
    ["development", ""],
  ])("hides password login in %s with %s", async (mode, url) => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
    const html = renderToStaticMarkup(
      await Login({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain('type="password"');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("displays a generic callback error rather than provider details", async () => {
    const html = renderToStaticMarkup(
      await Login({ searchParams: Promise.resolve({ error: "callback" }) }),
    );
    expect(html).toContain("Sign-in could not be completed. Please try again.");
  });
});

describe("privacy page", () => {
  it("renders the policy and contact without loading user data", () => {
    const html = renderToStaticMarkup(createElement(PrivacyPage));
    expect(privacyMetadata.title).toBe("Privacy Policy | Poimio");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Joni Mertoniemi");
    expect(html).toContain('href="mailto:privacy@poimio.cc"');
    expect(html).toContain(
      "We keep your account and feedback until you request deletion.",
    );
    expect(html).toContain("OpenAI");
    expect(html).toContain("Supabase");
    expect(html).toContain("Vercel");
    expect(html).toContain('href="/login"');
    expect(createClient).not.toHaveBeenCalled();
    expect(auth.getClaims).not.toHaveBeenCalled();
  });
});

describe("local password sign-in action", () => {
  function credentials() {
    const formData = new FormData();
    formData.set("email", " user-a@example.com ");
    formData.set("password", " local-password ");
    return formData;
  }

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:55321");
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "signs in against %s, verifies claims, then redirects home",
    async (hostname) => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://${hostname}:55321`);
      await expect(signInWithPassword(null, credentials())).rejects.toThrow(
        "REDIRECT:/",
      );
      expect(auth.signInWithPassword).toHaveBeenCalledExactlyOnceWith({
        email: "user-a@example.com",
        password: " local-password ",
      });
      expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith();
      expect(auth.signInWithPassword.mock.invocationCallOrder[0]).toBeLessThan(
        auth.getClaims.mock.invocationCallOrder[0],
      );
    },
  );

  it.each([
    ["production", "http://127.0.0.1:55321"],
    ["test", "http://127.0.0.1:55321"],
    ["development", "https://project.supabase.co"],
    ["development", "http://localhost.evil.example:55321"],
    ["development", "http://localhost@evil.example:55321"],
    ["development", "ftp://localhost:55321"],
    ["development", "not a URL"],
    ["development", ""],
  ])("rejects %s with %s before creating a client", async (mode, url) => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
    expect(await signInWithPassword(null, credentials())).toBe(
      "Password sign-in is unavailable.",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    ["email", ""],
    ["email", "invalid"],
    ["email", `${"a".repeat(255)}@example.com`],
    ["password", ""],
    ["password", "a".repeat(4097)],
    ["email", new File(["email"], "email.txt")],
    ["password", new File(["password"], "password.txt")],
  ])("rejects invalid %s without contacting auth", async (field, value) => {
    const formData = credentials();
    formData.set(field, value);
    expect(await signInWithPassword(null, formData)).toBe(
      "Enter a valid email address and password.",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects missing credentials", async () => {
    expect(await signInWithPassword(null, new FormData())).toBe(
      "Enter a valid email address and password.",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("does not expose provider errors or verify a failed sign-in", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({
      error: new Error("Private provider details"),
    });
    expect(await signInWithPassword(null, credentials())).toBe(
      "Sign-in failed. Check your email and password and try again.",
    );
    expect(auth.getClaims).not.toHaveBeenCalled();
  });

  it("handles auth connection failures without exposing details", async () => {
    auth.signInWithPassword.mockRejectedValueOnce(new Error("Private details"));
    expect(await signInWithPassword(null, credentials())).toBe(
      "Sign-in failed. Check your email and password and try again.",
    );
  });

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { ...verifiedClaims, error: new Error("Invalid signature") },
  ])("clears the session when claims cannot be verified", async (result) => {
    auth.getClaims.mockResolvedValueOnce(result);
    expect(await signInWithPassword(null, credentials())).toBe(
      "Sign-in failed. Check your email and password and try again.",
    );
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });
});

describe("sign-out action", () => {
  it("verifies identity, signs out the current session, then redirects to login", async () => {
    await expect(signOut()).rejects.toThrow("REDIRECT:/login");
    expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith();
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(auth.getClaims.mock.invocationCallOrder[0]).toBeLessThan(
      auth.signOut.mock.invocationCallOrder[0],
    );
  });

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { ...verifiedClaims, error: new Error("Invalid signature") },
  ])(
    "does not mutate auth when identity verification fails",
    async (result) => {
      auth.getClaims.mockResolvedValueOnce(result);
      await expect(signOut()).rejects.toThrow("REDIRECT:/login");
      expect(auth.signOut).not.toHaveBeenCalled();
    },
  );

  it("returns to the signed-in page with a generic error if sign-out fails", async () => {
    auth.signOut.mockResolvedValueOnce({ error: new Error("Provider error") });
    await expect(signOut()).rejects.toThrow("REDIRECT:/?error=sign-out");
  });
});

describe("OAuth callback", () => {
  it("exchanges the code and independently verifies claims before returning home", async () => {
    const response = await GET(
      new Request("http://localhost:3001/auth/callback?code=valid-code"),
    );
    expect(auth.exchangeCodeForSession).toHaveBeenCalledExactlyOnceWith(
      "valid-code",
    );
    expect(auth.getClaims).toHaveBeenCalledExactlyOnceWith();
    expect(
      auth.exchangeCodeForSession.mock.invocationCallOrder[0],
    ).toBeLessThan(auth.getClaims.mock.invocationCallOrder[0]);
    expect(response.headers.get("location")).toBe("http://localhost:3001/");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([
    "",
    "?error=access_denied&error_description=private",
    "?code=code&error=access_denied",
  ])("rejects missing codes and OAuth errors: %s", async (query) => {
    const response = await GET(
      new Request(`http://localhost:3001/auth/callback${query}`),
    );
    expect(response.headers.get("location")).toBe(
      "http://localhost:3001/login?error=callback",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an invalid or expired exchange without trusting claims", async () => {
    auth.exchangeCodeForSession.mockResolvedValueOnce({
      error: new Error("Expired code"),
    });
    const response = await GET(
      new Request("http://localhost:3001/auth/callback?code=expired"),
    );
    expect(response.headers.get("location")).toBe(
      "http://localhost:3001/login?error=callback",
    );
    expect(auth.getClaims).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: { claims: {} }, error: null },
    { ...verifiedClaims, error: new Error("Invalid signature") },
  ])(
    "rejects the callback if the exchanged identity cannot be verified",
    async (result) => {
      auth.getClaims.mockResolvedValueOnce(result);
      const response = await GET(
        new Request("http://localhost:3001/auth/callback?code=code"),
      );
      expect(response.headers.get("location")).toBe(
        "http://localhost:3001/login?error=callback",
      );
    },
  );

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/another-page",
  ])("ignores next redirect target %s and forwarded hosts", async (next) => {
    const url = new URL("http://localhost:3001/auth/callback?code=code");
    url.searchParams.set("next", next);
    const response = await GET(
      new Request(url, { headers: { "x-forwarded-host": "evil.example" } }),
    );
    expect(response.headers.get("location")).toBe("http://localhost:3001/");
  });
});
