# 015 — Search discovery and trust pages

**Status:** Implemented and verified locally

Follow-up to [spec 014](014-agent-readiness.md) after the live Ora audit reached 94/100. Use the existing canonical www hostname and the existing public access boundary.

## Tasks and acceptance criteria

- [x] 1. Keep the established product term and put Poimio alongside it in the visible homepage heading. Verify the canonical URL and current redirect. Search rank is a post-release check.
- [x] 2. Publish a protocol-compliant `/sitemap.xml` with the four indexable HTML URLs and meaningful last-modified dates. Advertise it in `/robots.txt`.
- [x] 3. Retain SoftwareApplication JSON-LD and identify the confirmed individual operator with Person and a privacy ContactPoint. The operator confirmed there is no organization. A business address and Organization markup are out of scope.
- [x] 4. Supply Open Graph website metadata and an absolute URL to the existing branded PNG. Preserve the canonical link and English document language.
- [x] 5. Publish linked About and Contact pages using the Privacy page's visual layout. Each trust page has at least 500 characters of meaningful visible content and works without sign-in. Link them from the HTML and Markdown homepages and the agent guide.
- [x] 6. Run lint, typecheck, tests, a production build, and local HTTP checks of all affected routes and machine-readable content.

## Release verification

- [ ] Submit the canonical sitemap with verified Search Console access, inspect homepage indexing, and rerun the Ora audit after recrawl.
