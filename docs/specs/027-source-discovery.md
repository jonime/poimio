# 027 — Source discovery

**Status:** Approved  
**Milestone:** Final (weeks 6–7, stretch goal)  
**Depends on:** gate 2 (passed); 019 (ingestion bounds); 024 (Sources page); 025 (story threshold); 021 (`llm_usage`, `reserve_llm_call`); for stage (b) only: [spec 001 task 15](001-ingestion.md) verified after deployment (the SSRF-safe transport is already in `lib/public-http.ts`)  
**Estimate:** 22 h (release A, stage a with admin page: about 13 h; stage b: about 8 h; docs: 1 h)

## Goal

Find good new sources for the shared pool. Stage (a) scores the inactive catalog sources; stage (b) asks an LLM with web search for new sites on topics the admin types. In both, deterministic code validates and scores each candidate, and an admin approves it on an admin page before it is ingested ([design.md §3](../design.md#3-source-discovery-stretch-goal)).

## Context

- Discovery design and safeguards: [design.md §3](../design.md#3-source-discovery-stretch-goal); cut order: [plan.md §9](../plan.md#9-decision-gates-and-cut-order) (web search is cut first)
- Catalog: [feeds.md](../feeds.md); `sources` rows with `is_active = false` (39 of 56 in `20261028000001_seed_sources.sql`)
- Fetching and parsing: `lib/fetch.ts` (`fetchFeed`, via `fetchPublicUrl` in `lib/public-http.ts`), `lib/normalize/parse.ts` (date fallback and clamping), ingestion filtering in `lib/ingest.ts` (200-entry cap, Shorts exclusion) and `lib/db.ts` (`hasUsableUrl`); embeddings: `lib/embeddings.ts`
- Responses API parsing: `lib/openai-response.ts` (`completedResponseText` accepts only message and reasoning output)
- Database reads: PostgREST `max_rows = 1000` (`supabase/config.toml`)
- The interest summary of [spec 026](026-interest-summary-clicks.md) was cut after failing its quality gate (`20261128000100_remove_interest_summaries.sql`), so stage (b) topics are typed by the admin
- Session refresh routes: `proxy.ts`; user menu (client component): `components/user-menu.tsx`
- Privacy page: `app/(app)/privacy/page.tsx`

## In scope

- **Release A (tasks 1–3):** `admins` and `is_admin()`; `source_candidates` and `source_discovery_runs`; a transactional decision function; a **Scan catalog** button; the admin-only page `/admin/sources` with approve and reject; the stage (a) privacy text.
- **Stage (b) (task 4):** web-only candidate fields, the `source_discovery` usage kind, admin-typed topics, a **Search the web** button, autodiscovery through the SSRF-safe transport, web approval, and the stage (b) privacy text.
- Docs (task 5).

## Out of scope

- Per-user "Suggested sources". Sources are shared, and the Sources page switches only hide sources; acting on a suggestion would need per-user subscriptions.
- Scheduled scans; outbound links from liked articles; YouTube channels in stage (b).
- Deactivating or editing approved sources in the admin page (SQL, as today); generating source descriptions (`pnpm sources:describe`, spec 024, run after approval).
- Granting admin rights in the UI (SQL only).
- Changing the ingestion limits of spec 019.

## Design notes

### Admins and authorization

- `admins` is owner-readable membership: `user_id` PK (FK → `auth.users`, cascade), `created_at`. RLS is enabled with an owner-only `select` policy. Grants: `select` to `authenticated` only; nothing to `anon`; no `insert`, `update`, or `delete` for either role. The operator adds rows with SQL (documented in design.md §6).
- `is_admin() returns boolean`: `STABLE`, `SECURITY INVOKER`, empty search path, `exists (select 1 from public.admins where user_id = (select auth.uid()))`. Execute is revoked from `PUBLIC` and `anon` and granted to `authenticated`.
- **Fail closed.** The admin page and every admin server action verify the user with `getClaims()`, then call `is_admin()` through the user's client. They continue only if both succeed and the result is exactly `true`; any error counts as not admin. A non-admin gets `notFound()` from the page and a generic `not_found` from actions. No service-role client is created, and no fetch or OpenAI request is made, before the check passes.
- The user-menu link is a display hint only: the server layout computes `isAdmin` the same way and passes it to the client menu. `/admin/sources` is added to the session-refresh routes in `proxy.ts`; the proxy is not authorization.

### Candidates and runs

- `source_candidates` is admin-readable shared data: `id`, `origin` (`catalog` or `web_search`), `source_id` (FK → `sources`, `on delete cascade`, catalog only), `name`, `feed_url` (unique, normalized as below), `site_url`, `kind` (`rss` or `youtube`), `language` (`fi` or `en`), `status` (`pending`, `failed`, `approved`, `rejected`), `failure` (short code), `item_count`, `items_per_day`, `relevance` (`high`, `medium`, `low`, or `not_scored`), `relevance_basis` (`all_users` or `admin`, null when not scored), `mean_match_share` (rounded to 0.05, null when not scored), `duplicate_share` (rounded to 0.05), `sample_titles text[]` (at most 5), `scanned_at`, `decided_at`. Stage (b) adds `llm_reason` (at most 200 characters).
- `source_discovery_runs` (shared, admin-readable): `id`, `kind` (`catalog` or `web_search`), `started_at`, `lease_expires_at`, `finished_at`, `status` (`running`, `completed`, `partial`, `failed`), and `failures jsonb` (run-level codes per host for stage b, at most 10 entries).
- RLS on both: `select` for `authenticated` using `(select public.is_admin())`; no write policies. Grants: `select` to `authenticated`; nothing to `anon`. Only the service role writes, after the admin check.
- **Feed URL normalization** (separate from article URL normalization): trim; lowercase the scheme and host; drop the default port and the fragment; keep the path and query exactly.
- **Status transitions:** a scan refreshes `pending` and `failed` rows (`pending ↔ failed`, clearing stale scores on failure). `approved` and `rejected` are terminal; a rescan leaves them untouched, and they are not proposed again.

### Decisions (approve and reject)

`decide_source_candidate(p_candidate_id uuid, p_decision text) returns text`: `SECURITY INVOKER`, empty search path, execute granted to `service_role` only (revoked from `PUBLIC`, `anon`, and `authenticated`). The admin action calls it with the service role after the admin check. In one transaction it:

1. Locks the candidate row (`for update`).
2. If the candidate is not `pending`: returns `unchanged` when the same decision was already made, otherwise `already_decided`; nothing changes.
3. Reject: sets `rejected` and `decided_at`; returns `rejected`.
4. Approve, catalog: requires the `sources` row of `source_id` to exist with the same normalized `feed_url`, otherwise returns `stale` with no change. It sets `is_active = true`, then sets the candidate `approved`.
5. Approve, web: inserts a `sources` row (`name`, `feed_url`, `site_url`, `kind = 'rss'`, `language`, `is_active = true`) with `on conflict (feed_url) do nothing`. If no row was inserted, it returns `already_known` and leaves the candidate `pending`. Otherwise it sets the candidate `approved`.

An approved source is then returned by the ingestion source query and listed on the Sources page.

### Validation (both stages)

A candidate is `failed` with a short code unless all of these hold:

1. The feed is fetched without stored validators (no ETag or Last-Modified, since discovery needs a body) and parses with the existing code, within the existing timeout and size limits.
2. Entries are filtered exactly as ingestion filters them: the 200-entry cap applied before deduplication, usable HTTP(S) URLs (`hasUsableUrl`), and the YouTube Shorts exclusion. Shared helpers are extracted from ingestion rather than copied.
3. At least 3 distinct eligible URLs have a feed-provided, parseable publication date in the last 30 days. Dates from the fetch-time fallback and dates in the future do not count. The parser reports whether each date came from the feed.
4. The language is `fi` or `en`. In stage (a) it is the catalog row's language; in stage (b), see below.

### Scoring (both stages)

- **Windows:** articles from the last 7 days and videos from the last 30 days, on both the candidate and the reference side. Volume (`items_per_day`) uses all eligible items from the last 30 days divided by 30.
- **Embedding:** up to 20 of the newest in-window items with a nonblank feed summary are embedded in memory with the ingestion embedding input and `text-embedding-3-small@512`. Items without a summary count toward volume but are not scored (ingestion embeds them only after enrichment). Embedding requests reuse the existing request code: at most 100 inputs per request, at most 8 requests per scan, each with a 20 s deadline. Nothing is written to `content_items`.
- **Similarity** is centered with the stored language means, as in the scorer.
- **Relevance.** Users with at least 5 eligible likes are scored. For user $u$, the reference pool is active-source items in the windows above, excluding items $u$ has rated or opened. Its threshold $q_u$ is the nearest-rank 75th percentile of nearest-like similarity, using $u$'s latest 200 eligible likes. A candidate item matches $u$ when its nearest-like similarity is strictly greater than $q_u$, so at most 25% of the reference pool matches by construction, ties included. A user's match share is the fraction of the candidate's scored items that match.
- `relevance`: with $n$ scored users and $m$ users whose share is at least 0.25, `high` if $m/n \ge 0.5$, `medium` if $m/n \ge 0.2$, otherwise `low`. `mean_match_share` is the mean share, rounded to 0.05.
- **Admin fallback:** when fewer than **3** users can be scored, relevance is computed the same way from the scanning admin's own likes only, and stored with `relevance_basis = 'admin'`. For $n = 1$, the levels are `high` for a share of at least 0.5, `medium` for at least 0.25, otherwise `low`. The page labels these rows "based on your likes". This uses only the admin's own data, so the minimum still protects other users. With 3 or more scored users, `relevance_basis = 'all_users'` and the admin's likes count like anyone else's.
- **Not scored** (`relevance = 'not_scored'`, `mean_match_share` null) when the admin fallback also has fewer than 5 eligible likes, no reference items for any scored user, no language mean for the candidate's language, or fewer than 3 scored candidate items.
- Reference scores are computed once per scan. Reads beyond 1,000 rows are paged, or the computation runs in a service-role-only SQL function. No user IDs, per-user shares, or counts of matched users are stored or shown.
- **Duplicates:** `duplicate_share` is the fraction of scored candidate items whose normalized URL matches an existing item, or whose centered similarity to an active-source item in the same window is at least 0.74. This is a high-confidence duplicate estimate. It catches same-language near-copies but few translations: none of spec 025's 28 confirmed Finnish–English pairs reached 0.74.

### Scan budget and concurrency

- One lease covers both scan buttons. A scan starts only if no `running` run has an unexpired lease (`lease_expires_at` = start + 330 s); otherwise the action returns `scan_running`. An expired lease is treated as `failed` and can be replaced.
- The admin page exports `maxDuration = 300` (route segment config); the deployed function configuration is checked once.
- Work runs in batches of 8 sources with the existing fetch concurrency, under a 240 s application deadline. Each batch's bodies are parsed and released before the next starts. No new batch starts after the deadline: the run is `partial`, and unprocessed candidates keep their previous state. A source's failure is recorded on its candidate and does not stop the run.

### Stage (a): Scan catalog

- **Scan catalog** validates and scores every inactive catalog source (`sources.is_active = false`). Feed URLs come from the database, so they are fixed, known URLs.
- The page shows the last run's time and status, with a pending state while it runs.

### Stage (b): Search the web

Requires spec 001 task 15 to be verified after deployment (scheduled-run check, alert #2 handled).

1. **Topics.** The admin types 1–3 topics (each 1–40 characters after trimming), for example "Finnish motorsport". They contain no user data.
2. **Search the web** verifies admin, validates the topics on the server, takes the scan lease, and reserves one call with `reserve_llm_call('source_discovery')` (5 per rolling 24 hours per admin, counted per kind).
3. One `gpt-6-luna` Responses API request with the built-in web search tool: `store: false`, at most 1,500 output tokens, 60 s timeout, response body at most 256 KB. The fixed instruction goes in `instructions` and asks for active, reputable Finnish or English sites with RSS or Atom feeds. The typed topics are sent as untrusted data, and nothing else is sent. Strict JSON schema: up to 10 `{name ≤ 80, site_url, reason ≤ 200}`.
4. **Parsing.** A new parser accepts only `reasoning` and completed web-search tool records, plus exactly one completed message whose `output_text` validates against the schema. Anything else fails the run and still counts. A live smoke check, with a sanitized response fixture committed for tests, confirms that the model, the tool, and the strict schema work together. If they do not, stop and discuss.
5. **Deterministic validation.** HTTP(S) `site_url`s only, deduplicated by host. Each homepage is fetched with `fetchPublicUrl` (at most 1 MB). The first RSS or Atom `<link rel="alternate">` is resolved against the **final** homepage URL after redirects. The feed and every redirect also go through `fetchPublicUrl`. Feed URLs from the LLM are never used without fetching.
6. **Language:** the RSS channel `<language>`, then the Atom root `xml:lang`, then the homepage `<html lang>`; take the primary subtag, lowercased. It must be `fi` or `en`. The parser is extended to expose the feed language.
7. **Failures before a feed URL is known** (blocked or failed homepage, no autodiscovery link) are recorded on the run as host and code, with no candidate. A feed URL that is already a source is recorded as `already_known`. A feed URL with an existing candidate follows the status transitions above. Otherwise a `web_search` candidate is stored, validated and scored as above.
8. Topics are not stored in candidates, runs, or logs. `llm_reason` is shown as plain text, labeled as the model's suggestion.

### Admin page (`/admin/sources`)

- Buttons with pending and error states (including `scan_running`), the last run's status, and a table of candidates.
- Pending candidates show name, origin, language, site link (HTTP(S) only), relevance (labeled "based on your likes" when the basis is `admin`), mean match share, duplicate share, items per day, and sample titles. They are sorted by relevance (`high`, `medium`, `low`, `not_scored`), then `mean_match_share` desc, then `duplicate_share` asc. Failed candidates are listed separately with their code; approved and rejected candidates are collapsed. All external strings are rendered as text.
- **Approve** and **Reject** call `decide_source_candidate` and show its result (`already_known`, `stale`, `already_decided`).
- shadcn/ui: `Table`, `Badge`, `Button`, `Field` and `Input` for topics, `Alert`, `Empty`.

### Rollout

- Approve at most 3 sources at first. Check the next scheduled runs' duration and whether the embedding backlog drains within spec 019's unchanged limits before approving more.

### Privacy page

- **Stage (a)** (release A): your likes are used, together with other users' likes, to score candidate sources for the shared pool. Other users' likes are used only when at least 3 users can be scored, and then only coarse aggregates are stored; before that, only the scanning administrator's own likes are used. Scores are shown to administrators. Candidates contain no personal data and are kept until deleted.
- **Stage (b)**: no user data is sent. Only topics typed by an administrator go to OpenAI to search the web for new sources.

## Acceptance criteria

Each criterion belongs to one task. Tasks 1–3 are release A and ship together; task 4 (stage b) ships separately and is cut first.

1. **Task 1 — schema**
   1. `supabase db reset` applies the migration. `is_admin()` and `decide_source_candidate` have the attributes and grants above.
   2. Two-user and role tests: a user reads only their own `admins` row; `authenticated` and `anon` cannot insert, update, or delete `admins`, `source_candidates`, or `source_discovery_runs`; a non-admin and `anon` read no candidates or runs; an admin reads all of them; `authenticated` cannot execute `decide_source_candidate`.
   3. Decision tests: reject; approve for catalog activates the source; a stale catalog URL returns `stale`; a web feed URL conflict returns `already_known` and leaves the candidate pending; a repeated decision returns `unchanged`; an opposite decision returns `already_decided`; concurrent approve and reject leave exactly one decision; a failure rolls back both rows.
2. **Task 2 — validation, scoring, and catalog scan**
   1. Unit tests: validation codes; undated, fallback-dated, and future-dated entries not counted as recent; the 200-entry cap before deduplication; the Shorts exclusion; feed URL normalization keeps the query; article and video windows; self-matches excluded; the nearest-rank percentile with ties; the relevance levels; the admin fallback with fewer than 3 users (basis `admin`, admin's likes only, other users' likes unused) and the switch to `all_users` at 3; `not_scored` when the admin has fewer than 5 likes, an empty reference pool, a missing language mean, and fewer than 3 scored items; duplicate share; rounding; the sort order.
   2. Integration tests on local Supabase with fixture feeds: a scan stores pending and failed candidates; no `content_items` rows are written; a rescan follows the status transitions; stored rows contain no user IDs or per-user values; a concurrent scan returns `scan_running`; an expired lease is replaced; a deadline produces a `partial` run, leaving unprocessed candidates unchanged; reads past 1,000 rows are complete.
   3. A catalog scan of the real inactive sources runs once locally and once on a Vercel deployment within the limits. The AI log records counts, duration, the deployed `maxDuration`, and the top 5 candidates.
3. **Task 3 — admin page and stage (a) privacy**
   1. Component and action tests: a non-admin, `anon`, a claims error, and an `is_admin()` error all get `notFound()` or `not_found`, with no service-role use and no external request; the menu link shows only with the server-derived flag; button states including `scan_running`; decision results are shown; the table order and sections; external strings rendered as text.
   2. Integration test: an approved catalog source is returned by the ingestion source query and listed on the Sources page; a rejected one is not.
   3. The privacy page includes the stage (a) text.
4. **Task 4 — web search (stage b)** (only after spec 001 task 15 is verified)
   1. Migration: `llm_reason`, the `source_discovery` usage kind (5 per 24 hours, with the existing concurrency and expiry behavior), and web approval in `decide_source_candidate`.
   2. Unit tests: typed topics are trimmed, length-checked, and limited to 1–3 on the server; the lease and limit are taken before any fetch; the exact outbound request body; the web-search parser accepts the fixture and rejects unexpected records, incomplete output, and invalid JSON; homepage, autodiscovery link, feed, and redirects all go through `fetchPublicUrl`, including blocked feed-link destinations and feed redirects to private addresses; relative autodiscovery links are resolved against the final URL; language extraction and fallback; run-level failures; repeated searches follow the status transitions; topic labels are not stored or logged.
   3. A live smoke check and one manual run with 2 topics: the AI log records the proposals, how many passed validation, the failure codes, and the time and token use.
   4. The privacy page includes the stage (b) text.
5. **Task 5 — docs**
   1. design.md §3 (implemented stages, scoring, minimum user count, admin approval), §2.5 (web search use), and §6 (`admins`, `source_candidates`, `source_discovery_runs`, `llm_usage` kinds, adding an admin with SQL) are updated; plan.md §7.1 marks the spec; the AI log entry follows AGENTS.md (the agent asks the user to confirm the model first).
6. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [ ] 1. `admins`, `is_admin()`, `source_candidates`, `source_discovery_runs`, `decide_source_candidate` (catalog), RLS and decision tests (criterion 1).
- [ ] 2. Shared ingestion filtering, validation and scoring, **Scan catalog** with lease, batches, and deadline; local and Vercel scan (criterion 2).
- [x] 3. `/admin/sources` page, menu flag, proxy refresh, stage (a) privacy text (criterion 3). Release A ships here.
- [ ] 4. Stage (b): quota, typed topics, web search, parser, autodiscovery, web approval, privacy text (criterion 4). Cut first if time runs short.
- [ ] 5. Docs (criterion 5).

## Decisions

- Stage (b) needs spec 001 task 15 verified, because URLs from an LLM must go through the SSRF-safe transport. The transport is already implemented; only the post-deployment check and dismissing alert #2 remain. Stage (a) uses known catalog URLs and does not wait.
- Admins are rows in an `admins` table managed with SQL, checked with `is_admin()` through the user's client. Privileged writes use the service role only after that check, so shared tables keep no write policies.
- Approve and reject run in one database transaction that reports success only after the source is activated or inserted.
- Scans start from buttons on the admin page within a 300 s function limit. A lease, batches, and a 240 s application deadline make overlapping and partial runs safe.
- Discovery reuses ingestion's filtering and counts only real feed dates, so an approved source behaves in ingestion as it did in discovery.
- Relevance is relative to each user's active-source items (75th percentile), so no fixed similarity threshold is tuned.
- While fewer than 3 users can be scored, relevance falls back to the scanning admin's own likes, so stage (a) is useful from the start without exposing anyone else.
- **Minimum of 3 users** for scoring relevance, with coarse stored values. With fewer users, an exact count could reveal one person's interests even without names.
- Stage (b) topics are typed by the admin. The interest summary that was to supply them was cut (spec 026), and typed topics send no user data.
- Candidate items are embedded in memory and never stored, so nothing unapproved reaches the feed or the guest preview.
- No per-user source suggestions: sources are shared, and approval keeps quality control in one place.
- New sources are approved in small batches because spec 019's embedding budget is shared by all sources.

## Open questions

- None.
