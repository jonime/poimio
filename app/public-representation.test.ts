import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { preferredRepresentation } from "@/lib/public-representation";
import { proxy } from "../proxy";
import { GET, HEAD } from "./[...missing]/route";

describe("public HTTP representations", () => {
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

  it.each(["text/markdown", "text/html"])(
    "returns 404 for missing paths with %s",
    async (accept) => {
      const response = GET(
        new Request("https://www.poimio.cc/unknown/nested.png", { headers: { accept } }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe(`${accept}; charset=utf-8`);
      expect(response.headers.get("vary")).toBe("Accept");
      const body = await response.text();
      expect(body).toContain("The requested resource could not be found on Poimio.");
      if (accept === "text/markdown") expect(body).toContain("](/llms.txt)");
    },
  );

  it("returns a bodyless Markdown 404 to HEAD requests", async () => {
    const response = HEAD(
      new Request("https://www.poimio.cc/unknown", {
        method: "HEAD",
        headers: { accept: "text/markdown" },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe("");
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
