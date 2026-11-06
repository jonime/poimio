# 008 — Cached guest feed preview

**Status:** Done — implemented 3 Nov 2026; merged in PR #6

**Milestone:** Final

**Depends on:** 001–005

**Estimate:** 4–6 h

## Goal

Show guests a small, unpersonalized feed at `/` before they sign in. Verified
users see their existing personalized feed at the same URL. Fetch the preview
directly from existing content tables and cache it across guest visits.

## Context

- [Project plan](../plan.md), [design §5.1 and §6](../design.md#51-data-access-and-security).
- [Feed UI](003-feed-ui.md), [deployment and access](004-deployment-access.md),
  and [description enrichment](005-description-enrichment.md).
- Currently `/login` is public and `/` is inside an authenticated route group.
- Cache Components and supabase-js are already installed/configured. Vercel has
  public Supabase credentials only; ingestion has the service-role key.
- Number 007 is reserved by spec 004 for future per-user LLM limits.

## In scope

- One home route with guest and authenticated presentations.
- Twelve public preview cards read through the existing Supabase Data API,
  cached server rendering, shared card presentation, and access tests.
- Column grants and RLS policies defining the intentionally public metadata.

## Out of scope

- A snapshot table, publisher script, ingestion/workflow changes, Storage,
  service-role credentials on Vercel, new dependencies, or a new HTTP endpoint.
- Guest accounts, feedback, tracking, personalization, filters, pagination UI,
  infinite scrolling, refresh controls, or request-time embedding/LLM calls.
- Changes to personalized ranking and owner-only feedback access.

## Design notes

### Approved public-content security exception

The current AGENTS.md rule restricts shared tables to authenticated readers.
The user approved the following explicit exception for task 1 on 3 Nov 2026:

> Anonymous clients may read only the listed public metadata columns of active
> sources and recent, completed content items from those sources. RLS remains
> enabled; writes remain service-role-only. Embeddings, ingestion internals,
> feedback, and other user data remain inaccessible to anonymous clients.

Record this exception in AGENTS.md and design §5.1/§6 before implementation.
The user selected the direct-content approach on 3 Nov 2026; this document
specifies its approved access boundary. Do not silently broaden it.

**Public access is broader than the twelve-card UI:** anyone with the public
Supabase key can query all rows/columns permitted below, independent of the
Next.js cache and selection. A hidden endpoint or UI limit would not enforce a
database access limit. This is acceptable for intentionally public metadata.

### Database access and interfaces

- Use a new migration; never edit applied migrations. Add no table or RPC.
  Use explicit column-level SELECT grants to `anon`, never table-wide SELECT.
- Public `sources` columns: `id`, `name`. Its anonymous SELECT policy exposes
  active sources only (`is_active = true`). Feed URLs, fetch timestamps,
  validators, errors, and other source internals are not granted.
- Public `content_items` columns: `id`, `source_id`, `url`, `title`, `summary`,
  `summary_origin`, `type`, `language`, `thumbnail_url`, `published_at`.
  No grants for embeddings, model identifiers, enrichment state/error fields,
  categories, creation timestamps, or other columns.
- Its anonymous SELECT policy permits completed enrichment, nonblank summaries,
  HTTP(S) item URLs, and publication dates between the recency cutoff and
  `now()`: seven days for articles, thirty days for videos. Require `source_id`
  to match a source visible through the active-source policy. Evaluate internal
  same-row fields such as enrichment status inside RLS, not by granting them
  to anonymous queries. The source lookup needs only the public source ID.
- Keep existing authenticated SELECT policies and grants. Do not add anonymous
  write grants/policies or grants to feedback, language means, or ranking and
  feedback functions. No SECURITY DEFINER functions or RLS bypasses.
- Supabase's existing PostgREST API is the public API. The server reader selects
  the explicit content columns and joins only `sources(id,name)`. Do not use
  `select('*')`; prove the exact join works under anonymous column grants.
- Add `GuestFeedItem` with the existing feed field types for `id`, `url`,
  `title`, `summary`, `summary_origin`, `type`, `language`, `thumbnail_url`,
  `published_at`, and `source_name`. Map the joined source name explicitly;
  do not spread database rows into rendered props.
- Use a server-only, cookie-free supabase-js client with the existing public
  anon key, session persistence disabled, and auto-refresh disabled. Do not
  inherit a visitor's authenticated client; guest data must obey anonymous RLS.
- Supabase supports this separation through column privileges and RLS:
  [column security](https://supabase.com/docs/guides/database/postgres/column-level-security)
  and [row security](https://supabase.com/docs/guides/database/postgres/row-level-security).

### Preview selection and caching

- Perform candidate reads/selection inside the shared cached scope, never on
  every guest request. Paginate eligible reads ordered by publication time
  descending, then ID, to avoid silently truncating at the Data API row limit.
- Aim for six Finnish and six English cards. Within each language, order each
  source's items newest first, then item ID. Take one item per source before
  taking a second; order sources in each round by their candidate publication
  time descending, then source ID. Alternate languages, Finnish first, and fill
  missing places from the other language. Return at most twelve unique items.
- Use existing safe-URL validation before selection: discard unsafe item URLs
  and turn unsafe thumbnail URLs into null. Render fewer cards when necessary.
  Do not read feedback or embeddings, call `get_feed`, or invoke an LLM.
- Cache the anonymous reader using `use cache: remote` on Vercel and
  `cacheLife({ stale: 300, revalidate: 1800, expire: 86400 })`. New ingestion
  becomes visible on subsequent cache revalidation without a publishing step.
- Capture the preview render time inside the cached scope for consistent
  relative publication labels. Cookies, user claims, search parameters,
  errors, and the personalized branch stay outside this shared scope.
- Empty results, query failure, or malformed data show an `Empty` state:
  **Preview temporarily unavailable. Sign in to open your feed.** Keep sign-in
  usable. Do not fall back to privileged credentials or personalized queries.
- Shared caching reduces database queries; it does not guarantee one global
  query per interval. Cache eviction, expiry, and deployments can trigger reads
  again. Auth/proxy work and page/asset delivery can remain request-specific.
  Do not cache the whole identity-dependent home response publicly.

### One home route and UI

- Move the home route out of `(app)` into `app/page.tsx`, removing the old home
  route so only one page resolves to `/`. Verify identity using `getClaims()`:
  guests see sign-in plus preview; verified users see the existing personalized
  feed, refresh button, and authenticated app header.
- Keep the protected layout for `/liked` and other private pages. Share current
  header/display-name handling with the authenticated home branch. Only query
  `get_feed` after identity verification. Every action/handler still verifies
  its own caller regardless of public root routing.
- Make the exact `/` pathname public in the proxy. Redirect anonymous private
  page requests to `/`. Keep `/login` as a redirect only for old links,
  preserving only recognized `error=callback`; remove its standalone page UI.
- OAuth success and successful sign-out go to `/`; OAuth failure goes to
  `/?error=callback`. Keep sign-out failure at `/?error=sign-out`. Update all
  internal login destinations and privacy-page links to `/`.
- Retain branding, privacy/GitHub links, local-development login eligibility,
  and Google sign-in. Show callback errors outside the cached preview even if
  an existing valid session is present. Signing in/out changes the home view
  without changing the home URL.
- Guest heading: **Latest picks**. Supporting text: **A preview from our sources.
  Sign in to get recommendations based on your interests.** Put Google sign-in
  above the cards and repeat it below them. Match the signed-in feed's width.
- Extract static card presentation for both views. Preserve source, time,
  thumbnail, summary, AI attribution, and accessible external links with the
  existing URL protections. Guest cards have no feedback footer, personalized
  explanation, swipe handlers, undo, refresh, or load-more controls. Keep all
  interactive behavior in the authenticated wrapper.
- Follow the shadcn skill and installed Next.js Cache Components/auth guidance.
  Keep the identity-dependent branch behind the required request-time boundary
  and reuse the existing components/theme tokens.

## Acceptance criteria and tasks

Work in order, one task at a time. Every task requires its criteria plus
`pnpm lint`, `pnpm typecheck`, and `pnpm test`. Database/security tasks also
require `pnpm test:integration` against local Supabase with zero skipped.

- [x] 1. Record the specified public-metadata exception in security/design
     documentation and add the column grants/RLS migration. Fresh local
     migrations apply cleanly. Existing authenticated and owner-only policies
     remain intact; there are no new tables, RPCs, or client write privileges.
- [x] 2. Add and run integration tests proving anonymous explicit-column reads
     and the exact source join work. Verify inactive-source, incomplete,
     blank-summary, unsafe-URL, future, and expired items are hidden. Test
     article/video cutoff boundaries. Verify forbidden columns and wildcard
     reads fail, anonymous inserts/updates/deletes cannot change either table,
     and feedback, embeddings, means, `get_feed`, and feedback APIs remain
     protected. Existing two-user isolation and authenticated feed tests pass.
- [x] 3. Add the anonymous reader, typed DTO, selection, and cached preview.
     Tests cover language balance/fallback, source diversity, deterministic
     ties, pagination, duplicate prevention, safe URLs, empty results, errors,
     and exact rendered fields. No privileged key, cookies, feedback query,
     personalized RPC, or OpenAI request is needed to render the preview.
- [x] 4. Implement the root guest/authenticated branches, shared static cards,
     redirect compatibility, and updated auth/privacy links. Tests cover guest
     `/` without redirect, verified `/`, sign-in/out transitions, callback
     success/failure, legacy `/login`, private `/liked`, direct unauthorized
     actions, and separation of cached public content from personal content.
     Browser checks at desktop and 375px confirm working article links,
     sign-in/errors/privacy, no overflow or guest action controls, and working
     authenticated feedback and gestures.
- [x] 5. Run all gates plus `pnpm build` and local integration tests with zero
     skipped. In a production-mode local server, verify repeated guest visits
     reuse preview content, refresh after revalidation, and never show one
     user's personalized data to another visitor. Verify caching via the
     preview query/cache behavior, not whole-page headers alone. Document
     rollout and review the diff; the human commits.
- [ ] 6. Share the anonymous preview data through Vercel Runtime Cache and
     stream the guest sign-in header independently of the preview. Preserve
     verified auth, the existing cache lifetime, and the anonymous data
     boundary. Record auth, preview load, and upstream read durations in
     Vercel logs without user or content data. Pass lint, typecheck, tests,
     and build. After deployment, compare time to first guest card against
     the production baseline and verify that a warm preview skips the reader.

## Rollout and rollback

- Confirm the selected Supabase target before database work; use local Supabase
  for writes/tests. Plan approval does not authorize production database changes.
- Ship the additive permission migration before the UI depends on anonymous
  reads. Deploy through existing CI gates. There is no first-snapshot step or
  ingestion change. Missing permissions/API failures must leave sign-in usable.
- After rollout, inspect anonymous allowed/denied reads and both home states.
  Existing deployment/error reporting is sufficient; add no monitoring service.
- Rolling back the UI does not revoke database access. To withdraw public
  content access, revoke the new anonymous column grants/policies in a new
  migration and redeploy without the cached preview. Already-delivered public
  content cannot be recalled from visitors' caches.

## Decisions

- Direct public metadata reads replace the earlier snapshot proposal, per the
  user's instruction. Public access intentionally extends beyond the twelve
  displayed items, within the defined row and column boundaries.
- One home URL has guest and authenticated presentations. `/login` only
  redirects old links; `/auth/callback` remains the OAuth endpoint.
- Twelve cards, approximate language balance, source round-robin, and
  thirty-minute revalidation are the approved presentation defaults.
- Plan-only change: no application, permissions, production data, ingestion,
  dependencies, or deployment is changed by approving this spec.

## Open questions

- None.

## Validation — 3 Nov 2026

- With the user's explicit approval, reset local Supabase at
  `http://127.0.0.1:55321` and applied the complete migration chain successfully.
  The new anonymous metadata migration was not applied to production.
- Final gates: `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed;
  After rebasing onto current `main` for the PR, `pnpm test` passed 338 tests
  (56 opt-in tests skipped by the normal runner).
  `pnpm test:integration` passed all 58 tests with zero skipped, including exact
  database-clock recency boundaries, anonymous column/join access, denied
  writes/private fields, and existing two-user feedback/ranking isolation.
- Real React DOM interaction tests cover Like, Seen, both touch-swipe
  directions, and Undo through the extracted shared card. No dependency added.
- Browser checks at desktop and 375px: twelve public cards, no guest feedback
  controls or horizontal overflow, loaded branding/thumbnails, safe external
  link attributes, privacy navigation, local sign-in, persisted Like on the
  private Liked page, protected-page redirects, and callback errors on `/`.
  The user reviewed the populated guest page and approved its layout.
- Production-mode local cache verification used temporary query counters and
  an isolated test-process clock: repeated guest visits performed one metadata
  read; two authenticated users performed two personal feed RPCs without
  entering the public preview cache; a subsequent guest still saw public cards.
  Advancing the test process by 1,801 seconds triggered the second metadata
  read and displayed a changed local fixture title. Restored the fixture and
  stopped the instrumented server; no test instrumentation ships in the app.
- With explicit approval, read twenty public article metadata rows from the
  production project and copied them into local Supabase for visual review.
  Production was read-only; no accounts or feedback were copied. Local fixture
  vectors/means supported interaction checks without OpenAI calls. Removed
  both disposable local review accounts and their feedback afterward; retained
  the public sample articles for review at `http://localhost:3001/`.
- Prepared for pull-request review. Production migration/deployment are separate
  rollout steps, not part of this local implementation.
