# 028 — Trending stories

**Status:** Cut before implementation (data check: too few qualifying stories)  
**Milestone:** Final (week 6)  
**Depends on:** 025 (centered similarity, eligibility, grouping walk, grouped cards), 022 (hidden sources), 026 (click recording)  
**Estimate:** 9 h

## Cut decision

The user cut this spec on 27 Nov 2026 before implementation. An independent review (GPT-6.2 Sol) ran a read-only diagnostic of the walk and the 3-publisher rule over the 3,283 manifest-listed items of the frozen snapshot (28 Oct – 11 Nov 2026, 16 sources). It found 9, 11, and 17 qualifying stories in total at 0.74, 0.68, and 0.62, across about 15 days. That is at most about one story per day, below this spec's threshold rule of at least 2 per window at any candidate threshold. The diagnostic is not the full task 1 check (no coherence review), and current production, with 20 active sources, was not checked. The design and the review findings are kept below in case trending is revisited with more sources.

## Goal

Show the stories that several publishers are covering right now. A Trending page lists stories covered by at least 3 publishers in the last 24 hours, one grouped card per story. Embeddings only; no LLM.

## Context

- Same-story machinery: [spec 025](025-same-story.md) (centered similarity, eligibility, the rank-order walk, `duplicate_of`, "Also covered by" cards); `lib/story-groups.ts`; `pnpm eval:story-groups`
- Spec 025 findings that shape this spec (`evaluation/story-groups/report.json`): at the same-language threshold 0.74, the 887 validation items had only 1 Finnish and 7 English edges, and the Finnish–English threshold stayed disabled for lack of pairs. Stories covered by 3 or more publishers at 0.74 may therefore be rare, which is why task 1 is a data check with a go/no-go gate.
- Volume: about 130–340 eligible items per UTC day in the frozen snapshot (17 active sources); catalog approvals (spec 027) may add more.
- Feed cards, feedback, masking: `app/feed/feed-list.tsx`, `components/content-card.tsx`; click recording: spec 026; navigation: `components/app-nav.tsx`

## In scope

- A data check on the frozen snapshot that chooses the story threshold or stops the spec.
- `get_trending()`: a read-only SQL function that clusters the last 24 hours of eligible items per request.
- A `/trending` page in the main navigation with grouped cards, feedback buttons, and click recording.

## Out of scope

- An LLM-written story headline or summary.
- Finnish–English story clustering (disabled by spec 025; revisit only if task 1 finds enough pairs).
- Trending in the feed itself, the guest preview, or notifications.
- A shared cache (added later only if the latency check fails).
- Changes to ranking, `get_feed`, or the evaluation.

## Design notes

**Eligibility and similarity** (as spec 025)

- Items from active sources, published in the last 24 hours and not in the future, that meet the scorer's eligibility: active embedding model, embedding present, language mean present, enrichment completed, nonblank summary. Articles and videos alike.
- Centered cosine similarity on `text-embedding-3-small@512`; zero vectors have similarity 0.
- Same-language pairs only. The story threshold $T_s$ is chosen in task 1; it is at most 0.74.

**Publishers**

- A publisher is the item URL's host, lowercased, without a leading `www.`. Several feeds from one site (for example the Yle feeds) count as one publisher. Hacker News items link to the original site, so they count under that site's host.

**Clustering** (per request, inside `get_trending`)

- Walk the eligible items in `published_at asc, id` order. Each item joins the earliest earlier representative of the same language with similarity at least $T_s$; otherwise it becomes a representative. Comparing only against representatives avoids chaining unrelated items.
- A story is trending when its items come from at least **3** distinct publishers. Stories are ordered by distinct publishers desc, then newest item `published_at` desc, then representative ID. At most 10 stories are returned (`p_limit`, clamped to 1–20).
- The representative (the earliest item) leads the card; the other items are members, newest first. A card shows at most 5 members, plus "and _n_ more".

**Per-user view**

- Items from the caller's hidden sources are removed **before** clustering, so a hidden source never appears and never counts as a publisher.
- Rated and opened items stay: trending is informational. Each row returns the caller's current feedback kind, so cards show the pressed state.

**`get_trending(p_limit integer default 10)`**

