# 013 — Search liked items

**Status:** Approved  
**Milestone:** Final (small enhancement)  
**Depends on:** 003 (liked page)  
**Estimate:** 1–2 h

## Goal

Help users find an article or video they previously liked by searching the Liked page. This is independent of the data collection and ranking evaluation in spec 006.

## Context

- [Spec 003](003-feed-ui.md), task 8: `/liked` shows the caller's likes, newest like first, with an Unlike action; task 11 keeps the list fresh after feedback changes.
- [design.md §7](../design.md#7-user-interaction): feedback and user interaction; [§5.1](../design.md#51-data-access-and-security): authenticated reads and RLS.
- [plan.md §7.1](../plan.md#71-spec-roadmap): feature specs and project roadmap. Number 013 avoids the planned 011–012 features.
- `app/(app)/liked/page.tsx` already loads titles, summaries, and source names. `LikedList` renders the server-provided items directly, so search needs no additional data fetching.

## In scope

- Instant client-side search over the loaded liked items' titles, full summaries, and source names.
- A labeled search field, result count, clear button, and no-match state.
- Regression coverage for search together with refreshed server items and Unlike.

## Out of scope

- Server-side search, pagination, or fetching likes beyond the existing page response. Search covers the loaded list, not a guarantee of the user's entire history beyond database response limits.
- Feed search, language/source filters, sorting controls, fuzzy matching, stemming, or highlighted matches.
- Query persistence in URLs or storage, new dependencies, database/schema/API changes, and ranking or evaluation changes.

## Design notes

**Matching and state**

- Keep the query in local state in `app/(app)/liked/liked-list.tsx`; derive filtered items from the latest `items` prop on each render. Do not copy items into state.
- Trim leading/trailing whitespace and lowercase the query and searchable fields using `toLowerCase()`. Match the whole query as a literal substring in any one field; treat a null summary as empty text. Internal spaces and punctuation stay literal; Finnish letters retain their accents (`Ä` matches `ä`, but `a` does not match `ä`).
- An empty or whitespace-only query shows all loaded items. Preserve the server's newest-liked-first order; no debounce or network request is needed.
- Keep the query during updates to a mounted list, including after Unlike, and recompute matches/count from the new props. A new mount starts with an empty query.

**Controls and states**

- When there are loaded items, show a visible “Search liked items” label and `type="search"` input above the cards. Placeholder: “Search titles, summaries, or sources”. Do not autofocus.
- Compose existing shadcn `FieldGroup`, `Field`, `FieldLabel`, and `Input`. Place an existing `Button` labeled “Clear search” below the field, without positioning it inside the input; show it whenever the raw query is nonempty. Clearing empties the query and returns focus to the input.
- Show “Showing X of Y loaded liked items” below the controls, using a polite status region. X is the match count and Y is the current `items.length`.
- For zero matches with a nonempty loaded list, retain the controls/count and show the existing `Empty` composition with “No matching liked items.” and “Try another search or clear it.”
- When `items` itself is empty, show the existing “No liked items yet.” state and Browse your feed link, without search controls. This also applies after removing the last like.
- Unlike continues to use the existing action, pending state, error alert, and server refresh. A failed Unlike preserves the item and the active query; a successful refresh may leave zero matches or an empty list.
- Follow the project shadcn skill, semantic tokens, and flex/gap layout. Controls must fit a 375px viewport and remain usable by keyboard.

## Acceptance criteria

1. Typing filters immediately by title, full summary (including text beyond the visible clamp), or source name. Matching is case-insensitive, trims query edges, handles null summaries, and treats punctuation literally. Blank queries restore all loaded items in their original order.
2. The input has an associated visible label. Clear search works by keyboard, restores the full list, and returns focus to the input. The count updates correctly and is exposed as a polite status message.
3. Zero matches show the search-specific empty state while keeping controls available. Zero loaded likes show only the existing empty-list experience. The layout has no horizontal overflow at 375px.
4. With an active query, rerendering a mounted list with fresh server items preserves the query and updates results/count, including transitions to zero matches and zero likes. Unlike still targets the correct item; failed Unlike keeps the matching item and shows the existing error.
5. Existing liked-page freshness tests and the new interaction tests pass. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass. No new integration tests are required because data access and security boundaries do not change.

## Tasks

- [ ] 1. Implement the search controls, matching, count, and empty states in `LikedList`; extend its existing component tests for criteria 1–4 and run the checks in criterion 5.
- [ ] 2. Verify keyboard use and the 375px layout; document the loaded-list search behavior in design.md §7 and record the implementation in docs/ai-log.md after confirming the exact model with the user. Run lint, typecheck, and test before marking the task complete.

## Decisions

- Search is a small, deterministic UI enhancement that can be implemented while spec 006 waits for data.
- Search only the items already supplied to the page, with simple substring matching and no added dependencies.
- Existing authenticated reads, feedback behavior, and newest-liked-first ordering remain the source of truth.

## Open questions

None.
