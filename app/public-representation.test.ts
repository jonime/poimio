import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Route } from "next";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { preferredRepresentation } from "@/lib/public-representation";
import { otherRoutes, proxy, sessionRoutes } from "../proxy";

// @ts-expect-error Unknown internal routes must not be accepted by typedRoutes.
const invalidRoute: Route<"/misspelled-page"> = "/misspelled-page";

describe("public HTTP representations", () => {
  it("rejects unknown internal routes at typecheck time", () => {
    expect(invalidRoute).toBe("/misspelled-page");
  });

  it.each([
    [null, "text/html"],
    ["*/*", "text/html"],
    ["text/*", "text/html"],
    ["TEXT/MARKDOWN; charset=UTF-8", "text/markdown"],
    ["text/html;q=0.1, text/markdown;q=0.9", "text/markdown"],
    ["text/html, text/markdown;q=0.9", "text/html"],
    ["text/markdown;q=0, text/*", "text/html"],
    ["text/html;q=0, text/*;q=0.4", "text/markdown"],
    ["text/markdown;variant=other", null],
    ["application/json", null],
  ])("negotiates %s as %s", (accept, type) => {
    expect(preferredRepresentation(accept)).toBe(type);
  });

  it.each(["GET", "HEAD"])("serves the public Markdown homepage for %s", async (method) => {
    const response = await proxy(
      new NextRequest("https://www.poimio.cc/", {
        method,
        headers: { accept: "text/markdown", cookie: "sb-session=private" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    const body = await response.text();
    if (method === "GET") {
      expect(body).toContain("# Poimio");
      expect(body).toContain("https://www.poimio.cc/llms.txt");
      expect(body).toContain("https://www.poimio.cc/about");
      expect(body).toContain("https://www.poimio.cc/contact");
    } else {
      expect(body).toBe("");
    }
  });

  it("returns 406 when neither homepage representation is acceptable", async () => {
    const response = await proxy(
      new NextRequest("https://www.poimio.cc/", {
        headers: { accept: "application/json" },
      }),
    );
    expect(response.status).toBe(406);
    expect(response.headers.get("vary")).toContain("Accept");
  });

  it.each([
    ["GET", "/misspelled-page", "text/markdown"],
    ["GET", "/privacy/missing?from=agent", "text/html;q=0.2, text/markdown;q=0.9"],
    ["GET", "/missing.png", "text/markdown"],
    ["HEAD", "/missing.txt", "text/markdown"],
  ])("returns a Markdown 404 for %s %s with Accept %s", async (method, path, accept) => {
    const response = await proxy(
      new NextRequest(`https://www.poimio.cc${path}`, { method, headers: { accept } }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")).toBe("Accept, RSC");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    const body = await response.text();
    if (method === "HEAD") {
      expect(body).toBe("");
    } else {
      expect(body).toMatch(/^# Page not found\n\nPoimio has no page at this URL\./);
      expect(body).toContain("[Agent guidance](https://www.poimio.cc/llms.txt)");
    }
  });

  it.each([
    ["GET", "text/html", false],
    ["GET", "text/markdown;q=0.1, text/html;q=0.9", false],
    ["GET", "text/markdown;q=0, text/*", false],
    ["GET", "text/markdown;q=0", false],
    ["GET", "application/json", false],
    ["GET", "text/markdown", true],
    ["POST", "text/markdown", false],
  ])("lets Next.js handle an unknown %s with Accept %s and RSC=%s", async (method, accept, rsc) => {
    const headers = new Headers({ accept });
    if (rsc) headers.set("rsc", "1");
    const response = await proxy(
      new NextRequest("https://www.poimio.cc/missing", { method, headers }),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("inventories the app routes, metadata routes, and public files", () => {
    function filesIn(directory: URL) {
      const root = fileURLToPath(directory);
      return readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"));
    }

    const appPaths = filesIn(new URL(".", import.meta.url)).flatMap((file) => {
      const segments = file.split("/");
      const name = segments.pop() ?? "";
      if (segments.some((segment) => segment.startsWith("_"))) return [];
      const path = segments.filter((segment) => !/^\(.*\)$|^@/.test(segment));
      const sourceExtension = /\.(?:[jt]sx?|mdx?)$/;
      const stem = name.replace(sourceExtension, "");
      if (sourceExtension.test(name) && (stem === "page" || stem === "route")) {
        return [`/${path.join("/")}`];
      }
      const metadata = {
        robots: "robots.txt",
        sitemap: "sitemap.xml",
        manifest: "manifest.webmanifest",
      };
      if (Object.hasOwn(metadata, stem)) {
        return [`/${[...path, metadata[stem as keyof typeof metadata]].join("/")}`];
      }
      if (
        /^(?:robots\.txt|sitemap\.xml|manifest\.(?:json|webmanifest)|favicon\.ico)$/.test(name) ||
        /^(?:icon|apple-icon|opengraph-image|twitter-image)\d*\.(?:[jt]sx?|ico|jpe?g|png|svg|gif|webp)$/.test(
          name,
        )
      ) {
        return [`/${[...path, name].join("/")}`];
      }
      return [];
    });
    const publicPaths = filesIn(new URL("../public/", import.meta.url)).map((file) => `/${file}`);
    expect([...sessionRoutes, ...otherRoutes].sort()).toEqual(
      [...new Set([...appPaths, ...publicPaths])].sort(),
    );
  });

  it("publishes agent use cases as llms.txt file-list entries", () => {
    const file = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
    expect(file).toMatch(/^# Poimio\n\n> .+\n/);
    const [, useCases = ""] = file.split("## When to use Poimio\n\n");
    const entries = (useCases.split("\n\n")[0] ?? "").split("\n");
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry).toMatch(/^- \[[^\]]+\]\(https:\/\/www\.poimio\.cc\/\): /);
    }
    expect(useCases).toContain("Accept: text/markdown");
    expect(useCases).toContain("Accept: text/html");
    expect(useCases).toContain("sign in with Google");
    expect(file).toContain("[About Poimio](https://www.poimio.cc/about)");
    expect(file).toContain("[Contact](https://www.poimio.cc/contact)");
  });
});
