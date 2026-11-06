import { markdown, preferredRepresentation } from "@/lib/public-representation";

const explanation = "The requested resource could not be found on Poimio.";

export function GET(request: Request) {
  const wantsMarkdown = preferredRepresentation(request.headers.get("accept")) === markdown;
  const body = wantsMarkdown
    ? `# 404 — Page not found\n\n${explanation}\n\nSee the [Poimio guide for agents](/llms.txt).\n`
    : `<!doctype html><html lang="en"><meta charset="utf-8"><title>404 | Poimio</title><main><h1>Page not found</h1><p>${explanation}</p><a href="/">Return to Poimio</a></main></html>`;

  return new Response(request.method === "HEAD" ? null : body, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": `${wantsMarkdown ? markdown : "text/html"}; charset=utf-8`,
      Vary: "Accept",
    },
  });
}

export { GET as HEAD, GET as POST, GET as PUT, GET as PATCH, GET as DELETE, GET as OPTIONS };
