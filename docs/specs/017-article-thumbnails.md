# 017 — Article thumbnail quality and coverage

- **Status:** Approved
- **Milestone:** Final
- **Depends on:** [001 — Ingestion](001-ingestion.md), [005 — Description enrichment](005-description-enrichment.md), [008 — Guest feed preview](008-guest-feed-preview.md)

## Goal

Show sharper article images and recover missing thumbnails when the publisher offers a suitable preview image. Articles should still appear when there is no usable image.

## Context

The ingestion parser takes the first `media:thumbnail`, and the feed card displays it at full card width. On 7 November 2026, the BBC World RSS item about strikes on Ukraine's power network provided a single 240 × 135 image that Poimio displayed at 640 px wide. The BBC article offered the same photo at 800 and 976 px in its responsive image markup and a branded 1200 px social preview. [BBC World RSS](https://feeds.bbci.co.uk/news/world/rss.xml) · [BBC article](https://www.bbc.co.uk/news/articles/cm4g1nq8158po)

The Yle skeet story above it had no image in Poimio, although the linked page advertised a 1200 × 628 social preview. That page is a sports roundup, so the page-level preview may depict a different story. Use it as a fixture for rejecting roundup images alongside a standalone article fixture for successful recovery. [Yle roundup](https://yle.fi/a/74-20255658)

## In scope

- Prefer a suitably sized image already present in RSS or Atom.
- For approved publishers, check the article page when the feed image is missing or explicitly too small.
- Save the chosen URL in the existing `content_items.thumbnail_url` field. Provide a bounded backfill for recent articles already in Poimio.

## Out of scope

- Video and YouTube thumbnails, image generation, image storage or proxying, arbitrary body image scraping, and fetching publisher pages when rendering a card.
- Changes to summaries, embeddings, ranking, or the guest preview access rules.

## Design notes

- Consider item-level Media RSS thumbnails and explicitly typed image media or enclosures. For article images with declared dimensions, use 640 px wide as the initial minimum, matching the observed desktop card. If multiple variants of the same image qualify, prefer the smallest variant at least 960 px wide, otherwise use the largest qualifying variant. Keep the publisher's order between different images. Preserve an existing feed thumbnail with unknown dimensions when no known suitable alternative is available. Ignore channel logos and non-image enclosures. RSS has no standard request parameter for thumbnail size. [Media RSS specification](https://www.rssboard.org/media-rss#media-thumbnails)
- For a missing or known undersized image, use the linked page's `og:image` only for an approved publisher and a standalone article. Reject known site logos, generic defaults, roundup images and candidates known to be below the minimum. A publisher rule may use declared metadata dimensions or a documented size in its image URL. Require a confirmed minimum width for a replacement. A rule may also select a larger publisher-advertised variant of the same feed photo when the publisher approves that use. Keep the source and image host rules explicit. An unverified source may keep its existing RSS behavior. The BBC syndication documentation says rights can differ for larger images, so a working URL alone is insufficient for enabling that rule. [BBC syndication documentation](https://information-syndication.api.bbc.com/)
- Do the lookup in scheduled ingestion for newly inserted articles, including those with complete feed descriptions. Reuse HTML already fetched for description enrichment in that run. Use the existing safe page fetcher and its timeout, response size, redirect and concurrency limits. Require the final article host and HTTPS image host to match the approved publisher rule. Reject credentials in URLs and validate redirects before connecting. Resolve relative metadata URLs against the final article URL. Store the URL only. See [design.md, security rules](../design.md#51-data-access-and-security).
- Cap additional page lookups at 20 per run and process newest candidates first. A failed lookup must leave ingestion and article visibility intact. For an approved source with only a known undersized thumbnail, omit the large image if there is no suitable replacement. An exhausted lookup budget or transient failure is not a negative result for a stored thumbnail.
- Provide an explicit backfill for articles published in the past seven days, newest first, capped at 20 candidates per invocation. Report a continuation cursor ordered by publication time and item ID so unresolved items cannot prevent older candidates from being checked. Select missing thumbnails and legacy undersized thumbnails identifiable from the stored URL by an approved publisher rule. Dry run reports candidates without fetching or writing. Skip rows with an already suitable image, and update only if the stored thumbnail still matches the value read at selection. Successful upgrades leave the selection on rerun. Report found, upgraded, omitted, and fetch-failure counts. Use the local environment by default.

## Acceptance criteria

1. A feed fixture with multiple sizes selects the suitable variant without a page fetch. Known small feed images trigger fallback for approved sources. Feeds that provide only a thumbnail with unknown dimensions and YouTube feeds retain their existing behavior.
2. With fixture publisher rules enabled, the BBC example selects a larger publisher-advertised version of the same photo. A standalone NASA release without a feed image acquires its eligible preview image. The Yle roundup fixture, a generic logo, an unapproved image host, and an undersized preview all fail to supply a replacement. The live fallback configuration selects only NASA News Releases and excludes APOD, third-party images, and images with unclear ownership.
3. When a page is unavailable, unsafe, or over budget, the article remains eligible for the feed. Page lookups respect the budget, reuse HTML already fetched in the run, and never happen during card rendering.
4. On local Supabase, backfill dry run leaves rows intact. A write run fills a missing image and upgrades a legacy small one, a rerun skips successful upgrades, and continuation reaches older candidates even when the first batch contains unresolved items. A simulated concurrent update keeps the newer thumbnail. Changes to stored images leave article descriptions, embeddings and existing public access rules intact.
5. In the guest preview and signed-in feed, an upgraded image renders at card width and an article without a suitable image still renders. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass, along with the local integration checks for backfill.

## Tasks

- [ ] 1. Sample recent NASA News Releases to verify usable preview images, reliable ownership and size signals, and exact article and image hosts. Document the pilot rule and attribution. Save representative feed and page fixtures for small, missing, valid and generic images.
- [ ] 2. Select suitable feed variants and add bounded article-page fallback to scheduled ingestion. Verify selection and failure behavior with fixtures.
- [ ] 3. Add the bounded backfill and verify persistence, reruns and concurrent updates on local Supabase.
- [ ] 4. Verify the guest and signed-in cards with local data and run the required checks.

## Decisions

- **NASA News Releases** is the only initial live pilot for article-page fallback and backfill. Use clearly NASA-owned images, credit NASA, and skip APOD entries and images with third-party or unclear ownership. Enable the rule once task 1 verifies that recent releases provide enough information to apply it reliably. [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)
- **BBC World News** is a fixture for upgrading an undersized feed image. Live article image upgrades require confirmation from BBC that the larger variants can be reused. [BBC syndication documentation](https://information-syndication.api.bbc.com/)
- **Yle** is a fixture for rejecting roundup images. Yle's RSS terms exclude displaying news article photos on other websites, so leave article-page image lookup disabled for Yle. [Yle RSS terms](https://yle.fi/a/20-10008076)
