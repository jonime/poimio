# 029 — Usage metrics

**Status:** Draft  
**Milestone:** Final (week 6)  
**Depends on:** 027 (`admins`, `is_admin()`, fail-closed admin checks, 3-user minimum), 026 (`item_clicks`), 025 (`duplicate_of`), 007 (exploration), 021 (`llm_usage`)  
**Estimate:** 11 h (release 1: about 5 h; release 2: about 6 h)

## Goal

Give the final report real-usage evidence next to the offline evaluation. Two small append-only logs record feedback changes and the items each feed page served. An admin-only page shows privacy-safe aggregates and downloads them as JSON. The logs ship first so data accumulates while the dashboard is built.

## Context

- Today, Undo deletes the `feedback` row (`app/feedback/actions.ts`, `clearFeedback`). So design.md §7.2's claim that undo rates by input method can be measured cannot be met, and nothing records which items a feed page served or at which position.
- `feedback`: `user_id` cascades on account deletion; `item_id` is `on delete restrict` (`20261028000002_create_feedback.sql`). `set_feedback` upserts and rewrites `kind` and `via` even when unchanged (`20261030000002_remove_allowlist.sql`).
- Feed page loads: the first page in `app/(app)/page.tsx` (`get_feed`, `p_limit: 30`) and later pages in `app/feed/actions.ts` (`loadMoreFeed`). `get_feed` returns `reason` (with `exploring` for exploration slots) and `duplicate_of`, but no exploration column. Exploration slots 5, 15, and 25 are positions in each call's ranked rows, before grouping (spec 007).
- The feed's Undo toast can restore a previous rating with another `set` rather than a `clear` (`app/feed/feed-list.tsx`). Member links record the member's ID (spec 026).
- `after()` (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`): runs after the response, also for unsuccessful responses; in Server Components, `cookies()` cannot be called inside the callback. The server Supabase client (`lib/supabase/server.ts`) resolves the session through its cookie adapter.
- Admin checks and the 3-user rule: spec 027; scheduled route: `app/api/scheduled-ingestion/route.ts`; session-refresh paths: `proxy.ts`; privacy page: `app/(app)/privacy/page.tsx`

## In scope

- **Release 1 (tasks 1–2):** `feedback_events` (trigger on `feedback`), `feed_served` (written after each feed page), pruning, privacy text, and a production smoke check.
- **Release 2 (tasks 3–4):** `usage_metrics`, `/admin/metrics` with a JSON export, and docs.

## Out of scope

- Viewport or impression tracking (served is not seen), dwell time, and skip signals ([design.md §7.5](../design.md#75-not-included)).
- Using the logs in ranking or in the offline evaluation; a causal comparison of exploration.
- Logging the guest preview, Liked, History, or Sources pages as served pages.
- Charts; the page shows tables.

## Design notes

### `feedback_events` (per-user)

- Columns: `id bigint generated always as identity` PK, `user_id uuid not null default auth.uid()` (FK → `auth.users`, cascade), `item_id uuid not null` (FK → `content_items`, cascade), `action text not null` (`set` or `clear`), `kind text not null` (`like`, `not_interested`, or `seen`; for `clear`, the removed kind), `via text` (`button` or `swipe` for `set`; null for `clear`), `created_at timestamptz not null default now()`.
- An `AFTER INSERT OR UPDATE OR DELETE` row trigger on `feedback`, with a `SECURITY INVOKER` function and an empty search path. The function branches on `TG_OP` before touching `OLD` or `NEW`:
  - It logs only when `auth.uid()` is not null and equals the affected row's `user_id`. Service-role maintenance and cascades (account deletion runs without the user's `auth.uid()`) are skipped, so they never fail and never log.
  - Insert → `set` with the new kind and via. Update → `set` only when `kind` or `via` is distinct from the old value, so identical `set_feedback` upserts log nothing. Delete → `clear` with the old kind.
- RLS: owner-only `select` and `insert` (`with check (user_id = (select auth.uid()))`). Column grants for `authenticated` on `item_id`, `action`, `kind`, and `via` only; there is no update or delete policy; `anon` has no access.
- These rows are best-effort telemetry, not an audit log: a user can insert rows for themselves, which only affects their own data.

### `feed_served` (per-user)

- Columns: `id bigint generated always as identity` PK, `user_id uuid not null default auth.uid()` (cascade), `page_id uuid not null`, `item_id uuid not null` (FK → `content_items`, cascade), `card_position integer not null`, `representative_id uuid not null` (the item itself, or its `duplicate_of`), `reason text not null`, `served_at timestamptz not null`. Unique `(user_id, page_id, item_id)`.
- RLS and grants as for `feedback_events`: owner-only `select` and `insert`; column grants for `authenticated` on everything except `id` and `user_id`.
- Exploration is `reason = 'exploring'`; there is no separate column.
- **Served** means a successful `get_feed` result produced for a request. It is not confirmed delivery or viewing.
- **Positions:** `card_position` is the 1-based position among representatives (cards) loaded so far, counting masked cards. Members get their representative's position. The first page starts at 1. `loadMoreFeed` gets a new argument, the number of cards already loaded, validated as an integer from 0 to the number of excluded IDs (at most 1,000).
- **Writing:**
  - After `getClaims()` succeeds and `get_feed` returns rows, the code generates `page_id`, captures `served_at` (request time) and the user's access token, then schedules the insert with `after()`.
  - The callback uses a cookie-free client that sends the token as the `Authorization` header, so RLS still checks the user.
  - It inserts all returned rows in one batch with `on conflict do nothing`, so a retried page is not logged twice.
  - A failure, including an expired token, is ignored and never shown. Every load or refresh that returns rows is a new page.

### Retention and indexes

- `prune_usage_logs()` deletes rows older than 30 days from both tables, in batches of at most 10,000 rows per table per call. It is `SECURITY INVOKER` with an empty search path; execute is revoked from `PUBLIC`, `anon`, and `authenticated` and granted to `service_role`.
- The hourly scheduled route calls it in its own error handling, independent of whether the ingestion lease was taken or ingestion succeeded. An error is logged and never fails the route.
- Indexes: `created_at` on `feedback_events` and `served_at` on `feed_served` for pruning; `feedback_events (user_id, item_id, created_at, id)` and `feed_served (user_id, item_id, served_at)` for undo and attribution. Query plans are checked on a 30-day fixture.

### Metric definitions

All metrics use the last 30 days.

- **Quick-clear rate** (the undo measure): order each user's events for an item by `(created_at, id)`. A `set` is quick-cleared when the **next** event for that user and item is a `clear` within 60 seconds. A following `set` (a replacement, including a via-only change or a toast restoring the previous rating) closes it without counting as a clear. Sets younger than 60 seconds are left out of the denominator. Reported by via (`button`, `swipe`) and by kind.
- **Attribution:** a served card has a 24-hour outcome window. Only serves at least 24 hours old (fully observed) enter the rates.
  - **Liked** or **disliked:** a `set` of that kind on the representative or a member, not quick-cleared, within 24 hours after `served_at`.
  - **Opened** (recorded first-open rate): the first recorded open (`item_clicks.clicked_at`) of the representative or a member within 24 hours. Later opens of an already-opened item are not recorded, and opened items leave later feeds (spec 026).
  - Each outcome is credited once, to the latest serve of that item for that user before the outcome, ties broken by `id`. Each card counts at most once per outcome type per page.
  - A zero denominator gives "no data".
- **By position:** card-position buckets 1–5, 6–10, 11–20, 21–30, and 31+: liked, disliked, and opened rates.
- **By reason:** the same rates for `similar`, `preference`, `opened`, `recent`, and `exploring`. Exploration is reported descriptively, with its counts and rates next to all other cards. It is not a causal comparison: slots are chosen by rank, and fallback slots are not a control group.
- **Activity:** feed pages served, cards served, `set` events by kind and via, `clear` events, recorded first opens, sources currently hidden that were hidden within the window, and preference-call reservations (`llm_usage`, which also counts failed calls).

### `usage_metrics() returns jsonb`

- `STABLE`, `SECURITY INVOKER`, empty search path. Execute is revoked from `PUBLIC` and `anon` and granted to `authenticated` and `service_role`.
- **Own mode** (`auth.uid()` not null): RLS limits every table to the caller's own rows. It returns the caller's aggregates and nothing about other users.
- **Cross-user mode** (`auth.uid()` null, service role). The 3-user floor is hard-coded in SQL:
  - If fewer than 3 distinct users have rows in the window, it returns only `{"suppressed": true}`, with no count.
  - Otherwise each published count or rate needs at least 3 distinct contributing users in its denominator; a smaller cell becomes `null` with `"suppressed": true`.
  - A total or a sibling cell that would reveal a suppressed cell by subtraction is suppressed too: within a breakdown, totals are shown only when every cell is shown, and when exactly one cell is suppressed, the next smallest is suppressed as well.
  - The user count is returned only as a bucket (`3–4`, `5–9`, `10+`).
- Every rate has its denominator and a `low_n` flag below 20 (uncertainty, not privacy).

### Admin page and export

- `/admin/metrics` and `/admin/metrics/export` are both added to the session-refresh paths in `proxy.ts`, and both verify the admin themselves, as in spec 027: `getClaims()`, then `is_admin()` exactly `true`, otherwise `notFound()` or 404. Nothing privileged runs before that check. `/admin/sources` links to the page.
- The server calls `usage_metrics()` with the service role. If the result is suppressed, it calls `usage_metrics()` with the admin's own client and labels the page "Your own usage (fewer than 3 users)". The same sanitized object feeds the page and the export.
- Tables per section, with the window dates, the basis, rates with denominators, `low_n` markers ("few observations"), and suppressed cells shown as "—".
- **Export:** a route handler returns that object, plus `generated_at`, `window_days`, `attribution_hours`, and `basis`, as `application/json` with `Content-Disposition: attachment` and `Cache-Control: private, no-store`. It has no user IDs, item IDs, or exact cross-user counts.
- shadcn/ui: `Table`, `Badge`, `Card`, `Button`, `Alert`, `Empty`.

### Privacy page (release 1)

- **Information we process:** a log of your feedback changes (including Undo) and a log of the items your feed showed you (position and reason). Both are kept for 30 days and deleted with your account.
- **How we use it:** to measure how well recommendations work. Administrators see only aggregates in which every figure covers at least 3 users, never individual activity; with fewer users, an administrator sees only their own usage. Shared source and item records used in these aggregates are not personal data and follow their own retention.

### Report use

- The report takes the metrics on a fixed cutoff date, the day before submission, and presents them as descriptive counts and rates, or "insufficient data". It draws no conclusion about recommendation quality from them.

## Acceptance criteria

Each criterion belongs to one task. Release 1 is tasks 1–2; release 2 is tasks 3–4.

1. **Task 1 — logs, retention, and privacy text**
   1. `supabase db reset` applies the migration; the trigger function, `prune_usage_logs`, and the indexes exist with the attributes and grants above.
   2. Trigger tests: a user's insert, kind change, via change, and delete each produce the specified event; an identical `set_feedback` upsert produces none; a service-role delete and an account deletion with existing feedback and log rows succeed and log nothing; content items with feedback still cannot be deleted (unchanged).
   3. Two-user and role tests for both tables: A cannot read B's rows or insert rows for B; no one can update or delete rows directly; `anon` has no access; account deletion removes the user's rows.
   4. Pruning: rows older than 30 days are removed in batches and newer rows kept; `PUBLIC`, `anon`, and `authenticated` cannot execute it; the scheduled route calls it when the lease is taken, when it is not, and when ingestion fails, and a pruning error does not fail the route.
   5. The privacy page includes the release 1 text.
2. **Task 2 — served logging and smoke check**
   1. Unit and action tests: the first page logs card positions 1..n; `loadMoreFeed` continues from the passed card count and rejects counts outside 0 to the number of exclusions; members carry their representative's position and ID, including a member before slot 5; the reason matches the returned rows; one `page_id` per call; a retried insert is ignored; nothing is logged when `get_feed` fails or returns no rows; an insert failure does not change the returned feed; the callback reads no cookies and uses the captured token.
   2. A production smoke check after deployment (read-only, by the user or with approval): a first page, a second page, and a refresh produce the expected `feed_served` rows; a like and an Undo produce the expected `feedback_events`; the AI log records it.
3. **Task 3 — `usage_metrics`**
   1. Integration tests with hand-computed fixtures: own mode returns only the caller's data; cross-user mode returns only `{"suppressed": true}` below 3 users; with 3 users, a cell with 1 or 2 contributing users is suppressed, and its total or complementary cell is too; the user-count bucket.
   2. Metric tests: quick-clear with a toggle, a replacement, a toast restore, tied timestamps, and sets younger than 60 seconds; attribution credits one serve (the latest earlier one), includes a member open and a member like, excludes serves younger than 24 hours and outcomes after 24 hours, and gives "no data" for empty denominators; the position buckets and reason rates; `low_n`.
   3. `pnpm test:integration` passes with 0 skipped; query plans on a 30-day fixture use the indexes, and the AI log records the timing.
4. **Task 4 — admin page, export, and docs**
   1. Page, route, and action tests: non-admin, `anon`, claims errors, and `is_admin()` errors get `notFound()` or 404 before any service-role use; both paths are in the session-refresh list; the basis switch and the "Your own usage" label; suppressed cells shown as "—"; `low_n` markers; the export headers and content (no user IDs, item IDs, or exact cross-user counts, and identical to the page data).
   2. design.md §6 (both tables, retention), §7 (served versus seen, the metrics and their limits), and §7.2 (undo measured as the quick-clear rate) are updated; plan.md §7.1 marks the spec; the AI log entry follows AGENTS.md (the agent asks the user to confirm the model first).
5. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [ ] 1. `feedback_events` with the trigger, `feed_served`, indexes, `prune_usage_logs` in the scheduled route, privacy text, RLS tests (criterion 1).
- [ ] 2. Log served pages from the first page and `loadMoreFeed`; production smoke check (criterion 2). **Release 1 ships here.**
- [ ] 3. `usage_metrics` with own and cross-user modes, cell suppression, fixtures (criterion 3).
- [ ] 4. `/admin/metrics`, JSON export, docs (criterion 4). **Release 2.**

## Decisions

- Both logs, because each enables metrics the other cannot: feedback events give the quick-clear rate by button and swipe (design.md §7.2); served rows give rates by position and reason.
- Logs ship first and the dashboard second, so about two weeks of data exist before the deadline.
- The trigger logs only the signed-in user's own changes and skips identical upserts, so cascades and maintenance never fail or produce noise.
- Served is not seen: the log records what the feed produced for a request. Logging runs after the response with a captured token, so it never slows the feed and never needs cookies.
- Outcomes are credited once, to the latest earlier serve, within 24 hours, and only fully observed serves count. 24 hours instead of 7 days, so the short pre-deadline period still yields complete data.
- Undo is reported as the 60-second quick-clear rate, a precise, measurable proxy.
- Privacy is enforced per published figure, in SQL: at least 3 contributing users, complementary suppression, and bucketed user counts. With fewer users, the admin sees only their own data, as in spec 027.
- Exploration numbers are descriptive only, because slots are chosen by rank.
- Rows are kept for 30 days and pruned hourly, independent of ingestion.
- The report uses the metrics descriptively, from a fixed cutoff date.

## Open questions

- None.
