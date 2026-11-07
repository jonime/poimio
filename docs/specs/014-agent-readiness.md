# 014 — Agent readiness

**Status:** Done

The [public guest homepage](008-guest-feed-preview.md) should identify Poimio as a content discovery app and explain how to use it through machine-readable responses. The existing [app access rules](004-deployment-access.md) apply to the personalized feed and saved items.

## Acceptance criteria and tasks

- [x] 1. Unknown paths return HTTP 404. Markdown requests receive an explanation and a link to `/llms.txt`. Existing protected routes retain their authentication checks.
- [x] 2. The homepage negotiates HTML and Markdown for GET and HEAD, honors Accept preferences, and includes Accept in Vary on Markdown responses. Markdown describes the public product and its access requirements without reading account data. Next.js navigation and form submissions retain their existing behavior.
- [x] 3. The homepage title, canonical URL and visible heading identify Poimio as a content discovery app.
- [x] 4. The homepage HTML contains Schema.org SoftwareApplication JSON-LD using the same product identity.
- [x] 5. The public `/llms.txt` explains when to use Poimio, how to read the guest preview and where sign-in is required. Verify the public responses with HTTP requests and run lint, typecheck and tests.

## Scope

The Markdown homepage is a public product overview. It points to the live guest preview in HTML. Production deployment uses the existing release workflow.

The canonical hostname is `www.poimio.cc`, the destination of the live apex redirect. Next.js sets its own Vary header on the HTML page and serves that response with `Cache-Control: private, no-cache, no-store`. The Markdown response also uses `no-store`.

## Release verification

- [x] Recheck the public responses after deployment and rerun the Ora audit once the homepage has been recrawled.
