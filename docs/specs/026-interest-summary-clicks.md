# 026 — Interest summary and click tracking

**Status:** Approved  
**Milestone:** Final (week 6)  
**Depends on:** 021 (`llm_usage`, `reserve_llm_call`, Tune feed page, scorer signals), 025 (current `get_feed`, member links)  
**Estimate:** 18 h

## Goal

Two optional features from [plan.md §4.2](../plan.md):

1. **Interest summary:** on request, an LLM turns the user's likes, dislikes, and preferences into a short readable profile on the Tune feed page. It is display only and does not affect ranking.
2. **Click tracking:** opening an item from the feed is recorded and used as a weak positive signal (weight 0.3, [design.md §2.1](../design.md#21-interest-scoring-nearest-liked-item)). Opened items leave the feed like _Seen_ items, and a History page lists opened and _Seen_ items so the user can find them again.

## Context

- LLM usage rules and per-user limit: [design.md §2.5](../design.md#25-llm-usage-limited), [§6.8](../design.md#68-llm_usage-per-user); spec 021 request conventions (`lib/preference-tuning.ts`, `lib/openai-response.ts`)
- Scorer and signal rules: [design.md §2.1–2.3](../design.md#2-recommendation); `ranking_private.rank_items`, `public.rank_items` (migration `20261123000200`), `public.get_feed` (migration `20261127000000`)
- Feed card links: `components/content-card.tsx`, `app/feed/feed-list.tsx`; feedback server actions: `app/feedback/actions.ts`
- Covered-story filter references: [spec 025](025-same-story.md); Liked page pattern: `app/(app)/liked/`; main navigation: `components/app-nav.tsx`
- Tune feed page: `app/(app)/preferences/tune`; privacy page: `app/(app)/privacy/page.tsx`
- Cut order: [plan.md §9](../plan.md#9-decision-gates-and-cut-order) (interest summary 4, click tracking 5)

## In scope

- `interest_summaries` (per-user) table, a new `interest_summary` kind in `llm_usage`, a server action that generates and stores the summary, and a section on the Tune feed page.
- `item_clicks` (per-user) table, a server action that records a click from feed links, and clicks as weak positive signals in the scorer and `get_feed`.
- Opened items excluded from later feed loads and used as covered-story references, as _Seen_ items are.
- A History page (main navigation) listing opened and _Seen_ items, 20 at a time with **Load more**, with the usual feedback buttons.
- Two-user RLS tests for both tables; a small manual check of summary quality.
- Privacy page and design docs updated for clicks and the data sent to OpenAI.

## Out of scope

- Scheduled or automatic summary generation.
- Using the summary in ranking, or turning summary topics into preferences.
- Tuning or evaluating the click weight; changes to the evaluation, frozen parameters, or the test-window result.
- Impression tracking, skip signals, or "skip above click" ([design.md §7.5](../design.md#75-not-included)).
- Recording clicks on the Liked page, the History page, the guest feed, or the Sources page.
- Deleting clicks or clearing history (account deletion removes them).
- Search on the History page.

## Design notes

### Interest summary

**When it runs:** on demand. The Tune feed page shows the stored summary, if any, with its generation time. A **Summarize my interests** button generates it the first time and regenerates it later. It never runs automatically on page load, so viewing the page never spends an LLM call.

**Server action `summarizeInterests()`**

1. Verify the user with `getClaims()`.
2. Read the inputs with the user's client (RLS): the titles of the 50 most recently updated likes and the 20 most recently updated _Not interested_ items (`updated_at desc, item_id`), and the labels of the active preferences by direction. Each title is trimmed and cut to 200 characters. Nothing else is sent: no source names, item IDs, URLs, descriptions, clicks, Seen items, or account fields. Titles are public and enough to name topics.
3. Require at least 3 positive signals (likes plus `more` preferences); otherwise return `not_enough_signals` without reserving a call. The page explains this and disables the button.
4. Reserve one call with `reserve_llm_call('interest_summary')` (limit 10 per rolling 24 hours, counted separately from the 10 `preferences` requests). On error, null, or false, return the limit message and the remaining count.
5. Call `gpt-6-luna` with the spec 021 conventions: Responses API with plain `fetch`, `reasoning: {effort: "none"}`, `store: false`, no tools, at most 600 output tokens, 20 s timeout, response body at most 64 KB. The fixed English instruction goes in `instructions`. The input is one JSON document `{liked: string[], not_interested: string[], more: string[], less: string[]}`, passed separately as untrusted data, never as instructions. Strict JSON output schema: `{summary: string, topics: string[]}`, where `summary` is 1–3 English sentences (at most 400 characters) and `topics` lists at most 8 short labels (each at most 40 characters). It mentions what the user avoids only when the dislikes or `less` preferences show it.
6. Validate locally without recovering fragments. A response that is not `completed`, a malformed or schema-violating payload, or a blank or over-length `summary` is a failure. An individual topic that is blank or over 40 characters is dropped, and the rest are kept.
7. On success, upsert the user's single row with the service-role client, setting `user_id` from the verified claims, then return the summary, topics, generation time, and remaining count. On failure, the previous summary is kept unchanged and an error code is returned. In both cases the reservation from step 4 stays counted. Logs contain status codes only, never inputs or outputs.

**Server action `clearInterestSummary()`** verifies the user with `getClaims()` itself and deletes the row through the user's client, so RLS limits it to the caller's row.

**Data model** (added to design.md §6)

- `interest_summaries` (per-user): `user_id` PK (FK → `auth.users`, cascade), `summary text not null` (1–400 characters), `topics text[] not null` (at most 8), `like_count integer not null`, `generated_at timestamptz not null default now()`. RLS owner-only `select` and `delete`. There is no user `insert` or `update`; only the server action writes, with the service role after `getClaims()`.
- `llm_usage.kind` allows `preferences` and `interest_summary`. `reserve_llm_call` accepts both, with a limit of 10 each, counted per kind; the function and its grants are replaced, otherwise unchanged.

**UI** (Tune feed page, above the request form)

- A "Your interests" `Card`: the summary as plain text, topics as `Badge`s, "Based on _n_ likes, _date_", the button with pending and error states, and the remaining count. An `Empty` state appears before the first summary.
- A **Clear** button calls `clearInterestSummary()`.

### Click tracking

**Recording**

- Recording is best-effort on native link activation. Feed card title links and same-story member links ("Also covered by") call `recordClick(itemId)` on primary click, Enter, and middle-click (`auxclick` with button 1); a member link records the member's ID, never the representative's. Context-menu opens (for example "Open in new tab") are not recorded. A click suppressed after a swipe gesture is not recorded.
- The call is fire-and-forget. The links keep `target="_blank"`, so the feed page stays alive; the call never delays or blocks navigation, changes no card state, and ignores failures silently.
- `recordClick` verifies the user with `getClaims()`, validates the UUID at runtime, and calls `record_click(p_item_id uuid)`: `SECURITY INVOKER`, empty search path, user from `auth.uid()`. It is executable by `authenticated` only and inserts `(item_id)` with `on conflict do nothing`. A readable item ID is required (RLS on `content_items`). The first click is kept, and repeated clicks are no-ops.
- `item_clicks` (per-user): `user_id` (default `auth.uid()`, cascade), `item_id` (FK → `content_items`, cascade), PK `(user_id, item_id)`, `clicked_at timestamptz not null default now()`. RLS owner-only `select` and `insert` (column grant on `item_id` only); no update or delete policy.

**Effect on the feed**

- Opened items are excluded from later `get_feed` candidates, like rated items. The clicked card stays where it is in the current list (no re-fetch or re-rank, [design.md §7.1](../design.md#71-actions)), so the user can still rate it when they come back; later pages exclude it through the loaded IDs as before.
- Opened items are covered-story references (spec 025) with the same eligibility and the same language-independent threshold ($\ge 0.74$ regardless of language, unchanged). Rated and opened items are merged by item ID first; each item's event time is the later of `feedback.updated_at` and `clicked_at`. Then the eligible ones published in the last 30 days are ordered by event time desc, `item_id`, and capped at 300.
- **One snapshot:** `get_feed` only reads, so it is declared `STABLE` (the private scorer already is). All its statements then see one snapshot: candidates, references, signals, and reasons cannot disagree when feedback or clicks change during a call.

**Scoring**

- The private scorer and the public wrapper get `p_click_ids uuid[] default '{}'` after the existing parameters. Duplicate IDs are ignored. An ID that is also in the like or dislike list raises an error, matching spec 021.
- Eligibility is the same as for likes. Clicks join the positive signals with weight $w = 0.3$ (constant); likes and `more` preferences keep weight 1. Similarity is centered or raw as the method's `centered` parameter says, as today. A click's value for candidate $c$ is $v = 0.3 \cdot \text{sim}(c, k)$, and only when $\text{sim}(c, k) > 0$. A click with nonpositive similarity contributes nothing to the nearest term, `top_m_mean`, or the explanation, so it can never raise an unrelated item.
  - `nearest_liked`: the maximum of the existing positive similarities and the click values.
  - `top_m_mean`: the mean of the top $m$ values among the existing positive similarities and the click values (fewer than $m$ values: their mean, as today).
  - `average_vector`: the weighted mean of positive vectors, with weight 1 for each like and `more` preference vector (as today) and 0.3 for each click vector; then similarity to it as today. This term can move either way; it is not promised to rise.
  - `blend`: the same $\alpha$ combination of the two terms above. `newest_first` and `random` ignore clicks.
- Clicks change only the base interest score. MMR's diversity term, exploration eligibility (the "liked source" set), and cold start ignore clicks; MMR and exploration rank by the final score as today. **Clicks do not start personalization:** it still requires an eligible like or `more` preference, so a single click cannot personalize a cold-start feed.
- **Explanation:** the positive signal with the highest value (similarity for likes and preferences, $v$ for clicks); ties prefer likes, then preferences, then clicks, then the smaller ID. Reason precedence in `get_feed`: `exploring`, `preference`, `opened`, `similar`, `recent`.
- `get_feed` passes the caller's 200 most recent eligible clicks on items without feedback (explicit feedback overrides clicks). Because feedback and clicks are read in one snapshot, a click ID can never also be a like or dislike there. When `because_item_id` is one of those clicks, the reason is `opened` and the card says "Similar to _X_, which you opened".
- Example: opened → marked _Seen_ → Undo. While Seen exists, the click is not a signal; after Undo (feedback deleted) it is a signal again. Throughout, the item stays out of candidates because it was opened.
- Without clicks, every result is identical to today's, so the evaluation replay (which passes no clicks), the freeze, and the frozen results are unaffected. They measure ranking without clicks; the click weight is an untuned assumption, documented as a limitation.
- Migration safety as in spec 021: drop and recreate both scorer functions and `get_feed` by exact signature in one transaction without `CASCADE`; restore grants, `SECURITY INVOKER`, and empty search paths exactly; update the `with ordinality` alias lists. The only intended attribute change is `get_feed` becoming `STABLE`.

### History page (`/history`)

- "History" is added to the main navigation after Liked (signed-in users only). The page verifies the user with `getClaims()` itself and redirects without one.
- It lists items the user opened from the feed or marked _Seen_, newest first by event time (`clicked_at` or the `seen` feedback's `updated_at`, the later of the two for an item in both). Each item appears once, with an "Opened" or "Seen" badge (both when both apply).
- `get_history(p_limit integer default 20, p_before_at timestamptz default null, p_before_id uuid default null)`: `STABLE`, `SECURITY INVOKER`, empty search path, user from `auth.uid()`, executable by `authenticated` only. It returns item card fields, `event_at`, `opened`, `seen`, and the current feedback kind. Keyset pagination on `(event_at desc, item_id desc)`; the limit is clamped to 1–50.
- History is a live list: an item's event time and membership change when Seen is added, replaced, or removed. Pagination is gap-free and repeat-free only while the data is unchanged; the client tolerates changes between pages.
- The first page loads on the server. **Load more** calls a server action that verifies the user itself and requests `limit + 1` rows after the last row shown. It passes that row's `event_at` exactly as returned (the timestamp string, not a rounded JavaScript `Date`) and its `item_id`. The action returns the first `limit` rows and `hasMore`. The client appends rows whose IDs are not already shown and hides **Load more** when `hasMore` is false, so a total that is an exact multiple of 20 needs no empty final click. Pending and error states are shown, and an `Empty` state appears when there is no history.
- Cards reuse `ContentCard` with the feed's Like, Not interested, and Seen buttons, using the existing feedback actions. Unlike the Liked page, which only has Unlike, each card's pressed state starts from the returned feedback kind and updates in place. Cards, their order, and the cursor stay mounted after a change; there is no reload. On the next fresh load, a Seen-only item that is no longer Seen (cleared or replaced by Like or Not interested) is absent, while an opened item stays whatever its feedback. History links do not record clicks.
- Items from hidden sources are still listed; history is a record, not a feed.

### Privacy page

- **Information we process:** feed items you open, with the time of the first open; your interest summary, if you create one.
- **How we use it:** opened items are a weak signal for similar items, are not shown in the feed again, and are listed in History. The interest summary is shown only to you, and **Clear** deletes it.
- **Providers:** remove the statement that no personal feedback is sent to OpenAI. Say instead that when you request an interest summary, the titles of your recent liked and _Not interested_ items and your preference labels are sent to OpenAI, and that Tune feed requests send your request text. No source names, account information, or click history is sent.

## Acceptance criteria

Each criterion belongs to one task. Tasks 1–4 (clicks, History, and their privacy text) are one release unit: they are merged and deployed together, and clicks are not recorded in production before History and the disclosure exist. Tasks 5–6 (interest summary) can be cut independently.

1. **Task 1 — clicks table and recording action**
   1. `supabase db reset` applies the migration; `record_click` is `SECURITY INVOKER` with an empty search path and executable by `authenticated` only.
   2. Two-user tests: user A cannot read B's clicks or insert a click for B; `anon` has no access; a repeated click keeps the first `clicked_at`; an unreadable or unknown item ID fails.
   3. Unit tests for `recordClick`: unverified users and invalid IDs make no RPC call; errors return a generic failure.
2. **Task 2 — clicks in ranking and the feed**
   1. Before the migration, a parity baseline is captured: a fixture at a fixed time with likes, dislikes, a preference, and a same-story group, run through `get_feed` and the wrapper for each method. After it, with no clicks, the order, scores, reasons, explanations, and `duplicate_of` are identical.
   2. Scorer and `get_feed` grants, `SECURITY INVOKER`, and search paths are restored exactly; `get_feed` is `STABLE`.
   3. Scoring fixtures with hand-computed expected scores for `nearest_liked`, `top_m_mean` (including fewer than $m$ values), `average_vector`, and `blend`, centered and raw: a click with positive similarity adds $0.3 \cdot$ sim where the formula says; a click with negative similarity changes no nearest or top-m value and never becomes the explanation; `newest_first` and `random` are unchanged by clicks.
   4. Integration tests, signals: clicks alone keep a cold-start feed; clicks do not change exploration eligibility; `exploring` beats `opened`; the explanation tie order holds; a clicked item later liked counts only as a like; opened → Seen → Undo suppresses and then restores the click signal while the item stays excluded; another user's clicks have no effect; overlapping like and click IDs passed to the wrapper raise an error.
   5. Integration tests, feed: an opened item is not returned on a later call; a near-duplicate of an opened item is filtered in the same and in the other language at $\ge 0.74$; references merge by item ID before the 300 cap, ordered by latest event time.
   6. Latency: with the spec 025 setup plus 200 clicks, the median of 10 warm `get_feed` calls is under 500 ms; the AI log records the timings.
   7. `pnpm test:integration` passes with 0 skipped.
3. **Task 3 — History page**
   1. `get_history` is `STABLE` and `SECURITY INVOKER` with an empty search path, executable by `authenticated` only. Integration tests: opened-only, Seen-only, and both items each appear once with the right flags and event time; keyset pages over unchanged data have no gaps or repeats, including equal timestamps; the limit clamp holds; user A never sees B's history; `anon` is denied.
   2. Component and action tests: History appears in the navigation only for signed-in users; the empty state and badges; pressed states start from the returned feedback and update in place without reloading the list; **Load more** appends the next page, shows pending and error states, skips IDs already shown, and is hidden after the last page, including when the total is exactly 20 or 40; Seen removed between pages causes no duplicate card; on a fresh load, a Seen-only item whose Seen was cleared or replaced is absent and an opened item remains; history links do not record clicks.
4. **Task 4 — feed click UI and click privacy text**
   1. Component tests: title and member links call `recordClick` with the right ID on primary click, Enter, and middle-click; a member link never records the representative; context-menu opens and post-swipe clicks are not recorded; navigation is not prevented; a failing call shows nothing; the clicked card stays in place; the card says "Similar to _X_, which you opened" for the `opened` reason; guest and Liked cards do not record.
   2. Browser smoke check on local Supabase: opening a card title and a member link with a click, with Enter, and with a middle-click each opens the correct URL in a new tab and leaves the matching `item_clicks` row. The next feed load omits the opened items, and History lists them.
   3. The privacy page states what is recorded for opened items and how they are used, as described above.
5. **Task 5 — interest summary backend and check**
   1. Migration: `interest_summaries` with RLS. Two-user and role tests: owner-only read and delete; `anon` is denied; authenticated users cannot insert or update any row directly. `reserve_llm_call('interest_summary')` allows 10 per rolling 24 hours, counted separately from `preferences`, with the existing concurrency and expiry behavior covered for the new kind; an unknown kind is rejected.
   2. Unit tests for `summarizeInterests` and `clearInterestSummary`: no claims or fewer than 3 positive signals means no reservation and no call; the limit is checked before any fetch; the exact outbound request body is asserted (instructions, titles cut to 200 characters, labels by direction, and no other fields); a non-completed, malformed, or invalid-summary response saves nothing, keeps the previous summary, and still counts; invalid topics are dropped and the rest saved; nothing is logged beyond status codes; Clear verifies claims and deletes only through the user's client.
   3. **Check:** `pnpm eval:interest-summary` refuses CI and reuses the existing snapshot and label validation. It uses the frozen snapshot, the committed Qwen label set, and the feedback window. Inputs cover the 4 single personas and the pairs ai-software + finnish-sports and cars-engineering + science-space. Liked titles are the persona's relevant items ordered by `published_at desc, id`, at most 50; a pair alternates its two members, so both are represented. _Not interested_ titles are the 20 newest items relevant to none of them. The sampling is committed before the first run, and the script runs the prompt once. The user marks a summary correct if it names every interest that the actual inputs support (both members for a pair) and invents none. Target: at least 5 of 6; otherwise stop and discuss (no tuning loop). Results go in `evaluation/interest-summary/` (titles gitignored).
6. **Task 6 — Tune page, summary privacy text, and docs**
   1. Component tests: empty state, stored summary with topics and date, pending and error states, the not-enough-signals and limit messages, Clear.
   2. The privacy page states the summary storage, Clear, and what is sent to OpenAI, as described above.
   3. design.md §2.1 (click weighting, no tuning), §2.2 (opened items excluded and used as story references; `get_feed` is `STABLE`), §2.5 (interest summary), §6 (new tables, `llm_usage` kinds), and §7 (opened explanation, recording, History page) are updated; plan.md §7.1 marks the spec; the AI log entry follows AGENTS.md (the agent asks the user to confirm the model first).
7. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [ ] 1. `item_clicks`, `record_click`, `recordClick` action, two-user tests (criterion 1).
- [ ] 2. Scorer and `get_feed` with click signals, one snapshot, opened-item exclusion and story references, parity, latency (criterion 2).
- [ ] 3. `get_history` and the History page with Load more (criterion 3).
- [ ] 4. Record clicks from feed and member links; "which you opened" explanation; browser check; click privacy text (criterion 4). Tasks 1–4 ship together.
- [ ] 5. `interest_summaries`, `interest_summary` usage kind, `summarizeInterests`, `clearInterestSummary`, check (criterion 5).
- [ ] 6. Tune page summary section, summary privacy text, docs (criterion 6).

## Decisions

- The summary is generated on demand, not on a schedule and not on page load: no cron job and no calls for users who never look. The limit is 10 per rolling 24 hours, like Tune feed requests; each call is small (titles only, at most 600 output tokens).
- The summary is shown on the Tune feed page because it is the page about steering the feed, and seeing the profile next to the preferences helps the user decide what to change.
- Summary inputs are the titles of recent likes and dislikes plus preference labels, nothing else. Seen items are neutral and clicks are noisy, so both are left out. Titles alone keep the request small and limit what is sent.
- Clicks use the weight 0.3 from design.md §2.1 without tuning: the replay has no click behavior to simulate, and the frozen results are not re-run. This is accepted and documented.
- Clicks only add positive evidence: a click with nonpositive similarity is ignored, so the weight cannot turn a dissimilar click into a boost.
- Clicks do not start personalization, so an accidental click cannot take over a cold-start feed.
- `get_feed` becomes `STABLE` so that a feedback or click change during a call cannot produce inconsistent inputs; it never writes.
- Opened items leave the feed on later loads, like _Seen_: the user has read them. The clicked card stays in the current list so it can still be rated, and the History page keeps opened items reachable and rateable later.
- Opened items are covered-story references, consistent with treating them like _Seen_: another version of a story the user has read is not shown again. Spec 025's threshold is applied regardless of language, so a misclick hides that item and its near-duplicates in either language.
- History shows both opened and _Seen_ items because both mean "already consumed", and the user may want either back. It is a separate page in the main navigation, paginated 20 at a time with **Load more**, which keeps the first load small. It is a live list; pagination promises no gaps or repeats only for unchanged data.
- Clicks, History, and their privacy text ship together, so no click is collected without the user being able to see it and read about it. The interest summary is independent and can be cut.
- Clicks cannot be deleted by the user; account deletion removes them.

## Open questions

- None.
