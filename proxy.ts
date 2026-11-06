import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { homeMarkdown } from "./lib/public-home";
import { markdown, preferredRepresentation } from "./lib/public-representation";
import { requireDefined } from "./lib/required.ts";

export async function proxy(request: NextRequest) {
  const isHome = request.nextUrl.pathname === "/";
  if (
    isHome &&
    (request.method === "GET" || request.method === "HEAD") &&
    !request.headers.has("rsc")
  ) {
    const representation = preferredRepresentation(request.headers.get("accept"));
    if (representation === markdown || representation === null) {
      return new NextResponse(
        representation === markdown && request.method === "GET" ? homeMarkdown : null,
        {
          status: representation === markdown ? 200 : 406,
          headers: {
            "Cache-Control": "no-store",
            ...(representation === markdown && { "Content-Type": `${markdown}; charset=utf-8` }),
            Vary: "Accept, RSC",
          },
        },
      );
    }
  }
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
  if (process.env.VERCEL === "1" && request.nextUrl.pathname === "/") {
    console.info("home_proxy_auth_ms", Math.round(performance.now() - authStart));
  }
  if (request.nextUrl.pathname === "/liked" && (error || !data?.claims?.sub)) {
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
  matcher: ["/", "/login", "/privacy", "/auth/callback", "/liked"],
};
