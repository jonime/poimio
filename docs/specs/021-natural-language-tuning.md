# 021 — Natural-language feed tuning

**Status:** Draft  
**Milestone:** Final (weeks 5–6)  
**Depends on:** 007 (current scorer), 006 (the freeze and the test-window run happen before task 2 is merged)  
**Estimate:** 14 h

## Goal

Let a signed-in user steer their feed in their own words, such as "more space news, less football". An LLM turns the request into a few structured preferences once per request; their embeddings act as extra positive or negative signals in the existing scorer. No LLM runs at ranking time, and each user has a daily LLM limit.

## Context

- Feature summary and risk: [plan.md §3](../plan.md) ("Natural-language feed tuning"), [plan.md §8](../plan.md#8-risks) ("LLM misreads a natural-language request")
- Scoring, cold start, and exploration: [design.md §2](../design.md#2-recommendation); LLM usage rules: [design.md §2.5](../design.md#25-llm-usage-limited)
- Data model and security rules: [design.md §5.1, §6](../design.md#6-data-model), [AGENTS.md](../../AGENTS.md)
- Scorer and feed: `ranking_private.rank_items`, `public.rank_items`, `public.get_feed` (migrations `20261120000100` and `20261120000200`)
- Existing OpenAI helpers: `lib/embeddings.ts` (embedding model and dimensions), `lib/enrich/coordinator.ts` (Responses API with plain `fetch`, `gpt-6-luna`)

## In scope

- A per-user `feed_preferences` table and a per-user `llm_usage` table, with RLS and two-user tests.
- A server action that turns a request into preferences with `gpt-6-luna`, embeds them, and saves them, within per-user limits.
- Preferences as extra signals in the private scorer; `get_feed` passes the caller's preferences and explains matches.
- A preferences page: request input, list of active preferences, flip direction, delete.
- Two small checks: LLM output on 12 example requests, and the ranking effect on the evaluation snapshot with existing labels.

## Out of scope

- Free-text editing of a saved preference's meaning (write a new request instead).
- Preference strengths or weights, expiry, or history.
- Using preferences in source discovery or the interest summary.
- Changes to the evaluation personas, the freeze, or the test-window run.

## Design notes

**Preferences**

- A preference has a short `label` (for display, ≤ 40 characters), a `direction` (`more` or `less`), and two search descriptions, one Finnish and one English (each one sentence, ≤ 200 characters). The descriptions are what gets embedded, so each preference matches items in both languages.
- At most 20 active preferences per user; a request yields at most 5.
- Users can flip the direction or delete a preference. To change its meaning they write a new request.

**Turning a request into preferences** (server action `tunePreferences(text)`)

1. Verify the user with `getClaims()`. Trim the text; reject empty text or more than 300 characters.
2. Reserve one LLM call with `reserve_llm_call('preferences')` (below). If the limit is reached, return a clear message and call nothing.
3. Call `gpt-6-luna` through the Responses API with plain `fetch`: a fixed instruction, the user's text as untrusted input, a strict JSON schema output (array of `{label, direction, description_fi, description_en}`), no tools, at most 400 output tokens, 20 s timeout.
4. Validate the output against the schema and length limits; drop invalid items. Reject the request if nothing valid remains or if saving would exceed 20 active preferences.
5. Embed all descriptions in one `text-embedding-3-small@512` request (≤ 10 inputs) and save the preferences in one insert with the service-role client, setting `user_id` from the verified claims.
6. Return the saved preferences; the page shows them immediately, and the feed uses them on the next load or **Refresh feed**.

The request text is the user's own and only affects their own preferences; the model output is data, never instructions. The request text itself is not stored.

**Per-user LLM limit**

- `reserve_llm_call(p_kind text) returns boolean`: `SECURITY INVOKER`, user from `auth.uid()`, executable by `authenticated`. It takes a transaction-level advisory lock on the user, counts the user's `llm_usage` rows of that kind in the last 24 hours, and inserts a row only if the count is below the limit (10 for `preferences`). It returns whether a row was inserted.
- Users can insert only their own usage rows (which can only use up their own quota) and cannot update or delete them, so the limit cannot be reset from the client.
- A failed LLM call still counts. The limit is checked before any OpenAI request.

**Data model** (added to design.md §6)

- `feed_preferences` (per-user): `id`, `user_id` (default `auth.uid()`), `label`, `direction`, `description_fi`, `description_en`, `embedding_fi`, `embedding_en` (`vector(512)`), `embedding_model`, `created_at`, `updated_at`. RLS owner-only `select`, `update (direction)` via column grant, and `delete`; no user `insert` (only the server action inserts, with service role, after verifying the user). A trigger rejects a 21st row per user.
- `llm_usage` (per-user): `id`, `user_id` (default `auth.uid()`), `kind`, `created_at`. RLS owner-only `select` and `insert` (with `user_id = auth.uid()`); no `update` or `delete`.

**Scoring with preferences**

- The private scorer and the public wrapper get two new parameters, `p_more_preference_ids uuid[] default '{}'` and `p_less_preference_ids uuid[] default '{}'`. Each preference contributes two signal vectors (Finnish and English description), centered with the mean of its description's language when `centered` is true.
- Positive signals are eligible likes plus `more` preference vectors; negative signals are eligible dislikes plus `less` preference vectors. The interest models use these sets unchanged (the nearest term takes the maximum over all positive vectors; the average term uses the mean of all positive vectors; the penalty takes the maximum over all negative vectors).
- Personalization starts when there is at least one positive signal, so a user with only `more` preferences gets a personalized feed. In cold start, `less` vectors join dislikes in the existing $\theta$ demotion.
- Exploration's liked sources come from eligible likes only; preferences have no source.
- The returned explanation is the closest positive signal. The scorer returns a new column `because_preference_id` (set when that signal is a preference; `because_item_id` is then null).
- `get_feed` reads the caller's preferences (RLS owner) and passes them. Its return columns stay the same: reason `preference` with `because_title` set to the label. The card shows "Matches your preference: _label_".
- Without preferences, every result is identical to today's, so the evaluation replay and the freeze are unaffected.
- The private scorer and the public wrapper are dropped and recreated by exact signature without `CASCADE`, and their grants, `SECURITY INVOKER`, and empty search path are restored exactly as in spec 007.

**Preferences page** (`/preferences`, signed-in only; linked from the app navigation)

- A textarea (300-character limit with a counter) and a **Tune feed** button, with pending and error states and the remaining daily requests.
- The list of active preferences: label, a `more`/`less` badge, a flip button, and a delete button; an empty state when there are none.
- shadcn/ui components per [AGENTS.md](../../AGENTS.md) (`Field`, `Textarea`, `Button`, `Badge`, `Empty`, `Alert`).

**Checks** (no bulk labeling)

1. **LLM output:** `evaluation/preference-requests.json` holds 12 example requests (6 Finnish, 6 English; mixed `more`/`less`, one off-topic or empty-meaning request). `pnpm eval:preferences --parse` runs them once and writes the outputs. The user reviews the 12 outputs and notes whether each is correct; the target is at least 10 of 12.
2. **Ranking effect:** on the local evaluation snapshot (validation window), with one hand-written preference per persona (fixed in the same file, both languages, not LLM output), `pnpm eval:preferences --rank` reports with existing labels:
   - `more` only, no likes: precision@10 against plain cold start, for each of the 4 personas; expected higher for at least 3 of 4;
   - `less`: for each composite persona with $k = 10$ likes and a `less` preference for one member (12 cases), the share of that member's exclusive items in the top 10, averaged over seeds; expected lower in at least 10 of 12.

   If either expectation fails, stop and discuss before task 4 merges; there is no tuning loop.

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — tables and limit**
   1. `supabase db reset` applies the migration cleanly.
   2. Two-user tests: user A cannot read, update, or delete B's preferences or read B's usage rows; users cannot insert preferences or update/delete usage rows; a user cannot insert a usage row for another user; only `direction` is updatable.
   3. `reserve_llm_call`: returns true 10 times and then false for the same user within 24 hours; other users are unaffected; two concurrent calls at count 9 insert one row in total.
   4. The 21st preference for one user is rejected.
   5. `pnpm test:integration` passes with 0 skipped.
2. **Task 2 — scorer and feed**
   1. Existing `rank_items` and `get_feed` integration tests pass; with no preferences, results equal those of the previous scorer for every method (parity test).
   2. Controlled-vector tests: a `more` preference alone personalizes (no cold start) and ranks a matching item first; a `less` preference lowers a matching item; preference vectors are centered by description language; `because_preference_id` is set when a preference is the closest positive signal and `because_item_id` is null; `newest_first` and `random` ignore preferences.
   3. `get_feed` passes only the caller's preferences (two-user test) and returns reason `preference` with the label.
   4. Grants match spec 007 exactly; `pnpm test:integration` passes with 0 skipped.
3. **Task 3 — server action**
   1. Unit tests with mocked `fetch`: unauthenticated calls are rejected; text over 300 characters or empty is rejected before any request; a reached limit makes no OpenAI request; the request uses the strict schema, no tools, and the token and time limits; invalid items are dropped; an all-invalid result saves nothing; exceeding 20 active preferences saves nothing; the embedding request has at most 10 inputs; `user_id` comes from the verified claims.
   2. Flip and delete go through the user's own client (RLS), not the service role.
4. **Task 4 — page, checks, and docs**
   1. The page works on phone and desktop widths: submit, pending, error, limit message, list, flip, delete, empty state; the feed card shows the preference explanation. Unit tests for the reason mapping.
   2. Both checks run; the outputs, the user's review notes, and the ranking table are recorded in `docs/ai-log.md` and design.md §2 and §2.5. Expectations hold, or the user has decided how to proceed.
   3. design.md §6 documents both tables; plan.md marks per-user LLM limits as decided.
5. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [ ] 1. Migration: `feed_preferences`, `llm_usage`, `reserve_llm_call`, RLS, cap trigger, two-user tests (criterion 1).
- [ ] 2. Migration: preferences in the private scorer and wrapper, `because_preference_id`, `get_feed` changes, tests (criterion 2).
- [ ] 3. Server actions: tune, flip, delete; LLM and embedding calls with limits (criterion 3).
- [ ] 4. Preferences page and feed explanation; `pnpm eval:preferences`; checks; design.md, plan.md, and AI log (criterion 4).

## Decisions

- Preferences are saved straight away and shown immediately, instead of a separate confirmation step. The user sees and can flip or delete every item before the next feed load, and the server never has to trust preference text sent back from the client.
- Each preference is embedded as a one-sentence description in both Finnish and English, not just the label: short labels embed far from full articles, and two languages keep cross-lingual matching symmetric.
- Preferences use the existing signal sets and parameters; no new weight is tuned. The ranking check decides whether that is good enough.
- Only the server action inserts preferences (service role, user from verified claims), so caps, validation, and embedding cost are enforced in one place.
- The limit is 10 requests per user per rolling 24 hours, counted before the call; at the current `gpt-6-luna` rates this is far below a cent per user per day.

## Open questions

- None.
