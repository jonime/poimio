# 014 — Agent readiness

**Status:** Follow-up verified locally. Release checks pending.

The [public guest homepage](008-guest-feed-preview.md) should identify Poimio as a content discovery app and explain how to use it through machine-readable responses. The existing [app access rules](004-deployment-access.md) apply to the personalized feed and saved items.

## Acceptance criteria and tasks

- [x] 1. Unknown paths return HTTP 404 using Next.js's standard response. Existing protected routes retain their authentication checks. The user approved removing Markdown-specific 404 responses on 7 Nov 2026 to enable meaningful typed-route checks.
- [x] 2. The homepage negotiates HTML and Markdown for GET and HEAD, honors Accept preferences, and includes Accept in Vary on Markdown responses. Markdown describes the public product and its access requirements without reading account data. Next.js navigation and form submissions retain their existing behavior.
- [x] 3. The homepage title, canonical URL and visible heading identify Poimio as a content discovery app.
- [x] 4. The homepage HTML contains Schema.org SoftwareApplication JSON-LD using the same product identity.
- [x] 5. The public `/llms.txt` explains when to use Poimio, how to read the guest preview and where sign-in is required. Verify the public responses with HTTP requests and run lint, typecheck and tests.
- [x] 6. Supersede task 1's standard-404-only decision. In the proxy, serve a Markdown 404 for unknown GET and HEAD paths that prefer Markdown. Include the canonical agent guide link in the GET body. Preserve framework responses for other requests and keep session refresh scoped to its existing routes. Keep typed routes and the invalid-route typecheck regression. Check the route and public-file inventory against the filesystem.
- [x] 7. Verify the existing Poimio title, visible heading, canonical hostname and SoftwareApplication keywords agree. Retain the sitemap dates. Run lint, typecheck, tests, a production build and local HTTP checks.

## Scope

The Markdown homepage is a public product overview. It points to the live guest preview in HTML. Production deployment uses the existing release workflow.

The canonical hostname is `www.poimio.cc`, the destination of the live apex redirect. Next.js sets its own Vary header on the HTML page and serves that response with `Cache-Control: private, no-cache, no-store`. The Markdown response also uses `no-store`.

## Release verification

- [x] Recheck the public responses after deployment and rerun the Ora audit once the homepage has been recrawled.
- [ ] After the follow-up ships, follow redirects from the apex and www hosts and verify the final unknown-URL status, Markdown content type and explanatory body. Verify the scheduled-ingestion endpoint's protection without triggering ingestion.
- [ ] Fetch the Is Agentic report for the exact Poimio scan target and confirm its timestamp is newer before reporting a score change.
- [ ] After a fresh crawl, check whether Google sees the declared canonical and associates the homepage with the submitted sitemap. On 9 Nov 2026, Search Console confirmed that the www homepage was indexed and that Google selected it as canonical. The indexed snapshot was crawled on 31 Oct and showed no declared canonical or referring sitemap. For ranking follow-up, track queries and seek relevant editorial backlinks. Ranking is measured separately from metadata verification.
