import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AboutPage, {
  metadata as aboutMetadata,
  ensureStatic as aboutStatic,
} from "./(app)/about/page";
import ContactPage, {
  metadata as contactMetadata,
  ensureStatic as contactStatic,
} from "./(app)/contact/page";
import PrivacyPage, {
  metadata as privacyMetadata,
  ensureStatic as privacyStatic,
} from "./(app)/privacy/page";
import robots from "./robots";
import sitemap from "./sitemap";

describe("public trust pages and crawler metadata", () => {
  it("requires static shells for public information pages", () => {
    expect([aboutStatic, contactStatic, privacyStatic]).toEqual(["shell", "shell", "shell"]);
  });

  it.each([
    ["about", AboutPage, aboutMetadata, "About Poimio"],
    ["contact", ContactPage, contactMetadata, "Contact Poimio"],
    ["privacy", PrivacyPage, privacyMetadata, "Privacy Policy"],
  ])("publishes substantive content and a canonical URL for /%s", (path, Page, metadata, title) => {
    const html = renderToStaticMarkup(<Page />);
    const article = html.match(/<article[^>]*>(.*?)<\/article>/)?.[1] ?? "";
    expect(
      article
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim().length,
    ).toBeGreaterThanOrEqual(500);
    expect(html).toContain(title);
    expect(html).toContain("Joni Mertoniemi");
    expect(metadata.alternates?.canonical).toBe(`https://www.poimio.cc/${path}`);
  });

  it("points public reports and private requests to their respective channels", () => {
    const html = renderToStaticMarkup(<ContactPage />);
    expect(html).toContain('href="https://github.com/jonime/poimio/issues"');
    expect(html).toContain('href="mailto:privacy@poimio.cc"');
    expect(html).toContain('href="/privacy"');
  });

  it("lists the canonical public pages and their revision dates", () => {
    expect(sitemap()).toEqual([
      { url: "https://www.poimio.cc/", lastModified: "2026-11-06" },
      { url: "https://www.poimio.cc/about", lastModified: "2026-11-06" },
      { url: "https://www.poimio.cc/contact", lastModified: "2026-11-06" },
      { url: "https://www.poimio.cc/privacy", lastModified: "2026-10-31" },
    ]);
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: "https://www.poimio.cc/sitemap.xml",
    });
  });
});