- `STABLE`, `SECURITY INVOKER`, empty search path; user from `auth.uid()`; executable by `authenticated` only, revoked from `PUBLIC` and `anon`.
- It returns one row per shown item: the item card fields, `source_id`, `story_id` (the representative's ID), `is_representative`, `publisher_count`, `story_rank`, and `feedback_kind`. Members beyond 5 per story are not returned; `member_count` gives the full number.
- The clustering is shared with the offline check through golden cases, as in spec 025.

**Trending page** (`/trending`)

- "Trending" is added to the main navigation for signed-in users. The page verifies the user with `getClaims()` itself and redirects without one; `/trending` is added to the session-refresh routes in `proxy.ts`.
- Each story is one card built from the existing grouped card: the representative's title, source, time, and summary; a badge "Covered by _n_ publishers"; and the "Also covered by" member links (HTTP(S) only, keyboard-focusable, accessible name "_source_: _title_").
- Like, Not interested, and Seen act on the representative through the existing feedback actions; cards stay in place with their pressed state. Hide source works through the existing card menu and masks every card from that source on the page, with Undo.
- Opening the representative or a member link records a click (spec 026), with the same activation rules as the feed.
- An `Empty` state when no story qualifies: "No story is being covered by three or more publishers right now." A **Refresh** button reloads the page.

**Checks** (task 1, frozen snapshot, read-only)

- `pnpm eval:trending` refuses CI, validates the snapshot as `scripts/evaluation-crosslingual.mts` does, and runs the same walk over rolling 24-hour windows ending at each UTC midnight in the snapshot. It does this for $T_s \in \{0.74, 0.68, 0.62\}$, with the same eligibility rules and the publisher definition above.
- For each threshold, it reports the stories with at least 3 publishers per window (mean, min, max). It writes `evaluation/trending/report.json` (committed: IDs, counts, similarities, hashes, decision) and `review.csv` (gitignored, with titles).
- **Threshold choice:** the highest threshold with a mean of at least 2 qualifying stories per window.
- **Coherence review:** for that threshold, the first 20 qualifying stories, ordered by window then story rank. A story is coherent if every shown item covers the same underlying event or announcement (spec 025 rubric: follow-ups, recurring reports, and merely related topics are different stories; uncertain counts as different).
- **Gate:** at least 16 of 20 coherent. If no threshold reaches 2 stories per window, or the review fails, stop and discuss. There is no tuning loop.

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — data check and threshold**
   1. Unit tests for the walk (order, earliest representative, no chaining, same-language only), the publisher host rule (case, `www.`, several feeds of one site), the 3-publisher rule, ordering and clamps, and the window boundaries; golden cases are exported for the SQL tests.
   2. `pnpm eval:trending` reads only the frozen snapshot, refuses CI, and writes the report and the gitignored review file. The user's review is recorded, and $T_s$ is chosen by the rule or the spec stops.
2. **Task 2 — `get_trending`**
   1. `supabase db reset` applies the migration; the function is `STABLE` and `SECURITY INVOKER` with an empty search path, executable by `authenticated` only; `anon` is denied.
   2. Integration tests: the golden cases match the offline walk; items older than 24 hours, future-dated, ineligible, or from inactive sources are ignored; hidden-source items are removed before clustering and do not count as publishers; two feeds of one host count once; cross-language pairs never cluster; at most 5 members are returned with the correct `member_count`; `feedback_kind` reflects only the caller's feedback; user A's hidden sources do not affect user B.
   3. Latency: on local Supabase with 600 eligible items in the last 24 hours, the median of 10 warm calls is under 300 ms. The AI log records the timings and the query plan; if the target fails, stop and discuss caching.
   4. `pnpm test:integration` passes with 0 skipped.
3. **Task 3 — Trending page and docs**
   1. Component tests: navigation entry for signed-in users only; one card per story with the publisher badge, up to 5 member links and "and _n_ more"; member link names and HTTP(S) filtering; feedback on the representative with pressed states; Hide source masking and Undo; click recording on representative and member links; the empty state; Refresh.
   2. design.md §1 (trending from several publishers), §2 (trending clustering and $T_s$), and §7 (Trending page) are updated; plan.md §7.1 marks the spec; the AI log entry follows AGENTS.md (the agent asks the user to confirm the model first).
4. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [ ] 1. _(Cut)_ Walk and publisher functions, `pnpm eval:trending`, review, $T_s$ decision or stop (criterion 1).
- [ ] 2. _(Cut)_ `get_trending` migration, golden cases, integration tests, latency (criterion 2).
- [ ] 3. _(Cut)_ `/trending` page, navigation, docs (criterion 3).

## Decisions

- Embeddings only, like same-story grouping: no LLM headline. The representative's own title is shown.
- Computed per request in SQL rather than precomputed: about 60,000 comparisons per call at today's volume. That keeps it simple, with no shared cache and no service role. A latency gate guards it.
- The first task is a data check with a gate, because spec 025 found same-story pairs at 0.74 to be rare. A lower threshold is accepted only if a human review finds the stories coherent.
- Publishers, not feeds, are counted, so one site's several feeds cannot make a story trend.
- Hidden sources are removed before clustering, so the page never shows them and they never count toward trending.
- Trending shows rated and opened items with their state instead of hiding them, because it reports what is being covered, not what to read next.
- A separate page in the main navigation, with the 24-hour window.

## Review notes (not applied)

If trending is revisited: make the data check use a hash-pinned bundle and only complete windows; rerun Trending after Hide source and Undo so publisher badges stay correct; sample review stories across dates and ranks and review every contributing item; benchmark a skewed low-match window and center vectors once; define publishers as the URL hostname and decide how Hacker News self-posts count; build on the History page's card state rather than the private feed card; add the Trending page to the privacy text about item opens.

## Open questions

- None.
