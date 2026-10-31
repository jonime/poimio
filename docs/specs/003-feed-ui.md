# 003 — Personalized feed and interaction UI

**Status:** Done
**Milestone:** Prototype (week 3)  
**Depends on:** 001 (content, embeddings, gate 1 result), 002 (login, `feedback`, server actions)  
**Estimate:** 17 h

## Goal

Show each signed-in user a ranked feed of links, personalized by their feedback with nearest-liked scoring on language-centered embeddings, explain every recommendation, and let the user react with buttons or swipe gestures. This completes the prototype shown in the video.

## Context

- Gate 1 decision: nearest-liked on language-centered vectors ([ai-log.md](../ai-log.md), spec 001 task 13)
- Scoring and cold start: [design.md §2.1–2.3](../design.md#2-recommendation)
- Language centering: [design.md §1](../design.md#1-content-sources-and-representation)
- Interaction model: [design.md §7](../design.md#7-user-interaction)
- Feedback storage and server actions: [spec 002](002-auth-feedback.md), `app/feedback/actions.ts`
- Centering reference implementation: `lib/early-ranking.ts` (`centerEmbeddingsByLanguage`)

## In scope

- Shared table `embedding_language_means` and a script that computes and freezes the per-language means.
- SQL function `get_feed` that ranks candidates for the signed-in user and returns explanations.
- Feed page `/` with cards, three action buttons, swipe gestures on touch devices, undo toast, infinite scrolling, and a **Refresh feed** button.
- _Liked_ page listing the user's liked items, with the option to unlike.
- Integration tests for `get_feed` (ranking, isolation, cold start) and unit tests for UI logic.

## Out of scope

- Exploration slots and diversity re-ranking (spec 007).
- Click tracking (spec 007, optional).
- Evaluation-specific parameters such as an "as of" time (spec 006).
- Deployment (spec 004); per-user AI usage limits (spec 007).

## Design notes

**Language means**

- New shared table `embedding_language_means (embedding_model text, language text, mean vector(512), item_count int, computed_at timestamptz)`, primary key `(embedding_model, language)`.
- RLS: `select` for `authenticated` (`get_feed` runs as the caller); writes only with the service role.
- `pnpm embeddings:means` computes the mean embedding per language for the active model from all embedded items and upserts the rows. A language needs at least 50 embedded items to get a mean; smaller groups are skipped and reported. It is run manually; means stay frozen until it is run again. Prints item counts per language.

**Centered similarity**

- The **active model** (`text-embedding-3-small@512`) is a constant in the function's defaults block. Only items with that `embedding_model` are candidates or signals, so vectors from different models are never compared.
- A SQL helper `centered_similarity(a, mean_a, b, mean_b)` returns `1 - ((a - mean_a) <=> (b - mean_b))`. Cosine similarity is scale-invariant, so no re-normalization is needed.
- If either centered vector has zero length (e.g. an item equal to its language mean), the helper returns 0 instead of an undefined value, matching `cosineSimilarity` in `lib/early-ranking.ts`.
- An item is **eligible** if it has an embedding of the active model and a mean row for its `(embedding_model, language)`. Only eligible items are candidates or signals.

**`get_feed(p_limit int default 30, p_exclude uuid[] default '{}')`**

- `SECURITY INVOKER`, `set search_path = ''`, reads the user from `auth.uid()`, raises an error if it is null; no `user_id` parameter. `p_limit` is clamped to 1–100 and `p_exclude` to at most 1,000 IDs. `execute` granted to `authenticated` only.
- Candidates: eligible items published within the window (articles 7 days, videos 30 days) that the user has **not** rated with any action and that are not in `p_exclude`.
- Signals: up to the 200 most recently updated eligible _Like_ items ($P$) and 200 eligible _Not interested_ items ($N$) of the caller. _Seen_ is neutral. Feedback on ineligible items is ignored for scoring (those items are still excluded from candidates).
- **Personalized mode** ($P$ has at least one eligible like):
  - $\text{interest}(c) = \max_{p \in P} \text{sim}(c, p) - \lambda \cdot \max_{n \in N} \text{sim}(c, n)$ (penalty 0 if $N$ is empty).
  - $\text{score} = \text{interest} + \beta \cdot 0.5^{\text{age}/h}$, with half-life $h$ = 24 h for articles, 7 days for videos.
  - Explanation: the liked item with the highest similarity (`reason = 'similar'`, `because_item_id`, `because_title`).
- **Cold start** (no eligible likes):
  - Source-balanced recency: round-robin across sources, newest first within each source.
  - Items with similarity ≥ $\theta$ to any _Not interested_ item are moved after all others, so dislikes work before the first like.
  - Explanation: `reason = 'recent'`.
- Returned columns: item fields needed by the card (id, url, title, summary, type, language, thumbnail_url, published_at, source name), `score`, `reason`, `because_item_id`, `because_title`.
- **Initial defaults** (one clearly marked block in the function; tuned in week 6): $\lambda = 0.5$, $\beta = 0.1$, $\theta = 0.4$, windows and half-lives as above.

**Feed page**

- Server component calls `get_feed` with the session client (never the service role) after verifying the user with `getClaims()`.
- Card: title as a link to the original (`target="_blank"`, `rel="noopener noreferrer"`), source, relative time, thumbnail if any, explanation line, three buttons. Only `http`/`https` URLs are rendered as links.
- External text is rendered as plain text (no `dangerouslySetInnerHTML`). Thumbnails use a plain lazy-loaded image with `referrerPolicy="no-referrer"`; no image proxying.
- Explanation texts per design §7.4: "Similar to _X_, which you liked" / "Recent from _source_".
- Cards already on screen never reorder while the user interacts; **Refresh feed** reloads the whole list from the server.

**Infinite scrolling**

- The first page (30 items) is rendered on the server; further pages are loaded when a sentinel near the end of the list becomes visible (`IntersectionObserver`), plus a visible **Load more** button as an accessible fallback.
- Next pages come from a server action `loadMoreFeed(excludeIds)` that verifies the user with `getClaims()` and calls `get_feed` with the IDs already shown. Exclusion instead of offsets avoids duplicates and gaps when feedback changes between pages, and new feedback is reflected in the next page.
- Only one page request is in flight at a time. When a page returns fewer items than requested, the list shows "You're all caught up" with **Refresh feed**.
- After 1,000 shown items the list stops loading and asks the user to refresh.

**Actions and undo**

- Buttons: 👍 _Like_, 👎 _Not interested_, ✓ _Seen_, with `aria-pressed` and accessible labels. Pressing the active action clears it (`clearFeedback`); choosing another replaces it (`setFeedback`).
- A card's feedback state is `{kind, via}` or none. Undo restores the **previous state exactly**, including `via`: `clearFeedback` if there was none, otherwise `setFeedback(previous.kind, previous.via)`.
- An **Undo** toast (`role="status"`, ~5 s) appears after every action that collapses a card (_Not interested_, _Seen_) and after every swipe, including a right-swipe _Like_.
- _Not interested_ and _Seen_ collapse the card immediately.

**Mutation ordering** (per card)

- Each card keeps a **confirmed** state (last server-acknowledged) and a **displayed** state (optimistic).
- Mutations for one card run **serially** in a queue: a new action, or Undo, while a save is pending is queued and sent after the pending one completes. Different cards are independent.
- Rapid changes end with the server holding the last requested state.
- If a mutation fails, queued mutations for that card are dropped, the displayed state reverts to the **confirmed** state (never to a stale earlier choice), and an error message is shown.
- The queue and state transitions are a pure module so they can be unit-tested with delayed and failing fake actions.

**Swipe gestures** (touch only)

- Implemented with Pointer Events, `pointerType === 'touch'`, and `touch-action: pan-y` on cards; **no new dependency**.
- Direction lock: the gesture becomes horizontal only if horizontal movement exceeds vertical movement after a small slop (~10 px); otherwise the browser scrolls.
- The card follows the finger and reveals a colored background with icon and label ("Like" / "Not interested"). Releasing past 40% of the card width commits; otherwise it snaps back.
- Right = _Like_ (`via = 'swipe'`), left = _Not interested_ (`via = 'swipe'`), each followed by the Undo toast. Swipes go through the same per-card mutation queue as buttons. Buttons stay available on all devices.
- Gesture decisions (lock, threshold, commit/cancel) live in a pure function so they can be unit-tested.

**Liked page**

- `/liked`: the user's liked items, newest like first, read through the session client (RLS limits rows to the owner). Each has an _Unlike_ button (`clearFeedback`).

## Acceptance criteria

Each criterion belongs to one task, so tasks can be completed in order.

1. **Task 1 — language means**
   1. `supabase db reset` applies the migration cleanly; `embedding_language_means` has RLS enabled with `select` for `authenticated` only and no write access for `anon` or `authenticated`.
   2. `pnpm embeddings:means` writes one row per language with at least 50 items for the active model, skips and reports smaller groups, and prints the item counts.
2. **Task 2 — `get_feed` function**
   1. `supabase db reset` applies the migration cleanly; `get_feed` and `centered_similarity` exist; `get_feed` is executable by `authenticated` only.
3. **Task 3 — `get_feed` integration tests** (local Supabase, controlled test embeddings)
   1. Items the caller has rated with any action are never returned.
   2. Another user's feedback has no effect on the caller's feed (isolation), and `because_item_id` is always one of the caller's own likes.
   3. With a like, an item close to the liked item ranks above an unrelated item of the same age.
   4. With a like and a _Not interested_, an item close to the disliked item ranks below an otherwise equal item.
   5. Cold start returns items from several sources in round-robin order, and items close to a _Not interested_ item come last.
   6. Centering is applied: a same-language unrelated item does not outrank a cross-language related item.
   7. Anonymous clients cannot execute `get_feed`; `p_limit` outside 1–100 is clamped.
   8. Paging with `p_exclude` returns no item twice; a like given between pages changes the ranking of the next page.
   9. An item whose centered vector has zero length gets similarity 0, and the function returns without errors or `NaN` scores.
   10. Likes on ineligible items (no embedding, no mean row, or another embedding model) do not trigger personalized mode: the caller gets cold start. Items of another embedding model are never returned.
4. **Task 4 — feed page**
   1. The first page renders cards with source, time, thumbnail, and explanation; **Refresh feed** reloads the list.
   2. Unit tests: explanation text and the `http`/`https` link guard.
5. **Task 5 — infinite scrolling**
   1. Scrolling to the end loads the next page without duplicates; **Load more** works with the keyboard; the end of the feed shows "You're all caught up"; `loadMoreFeed` rejects unauthenticated calls.
6. **Task 6 — buttons, undo, mutation ordering**
   1. Buttons set, replace, and clear feedback; _Not interested_ and _Seen_ collapse the card and show Undo.
   2. Unit tests for the mutation queue: rapid changes leave the last requested state on the server; Undo pressed while a save is pending restores the previous `{kind, via}` after the save completes; a failed save drops queued mutations and reverts to the confirmed state with an error; Undo of a button _Seen_ that followed a swipe _Like_ restores `{like, swipe}`.
7. **Task 7 — swipe gestures**
   1. Unit tests for gesture logic: direction lock, threshold, commit and cancel in both directions.
   2. On a touch device (or touch emulation), swiping right likes and swiping left marks _Not interested_ with `via = 'swipe'`; every swipe shows Undo; vertical scrolling is not captured; short swipes snap back.
8. **Task 8 — liked page**
   1. `/liked` lists only the caller's liked items, and _Unlike_ removes an item from the list.
9. **Task 9 — cloud means and video check**
   1. Means exist on the cloud project. From an empty profile, liking 4–5 AI/software items and refreshing re-ranks the feed with explanations; at least one Finnish item on a liked topic appears in the top 20; marking a sports item _Not interested_ and refreshing pushes other sports items down.
10. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; from task 3 on, `pnpm test:integration` passes with 0 skipped.

## Tasks

- [x] 1. Migration: `embedding_language_means` with RLS; `pnpm embeddings:means` script (criterion 1).
- [x] 2. Migration: `centered_similarity` helper and `get_feed` with eligibility, personalized and cold-start modes, and the defaults block (criterion 2).
- [x] 3. `get_feed` integration tests with controlled embeddings (criterion 3).
- [x] 4. Feed page: server data loading, cards, explanation text, link guard, Refresh feed (criterion 4).
- [x] 5. Infinite scrolling: `loadMoreFeed` server action, sentinel loading, Load more fallback, end-of-feed state (criterion 5).
- [x] 6. Action buttons, per-card mutation queue, optimistic updates, undo toast, with unit tests (criterion 6).
- [x] 7. Swipe gestures with pure gesture logic and unit tests, using the mutation queue (criterion 7).
- [x] 8. `/liked` page with Unlike (criterion 8).
- [x] 9. Run `pnpm embeddings:means` on the cloud project, do the manual video check (criterion 9), and update design.md §2 and §6 with the final defaults and the new table.
- [ ] 10. Selected-state visibility (user-requested follow-up): use a high-contrast active navigation button and a green selected Like button labeled "Liked", preserving `aria-current` and `aria-pressed`. Verify visually and pass the existing checks.

Task 10 implementation (31 Oct 2026): added a semantic success button variant with light/dark theme tokens and switched active navigation to the primary variant. Browser verification confirmed both selected states and Like toggling; restored the temporary test like. Lint, typecheck, and 212 unit tests passed. Local integration tests ran with 0 skipped: 30 passed, while two ingestion tests failed on `content_items_enrichment_state_check`. Task remains unchecked pending resolution of those database/test failures.

Task 9 verification (30 Oct 2026): recomputed hosted means for `text-embedding-3-small@512` (Finnish 239 items, English 522 items). Checked the actual UI in MCP Chrome using a local app instance explicitly configured for hosted Supabase and a disposable empty profile. Loaded pages, clicked Like on five English AI stories, waited for saves, and pressed Refresh feed. The ranking changed to personalized explanations, and the Finnish AI-investment story "Googlen osake syöksyy, Microsoft sinnittelee" ranked 7th. Clicked Not interested on the Mikael Jantunen basketball story, verified immediate collapse and Undo, then refreshed: other sports stories previously at ranks 99, 128, and 174 were all beyond the first 180 results. Authenticated RPC checks independently confirmed explanation ownership and disliked-item exclusion. Deleted the disposable user and verified that its feedback was removed; personal feedback was untouched. Design §2 and §6 document the verified defaults and means table. This was the manual scenario check for the prototype video, not a recorded video artifact.

Validation: `pnpm lint`, `pnpm typecheck`, and `pnpm test` passed (194 unit tests); `pnpm test:integration` passed with 29 tests and 0 skipped. The feed integration fixtures now mark non-fixture catalog items as neutral Seen feedback for disposable test users, so a populated local database does not crowd controlled ranking assertions out of the result limit. No local database reset was needed.

## Decisions

- Ranking uses nearest-liked on language-centered vectors (gate 1 re-run); average-vector on centered vectors remains the fallback.
- Language means are frozen per embedding model and recomputed only by running the script.
- Centering is computed at query time; no extra vector column is stored.
- Only items of the active embedding model are compared; zero-length centered vectors have similarity 0.
- Feedback mutations are serialized per card; failures revert to the last confirmed state.
- Swipe gestures are implemented without a gesture library.
- Infinite scrolling pages by excluding already shown IDs, not by offset; pages are 30 items.
- Candidate windows (articles 7 days, videos 30 days) and recency half-lives (24 h / 7 days) are the starting point, tuned in week 6.

## Open questions

- None.
