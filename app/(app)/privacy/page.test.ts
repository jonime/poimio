import { JSDOM } from "jsdom";
import { renderToReadableStream } from "react-dom/server";
import { expect, it } from "vitest";
import PrivacyPage from "./page";

it("describes the aggregate scoring and admin fallback used by catalog discovery", async () => {
  const stream = await renderToReadableStream(PrivacyPage());
  await stream.allReady;
  const dom = new JSDOM(await new Response(stream).text());
  const text = dom.window.document.body.textContent ?? "";

  expect(text).toContain("at least three users can be scored");
  expect(text).toContain("only the scanning administrator's own likes are used");
  expect(text).toContain("Only coarse aggregate scores are stored");
  expect(text).toContain("Candidates contain no personal data");
  dom.window.close();
});
