import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { homeMarkdown, siteUrl } from "./lib/public-home";
import { markdown, preferredRepresentation } from "./lib/public-representation";
import { requireDefined } from "./lib/required.ts";

export const sessionRoutes = new Set([
  "/",
  "/login",
  "/about",
  "/contact",
  "/privacy",
  "/auth/callback",
  "/liked",
]);

export const otherRoutes = new Set([
  "/api/scheduled-ingestion",
  "/robots.txt",
  "/sitemap.xml",
  "/full.png",
  "/icon.png",
  "/llms.txt",
]);

const notFoundMarkdown = `# Page not found

Poimio has no page at this URL.

[Agent guidance](${siteUrl}llms.txt)
`;

function isKnownPath(pathname: string) {
  if (sessionRoutes.has(pathname) || otherRoutes.has(pathname)) return true;
  try {
    const decoded = decodeURIComponent(pathname);
    return sessionRoutes.has(decoded) || otherRoutes.has(decoded);
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isHome = pathname === "/";
  const refreshSession = sessionRoutes.has(pathname);
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    !request.headers.has("rsc") &&
    (isHome || !isKnownPath(pathname))
  ) {
    const representation = preferredRepresentation(request.headers.get("accept"));
    if (representation === markdown || (isHome && representation === null)) {
      const body = isHome ? homeMarkdown : notFoundMarkdown;
      return new NextResponse(
        representation === markdown && request.method === "GET" ? body : null,
        {
          status: isHome ? (representation === markdown ? 200 : 406) : 404,
          headers: {
            "Cache-Control": "no-store",
            ...(representation === markdown && { "Content-Type": `${markdown}; charset=utf-8` }),
            Vary: "Accept, RSC",
          },
        },
      );
    }
  }
  if (!refreshSession) return NextResponse.next();

  const authStart = performance.now();
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    requireDefined(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireDefined(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request, headers: response.headers });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [name, value] of Object.entries(headers)) {
            response.headers.set(name, value);
          }
        },
      },
    },
  );

  const { data, error } = await supabase.auth.getClaims();
  if (process.env.VERCEL === "1" && isHome) {
    console.info("home_proxy_auth_ms", Math.round(performance.now() - authStart));
  }
  if (pathname === "/liked" && (error || !data?.claims?.sub)) {
    const redirectResponse = NextResponse.redirect(new URL("/", request.url));
    for (const cookie of response.cookies.getAll()) {
      redirectResponse.cookies.set(cookie);
    }
    redirectResponse.headers.set("Cache-Control", "private, no-store");
    return redirectResponse;
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next(?:/|$)|_vercel(?:/|$)).*)"],
};
