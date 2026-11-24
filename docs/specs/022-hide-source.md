# 022 — Hide a source (negative-feedback reasons)

**Status:** Done
**Milestone:** Final (week 6)  
**Depends on:** 003 (feed UI and feedback), 021 (preferences page)  
**Estimate:** 8 h

## Goal

Let a signed-in user say "not this source" separately from "not this topic". _Not interested_ keeps its current meaning (a topic signal for the item's content); a new **Hide source** action removes every item of that source from the user's feed until they show it again.

## Context

- Actions, gestures, and what was left out: [design.md §7.1, §7.5](../design.md#7-user-interaction)
- Feed function and signals: `public.get_feed` (migration `20261123000200_rank_with_feed_preferences.sql`), [design.md §2](../design.md#2-recommendation)
- Feedback actions and the undo toast: `app/feedback/actions.ts`, `app/feed/feed-list.tsx`
- Preferences page: `app/(app)/preferences` ([spec 021](021-natural-language-tuning.md))
- Security rules: [AGENTS.md](../../AGENTS.md), [design.md §5.1](../design.md#51-data-access-and-security)

## In scope

- A per-user `hidden_sources` table with RLS and two-user tests.
- A **Hide source** action in each feed card's menu, with an undo toast.
- `get_feed` excludes hidden sources' items from candidates and returns each item's `source_id`.
- A "Hidden sources" section on the preferences page with **Show again**.

## Out of scope

- A reason picker after _Not interested_, and any change to what _Not interested_ or swipe left records.
- Changes to the scorer, signals, the evaluation, the guest feed, or the Liked page.
- Hiding sources for all users (sources stay shared and admin-managed).

## Design notes

**Meaning**

- _Not interested_ (button or swipe left) is unchanged: the item becomes a dislike signal, so similar content ranks lower.
- **Hide source** is a separate action and records no feedback on the item. Hidden sources' items are not candidates in the personalized feed, cold start, or exploration slots.
- Likes and dislikes on items from a hidden source still count as signals, because they describe the user's topics, not the source.

**Data model** (added to design.md §6)

- `hidden_sources` (per-user): `user_id uuid not null default auth.uid() references auth.users(id) on delete cascade`, `source_id uuid not null references sources(id) on delete cascade`, `created_at timestamptz not null default now()`; primary key `(user_id, source_id)`. RLS owner-only `select`, `insert` (with `user_id = auth.uid()`), and `delete`; no `update`. `anon` has no access.

**Database functions** (`SECURITY INVOKER`, empty search path, user from `auth.uid()`; execute revoked from `PUBLIC` and `anon`, granted to `authenticated`)

- `hide_source_of_item(p_item_id uuid) returns table (source_id uuid, source_name text)`: looks up the item's source among rows the caller can read, inserts the row (no error if already hidden), and returns the source for the toast. Any readable item is accepted, including old, rated, or inactive-source items. A null, unknown, or unreadable item raises a generic error and inserts nothing; without a user it raises an authentication error.
- Showing a source again is a plain owner-only `delete` through the user's client; no function is needed.

**Feed**

- `get_feed` adds one correlated condition to the `candidate_ids` selection only, before ranking: the item's source is not in the caller's `hidden_sources`. Signal and preference queries and both ranking functions are unchanged, so pages still fill to the limit and exploration and cold start work on the remaining candidates.
- `get_feed` gains `source_id uuid` as its last return column, so the client matches cards by source ID (source names are not unique). Because the return type changes, `get_feed` is dropped and recreated by exact signature without `CASCADE`, with its grants and `SECURITY INVOKER` restored exactly, as in spec 021. Its parameters are unchanged.
- With no hidden sources, order, scores, reasons, and explanations are identical to today's.

**Server actions**

- `hideSource(itemId)` and `showSource(sourceId)` verify the user with `getClaims()`, validate the UUID at runtime, and write through the user's own client (pattern in `app/feedback/actions.ts`). They return a narrow result: the source ID and name, or an error code.
- Neither action revalidates or refreshes the home feed, so the mounted list and its positions survive hide and undo. They revalidate `/preferences` only; the home feed reflects changes on its next load.

**UI**

- `FeedItem` carries `source_id`. Each feed card gets a menu (`DropdownMenu`, Base UI `render` prop for the trigger, accessible label "More actions") with **Hide _source name_**. Task 2 adds a minimal action item wrapper (Base UI `Menu.Item`) to `components/ui/dropdown-menu.tsx`, which today exports only a link item.
- The menu trigger sits above the card's stretched article link. Opening or using the menu neither opens the article nor starts a swipe; card swiping is suspended while the menu is open. Buttons and gestures for Like, Not interested, and Seen are unchanged.
- **Hiding is a visibility mask, not removal.** Loaded items stay in the list in their original order and stay mounted, with their feedback state. Cards whose `source_id` is hidden are not shown. Masked items still count as loaded for pagination exclusions and deduplication, and items from later or late-arriving pages are masked the same way.
- Hide flow: the menu item is disabled while a hide or undo for that source is pending. On success, the source's cards are masked and a toast shows "Hidden _source name_" with **Undo** (the existing 5-second toast, started after success). Keyboard focus moves to the next visible card or the feed heading. On error, nothing is masked and an error toast appears.
- Undo awaits `showSource` and removes the mask only on success; on failure the source stays hidden and an error toast says it can be shown again from the preferences page.
- The preferences page gets a **Hidden sources** section: source name, hidden date, and a **Show again** button per row with its own pending and error state; an empty state when nothing is hidden. Shown sources' items return on the next feed load.

**Checks** (no labeling)

- None beyond tests: the feature is deterministic and does not affect evaluation replay, which ranks explicit candidate IDs through `rank_items`.

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — table, function, and feed**
   1. `supabase db reset` applies the migration cleanly.
   2. Two-user tests: user A cannot read, insert for, or delete B's hidden sources (including a delete through A's client with B's `source_id`); `anon` has no access to the table or the function; rows cannot be updated; deleting a user removes their rows.
   3. `hide_source_of_item`: is `SECURITY INVOKER` with an empty search path and the specified grants; hides the item's source for the caller only, is idempotent, returns the source ID and name, accepts an old or rated item, and raises an error and inserts nothing for a null or unknown item or without a user.
   4. `get_feed`, with control runs where the hidden source's items do appear: they are absent from the personalized feed, cold start, a preference-only feed, and exploration slots (exploration falls back to another unliked source); a page still has `p_limit` items when enough candidates remain; hiding between two pages (with `p_exclude`) removes the source from the second page; another user's feed is unaffected; deleting the row brings the items back; likes and dislikes from a hidden source still affect scores.
   5. With no hidden sources, order, scores, reasons, and explanations equal those before the migration (fixed time for time-dependent cases); `source_id` is returned for every row, including two sources with the same name.
   6. Grants and `SECURITY INVOKER` of `get_feed` are restored exactly; `pnpm test:integration` passes with 0 skipped.
2. **Task 2 — actions and UI**
   1. Unit tests: both actions reject unauthenticated calls and invalid IDs, write through the user's client, and do not revalidate the home feed.
   2. Feed list tests (existing React test setup): hiding masks only cards with that `source_id` (including a same-name source that stays visible) in interleaved order; masked cards keep their feedback state and position after Undo; masked IDs stay in pagination exclusions; a page requested before hiding and arriving after it is masked; hide failure masks nothing; undo failure keeps the mask; repeated activation while pending sends one request.
   3. The card menu works with keyboard (open, navigate, Escape) and touch on phone and desktop widths; using the menu or moving a finger on it neither opens the article nor records feedback; focus moves to a visible control after hiding.
   4. The preferences page lists hidden sources with **Show again**, per-row pending and error states, and an empty state; changes persist after reload.
   5. design.md §2 (candidate filtering), §5.1 (security), §6 (table), and §7 (action; §7.5 no longer lists hiding a source as a later addition) are updated; plan.md states the mapping (_Not interested_ → topic, **Hide source** → source, _Seen_ → neutral). An AI log entry follows AGENTS.md (the agent asks the user to confirm the model first).
3. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [x] 1. Migration: `hidden_sources`, RLS, `hide_source_of_item`, `get_feed` filter and `source_id` column, two-user and feed tests (criterion 1). About 4 h.
- [x] 2. Server actions, menu item wrapper, card menu with visibility mask and undo, Hidden sources section, docs (criterion 2). About 4 h.

## Decisions

- "Not this source" becomes its own action instead of a reason picker after _Not interested_. A picker would add a step to every dislike, and the only reason that changes behaviour is the source; "not this topic" is what _Not interested_ already means.
- Hiding a source records no feedback on the item, so it does not add a topic penalty the user did not ask for.
- Hiding filters candidates in `get_feed` only; the scorer and the evaluation are untouched, so the frozen test-window result stays valid.
- `source_id` comes from `get_feed` itself rather than a second query per page; the return-type change follows the same drop-and-recreate pattern as spec 021.
- Hiding masks cards instead of removing them, so feedback state, positions, and pagination exclusions survive hide and undo.
- No cap on hidden sources: the number is bounded by the shared source list.

## Open questions

- None.
