# 025 — Same-story handling

**Status:** Approved  
**Milestone:** Final (week 6)  
**Depends on:** 006 (near-duplicate threshold, cross-lingual pairs, frozen snapshot), 022 (hidden sources and card masking)  
**Estimate:** 9 h

## Goal

Stop the feed from repeating one story. Versions of a story the user has already rated are not shown again, and versions within a page are grouped into one card with "Also covered by". Embeddings only; no LLM.

## Context

- Near-duplicate rule in the evaluation: [design.md §4.3](../design.md#43-protocol-safeguards) (centered similarity ≥ 0.74 to any feedback item is removed before ranking for the headline metric); frozen threshold in `evaluation/frozen-params.json`
- Cross-lingual check: `evaluation/crosslingual/score.json` (28 confirmed Yle Finnish–English same-event pairs; centered similarity 0.26–0.67, median 0.51; random-pair 95th percentile 0.16)
- Feed function: `public.get_feed` (latest migration); scorer `ranking_private.rank_items` (unchanged here)
- Feed UI, masking, and Undo: `app/feed/feed-list.tsx`, `components/content-card.tsx` ([spec 022](022-hide-source.md))
- Plan item: "Same-story grouping with embeddings and Jev" ([plan.md §7.1](../plan.md)); Jev is dropped per [spec 009](009-description-quality-jev.md)'s recommendation

## In scope

- **Covered-story filter:** `get_feed` drops candidates that are near-duplicates of items the user has rated.
- **Grouping:** `get_feed` marks near-duplicates among the rows it already returns, so the card for the highest-ranked version lists the other versions.
- A small script with example groups for review and the cross-lingual numbers.

## Out of scope

- Changes to the scorer, signals, or the evaluation; the guest feed; the Liked page.
- Jev or any LLM for grouping.
- Grouping across pages (see Decisions).

## Design notes

**Similarity and eligibility**

- Centered cosine similarity on `text-embedding-3-small@512`, computed as in the scorer (language means, zero-vector similarity 0).
- Eligible items on both sides of every comparison meet the scorer's eligibility for signals: active embedding model, embedding present, matching language mean, completed enrichment, nonblank summary. Ineligible items are never filtered, used as references, or grouped.
- Same-language threshold $T = 0.74$ (the frozen evaluation threshold).
- Finnish–English threshold $T_{xl}$ for grouping only, chosen by the rule under **Checks**. If cross-language grouping is disabled, $T_{xl}$ is off and only same-language pairs group.

**Covered-story filter** (`get_feed` candidate selection, before ranking)

- **References:** the caller's rated items of any feedback kind (like, not interested, seen), selected independently of the candidate query (which already excludes rated IDs): eligible, published in the last 30 days, ordered by `feedback.updated_at desc, item_id`, at most 300. Items from hidden sources and items in `p_exclude` remain valid references; preferences are not references.
- A candidate is dropped if its similarity to any reference is at least $T$, regardless of language. $T_{xl}$ is not used here: a wrong match would hide a story entirely.
- Production shares the evaluation's threshold rule (centered, 0.74, applied before ranking), not its whole protocol: replay uses sampled likes and dislikes, no seen items, and publication-split windows.
- Hidden-source filtering (spec 022), the rated-item exclusion, cold start, preferences, and exploration are otherwise unchanged; a cold-start user with only seen items is filtered the same way.

**Grouping** (`get_feed`, after ranking; `limit` still counts rows)

- `get_feed` calls the scorer with the same `limit` as today and returns exactly the same rows in the same order. Grouping only adds a last return column `duplicate_of uuid`.
- Walk the returned rows in rank order. A row joins the earliest earlier representative it matches (same language: $\ge T$; Finnish–English: $\ge T_{xl}$ when enabled) if that group has fewer than 5 rows in total including the representative; otherwise it is a representative (`duplicate_of` null). Ties are impossible because the walk is ordered.
- Exploration-flagged rows never join or lead a group, so exploration slots keep their positions and visibility.
- A page may therefore show fewer than `limit` cards. Pagination, completeness detection (raw row count against `limit`), the 1,000-ID exclusion clamp, and all clamps are unchanged. Matches beyond the page are not grouped.
- Return-type change: `get_feed` is dropped and recreated by exact signature without `CASCADE`, with its grants and `SECURITY INVOKER` restored exactly (spec 021 pattern).
- With no references matching and no groups, the rows equal the previous order, scores, reasons, and explanations, with `duplicate_of` null.

**Feed UI**

- `FeedItem` gets `duplicate_of`. The list renders one card per representative; members appear on it as "Also covered by: _source_ · _source_". Members are never separate cards.
- Member links sit above the card's stretched article link, are keyboard-focusable, accept only HTTP(S) URLs, and have the accessible name "_source_: _title_". Activating one opens the member and records no feedback.
- Feedback buttons, gestures, and the card menu act on the representative only. After the representative is rated, the filter removes members at $\ge T$ on the next load. A Finnish–English member below $T$ can appear once more as its own card; this is documented and tested.
- All loaded IDs, members included, stay in pagination exclusions (unchanged, since members are ordinary rows).
- Hidden sources (spec 022 mask): a group is masked when its representative's source is hidden; members from hidden sources are left out of the "Also covered by" line. Undo restores the group with its members, order, and the representative's feedback state, including rows from late-arriving pages.
- Guest feed and Liked page rendering are unchanged.

**Checks** (no labeling; frozen snapshot, read-only)

- `pnpm eval:story-groups` reads the frozen snapshot (with the existing snapshot validation in `scripts/evaluation-crosslingual.mts`), refuses to run in CI, and writes `evaluation/story-groups/report.json` (committed: IDs, similarities, denominators, hashes, decisions, chosen $T_{xl}$) and `review.csv` (gitignored, contains titles).
- **Stand-in pages:** validation-window items grouped by UTC publication day, each day ordered by `published_at desc, id`, split into pages of 30 rows; the same walk as production runs on each page. Golden cases shared with the SQL tests check that both implementations agree.
- **Review pairs:** representative–member edges from the stand-in pages, canonicalized by ID, excluding the 28 confirmed pairs and already reviewed pairs, sorted by similarity ascending from the threshold, then by IDs. Deterministic, no seed.
- **Rubric** (fixed before review): "same story" means the same underlying event or announcement. Follow-ups, recurring reports (e.g. different games or weekly results), and merely related topics are "different story". Uncertain counts as different.
- **$T_{xl}$ rule:** start at 0.50 (16 of the 28 confirmed pairs reach it). Review the first 10 Finnish–English edges. If at least 9 are the same story, keep $T_{xl}$. Otherwise raise it to 0.55 (6 of 28) and review the first 10 edges not yet reviewed. If that fails, or fewer than 10 edges exist at a step, disable cross-language grouping.
- **Same-language check:** the first 5 Finnish and 5 English edges at $T$; at least 9 of 10 must be the same story, otherwise stop and discuss.
- At most 30 pairs in total. The results are a small diagnostic, not validation of all production matches.

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — checks and threshold**
   1. Unit tests for the grouping walk: rank order, earliest matching representative, the 5-row cap including the representative, language-pair thresholds, $T_{xl}$ off, exploration rows never grouped, ineligible items never grouped; golden cases are exported for the SQL tests.
   2. Unit tests for the review selection: day and page boundaries, deterministic order, exclusion of confirmed and reviewed pairs, the insufficient-pairs outcome.
   3. The script reads only the frozen snapshot, refuses to run in CI, and writes the report and the gitignored review file. The user's review is recorded and $T_{xl}$ is chosen by the rule.
2. **Task 2 — `get_feed`**
   1. `supabase db reset` applies the migration; grants and `SECURITY INVOKER` are restored exactly.
   2. Covered-story filter, with controls where the items do appear: a near-duplicate of a liked, a not-interested, and a seen item is dropped; a rated item older than 30 days and the 301st reference do not filter; wrong-model, missing-mean, and zero-vector references do not filter; a hidden-source reference still filters; a Finnish–English pair above $T_{xl}$ but below $T$ is not filtered; another user's ratings do not filter; a cold-start user with only seen items is filtered.
   3. Grouping: the returned rows and order equal the scorer's for the same `limit`; members have `duplicate_of` set; the 5-row cap holds; exploration rows are never grouped; cross-language grouping follows the chosen $T_{xl}$; the golden cases match the offline walk.
   4. Existing fixtures with identical like and candidate vectors are updated narrowly; scorer-only assertions are unchanged; a parity fixture without matches, at a fixed time, returns the previous order, scores, reasons, and explanations.
   5. Latency: on local Supabase with snapshot items copied into a disposable fixture and time-shifted so they fall in the live windows (frozen files untouched), with 200 likes, 200 dislikes, and 100 seen items, after warm-up and under identical conditions before and after the change, the median of 10 `get_feed` calls is under 500 ms and at most twice the time before. The AI log records candidate and reference counts, timings, and the query plan.
   6. `pnpm test:integration` passes with 0 skipped.
3. **Task 3 — feed UI and docs**
   1. Component tests: one card per group; member links above the stretched link with "source: title" names, keyboard focus, HTTP(S) only, opening without feedback or representative navigation on desktop and touch; feedback, gestures, and the menu act on the representative; a page with fewer cards than rows still paginates; mask and Undo restore groups with members, order, and feedback state, including late-arriving pages; hidden-source members are omitted.
   2. design.md §1 (same story from several sources), §2.2, §4 (frozen results measure the unchanged ranking, not the grouped feed), and §7 describe the filter and grouping; plan.md §3 and §10 say grouping uses embeddings only; an AI log entry follows AGENTS.md (the agent asks the user to confirm the model first).
4. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [ ] 1. Grouping walk and review selection as tested functions, `pnpm eval:story-groups`, review, $T_{xl}$ decision (criterion 1).
- [ ] 2. Migration: covered-story filter, `duplicate_of` grouping, fixture updates, tests, latency check (criterion 2).
- [ ] 3. Grouped cards in the feed, docs (criterion 3).

## Decisions

- Embeddings only. Spec 009 found that Jev added nothing over simpler rules, and grouping needs no text generation.
- The covered-story filter shares the evaluation's threshold rule; the scorer and the frozen results are untouched, and those results measure the ranking, not the grouped feed.
- A separate Finnish–English threshold applies to grouping only: none of the 28 confirmed same-event pairs reaches 0.74, while a wrong cross-language match in the filter would hide a story completely.
- `limit` keeps counting rows, so pagination, exclusions, and their clamps stay exactly as they are. Pages may show a few fewer cards; infinite scroll loads the next page.
- Exploration rows are not grouped, so exploration stays visible at its positions.
- Grouping is per page. Versions on a later page, and Finnish–English members below 0.74, can still appear once; same-language versions disappear after the user rates any version.
- Members get no feedback rows: the filter hides same-language members after the representative is rated, which keeps Undo simple.

## Open questions

- None.
