# 015 — Search discovery and trust pages

**Status:** Done

Follow-up to [spec 014](014-agent-readiness.md) after the live Ora audit reached 94/100. Use the existing canonical www hostname and the existing public access boundary.

## Tasks and acceptance criteria

- [x] 1. Keep the established product term and put Poimio alongside it in the visible homepage heading. Verify the canonical URL and current redirect. Search rank is a post-release check.
- [x] 2. Publish a protocol-compliant `/sitemap.xml` with the four indexable HTML URLs and meaningful last-modified dates. Advertise it in `/robots.txt`.
- [x] 3. Retain SoftwareApplication JSON-LD and identify the confirmed individual operator with Person and a privacy ContactPoint. The operator confirmed there is no organization. A business address and Organization markup are out of scope.
- [x] 4. Supply Open Graph website metadata and an absolute URL to the existing branded PNG. Preserve the canonical link and English document language.
- [x] 5. Publish linked About and Contact pages using the Privacy page's visual layout. Each trust page has at least 500 characters of meaningful visible content and works without sign-in. Link them from the HTML and Markdown homepages and the agent guide.
- [x] 6. Run lint, typecheck, tests, a production build, and local HTTP checks of all affected routes and machine-readable content.
- [x] 7. Add a More menu to the shared signed-in header on Feed and Liked. Link to About, Contact, Privacy policy, and GitHub. Verify keyboard access, narrow-screen layout, and all four destinations. Run lint, typecheck, and tests.
- [x] 8. Give About, Contact, and Privacy policy a shared layout with the app header for signed-in users and a Poimio logo and Home link for guests. Remove the Back to Poimio footer. Verify both views on all three public URLs and run lint, typecheck, and tests.
- [x] 9. Require static app shells for the three public pages while retaining their request-time verified headers. Next.js's shell setting does not enforce full static navigation or add build-time validation.
- [x] 10. Show the shared More menu next to Home for guests on About, Contact, and Privacy policy. Keep the same four destinations as the signed-in menu.

## Release verification

- [x] Verify the live audit result. Poimio scored **100/100** on 6 November 2026. [Is Agentic scan](https://is-agentic.com/scan/poimio.cc)
- [x] Submit the canonical sitemap with verified Search Console access and inspect homepage indexing.
