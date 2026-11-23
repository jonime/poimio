# 021 — Natural-language feed tuning

**Status:** Done  
**Milestone:** Final (weeks 5–6)  
**Depends on:** 007 (current scorer), 006 (freeze and test-window run, done in task 0)  
**Estimate:** 17 h

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

- A preference has a short `label` (for display, ≤ 40 characters), a `direction` (`more` or `less`), and two search descriptions, one Finnish and one English (each one sentence, ≤ 200 characters). The descriptions are what gets embedded, so each preference can match items in both languages.
- Descriptions name the subject positively ("Football matches, leagues, and players" for "less football"); only `direction` carries the polarity.
- At most 20 active preferences per user, enforced in the database and safe under concurrent inserts: a batch that would exceed 20 saves nothing. A request yields at most 5.
- Users can flip the direction or delete a preference. To change its meaning they write a new request.

**Turning a request into preferences** (server action `tunePreferences(text)`)

1. Verify the user with `getClaims()`. Validate the input type at runtime; trim the text; reject empty text or more than 300 characters.
2. Reserve one LLM call with `reserve_llm_call('preferences')` (below). An error, null, or false result means no call: return the limit message and the remaining count.
3. Call `gpt-6-luna` through the Responses API with plain `fetch`, following the request conventions in `lib/evaluation-description-judges.ts`: `reasoning: {effort: "none"}`, `store: false`, no tools, at most 800 output tokens, 20 s timeout, response body at most 64 KB. The instruction is fixed; the user's text is untrusted input; the output uses `text.format` with a strict JSON schema whose root is an object `{preferences: [...]}` (at most 5 items; each with required `label`, `direction` enum `more`/`less`, `description_fi`, `description_en`; `additionalProperties: false`). The instruction asks for an empty list when the text expresses no topic preference.
4. Accept only a `completed` response; reject refusals, incomplete or truncated output, and malformed payloads without recovering fragments. Validate lengths locally (no new dependency); drop invalid items. Reject the request if nothing valid remains or if saving would exceed 20 active preferences.
5. Embed all descriptions in one `text-embedding-3-small@512` request (≤ 10 inputs, 10 s timeout, body at most 1 MB). Check count, index order, dimensions, and finite values, as `lib/embeddings.ts` does, and map each vector to its description.
6. Save the preferences in one insert with the service-role client, setting `user_id` from the verified claims. On any failure in steps 3–6 nothing is saved.
7. Return a narrow result: the saved preferences or an error code, plus the remaining request count. The page shows the preferences immediately; the feed uses them on the next load or **Refresh feed**.

The request text is the user's own and only affects their own preferences; the model output is data, never instructions. Neither the request text nor the model output is stored outside the saved preferences or written to logs (status codes only). OpenAI helpers live in server-only modules, not in exported `"use server"` entry points.

**Flip and delete** (server actions)

- Each action verifies the user with `getClaims()` itself, validates the preference ID (UUID) and direction at runtime, and writes through the user's own client, so RLS limits it to the caller's rows. A missing or foreign ID returns "not found".

**Per-user LLM limit**

- `reserve_llm_call(p_kind text) returns boolean`: volatile, `SECURITY INVOKER`, empty search path, user from `auth.uid()`; execute revoked from `PUBLIC` and `anon` and granted to `authenticated`. It rejects unknown kinds (only `preferences` exists), takes a transaction-level advisory lock on the user, counts the user's `llm_usage` rows of that kind with `created_at` in the last 24 hours, and inserts a row only if the count is below the limit (10 for `preferences`). It returns whether a row was inserted.
- `created_at` is set by the database; users can insert only `kind` (column grant), only for themselves, and cannot update or delete usage rows, so they cannot reset or backdate the limit. A direct insert only uses up the user's own quota.
- A failed LLM call still counts. The limit is checked before any OpenAI request. The remaining count is the limit minus the user's rows in the window, read with the user's client.

**Data model** (added to design.md §6)

- `feed_preferences` (per-user): `id`, `user_id` (default `auth.uid()`), `label`, `direction`, `description_fi`, `description_en`, `embedding_fi`, `embedding_en` (`vector(512)`), `embedding_model`, `created_at`, `updated_at`. RLS owner-only `select`, `update (direction)` via column grant, and `delete`; no user `insert` (only the server action inserts, with service role, after verifying the user). The 20-row cap is enforced in the database with a per-user lock before counting.
- `llm_usage` (per-user): `id`, `user_id` (default `auth.uid()`), `kind`, `created_at` (default `now()`). RLS owner-only `select` and `insert` (with `user_id = auth.uid()`, column grant on `kind` only); no `update` or `delete`.

**Scoring with preferences**

- The private scorer and the public wrapper get two new parameters after the existing ones, `p_more_preference_ids uuid[] default '{}'` and `p_less_preference_ids uuid[] default '{}'`, and a new last return column `because_preference_id uuid`. Duplicate IDs are ignored; an ID in both lists raises an error. The scorer reads only the given IDs; in `get_feed` RLS limits them to the caller's rows, and the service-role wrapper (evaluation only) reads any given ID.
- **Eligibility:** a preference vector is eligible if its `embedding_model` is the active model and a mean exists for its language (Finnish or English). Centering and zero-vector handling are as for items. A preference with no eligible vector is ignored entirely: it does not start personalization and is never an explanation.
- **One signal per preference:** its similarity to a candidate is $s(c, q) = \max(\text{sim}(c, q_{fi}), \text{sim}(c, q_{en}))$ over its eligible vectors. In the average term a preference contributes one vector, the mean of its eligible centered vectors. In `top_m_mean` it counts once with $s(c, q)$. So a preference weighs the same as one like.
- Positive signals are eligible likes plus `more` preferences; negative signals are eligible dislikes plus `less` preferences. The interest models, $\lambda$, and all other parameters are unchanged. `less` is a soft penalty, not a filter: a strongly matching item can still appear.
- Personalization starts when there is at least one positive signal, so a user with only `more` preferences gets a personalized feed. MMR and exploration still require eligible likes (unchanged), so a preference-only feed has no exploration slots. In cold start (no positive signals), source round-robin is unchanged and `less` preferences join dislikes in the existing $\theta$ demotion ($s(c, q) \ge \theta$).
- `newest_first` and `random` ignore preferences.
- **Explanation:** the closest positive signal; ties go to likes before preferences, then the smaller ID. `because_preference_id` is set when it is a preference (`because_item_id` is then null).
- `get_feed` reads the caller's preferences and passes them by direction. Its return columns stay the same. Reason precedence: `exploring`, then `preference` (with `because_title` set to the label), then `similar`, then `recent`. The card shows "Matches your preference: _label_" as plain text.
- Without preferences, every result is identical to today's, so the evaluation replay and the freeze are unaffected.
- Migration safety as in spec 007: the private scorer and the public wrapper are dropped and recreated by exact signature in one transaction without `CASCADE`; both `with ordinality` alias lists (wrapper and `get_feed`) are updated; grants, `SECURITY INVOKER`, and empty search paths are restored exactly.

**Preferences page** (`/preferences`, linked from the app navigation)

- The page verifies the user with `getClaims()` itself and redirects to login without a user; the layout is not the authorization gate.
- A textarea (300-character limit with a counter) and a **Tune feed** button, with pending and error states. The remaining daily requests come from the server and update after every attempt, successful or not. At 20 preferences the form explains the cap.
- The list of active preferences: label, a `more`/`less` badge, a flip button, and a delete button, each with its own pending and error state; an empty state when there are none. Changes persist after reload.
- shadcn/ui components per [AGENTS.md](../../AGENTS.md) (`Field`, `Textarea`, `Button`, `Badge`, `Empty`, `Alert`).

**Checks** (no bulk labeling)

1. **Ranking effect** (task 2, before merging the scorer change; no LLM). `evaluation/preferences.json` holds one hand-written preference per persona (label and both descriptions), written from the persona's scope in `evaluation/personas.json` so the existing labels stay valid. Their embeddings are computed once and cached in `evaluation/preference-embeddings.json`.
   - `pnpm eval:preferences --rank` refuses non-local Supabase URLs (as `eval:import` does). It creates one disposable local auth user, inserts the cached preferences for it with the service role, ranks through the service-role wrapper, and deletes the user afterwards.
   - Treatment: the production configuration (`blend`, $\alpha = 0.5$, centered, $\lambda = 0.5$, $\beta = 0$, `diversity` 0) with `exploration: false`. Validation window, headline candidate pools, seeds 0–9, existing label set; result provenance records the hashes of both files.
   - **`more` alone:** for each of the 4 personas, precision@10 with only its `more` preference against cold start with no signals (both deterministic). Expected: higher for at least 3 of 4.
   - **`less`:** for each composite persona A+B and each member (12 ordered cases), the existing composite sampling at $k = 10$, with and without a `less` preference for B. Per seed: the share of B-exclusive items in the top 10 (relevant to B and not to A), the share of A-exclusive items, and composite precision@10; mean over seeds, paired by seed. Expected: the B-exclusive share is lower in at least 10 of 12 cases. Missing cells (spec 020 rules) and cases with a zero baseline share count as not met.
   - The A-exclusive share and composite precision are reported and reviewed, not gated.
2. **LLM output** (task 3, before the page exposes the action). `evaluation/preference-requests.json` holds 12 requests, committed before the first run: 6 Finnish and 6 English, including two negations ("I don't want …"), one injection attempt, one ambiguous request, one request with five topics, and one off-topic request. `pnpm eval:preferences --parse` runs them once and writes the outputs. The user marks each output correct if every intended topic is present, nothing is invented, each direction is right, and both descriptions name the same subject positively; an empty result for the off-topic request is correct. Target: at least 10 of 12.

If either target is missed, stop and discuss; there is no tuning loop.

## Acceptance criteria

Each criterion belongs to one task.

0. **Task 0 — freeze, test run, and parity baseline** (done by the implementing agent before any migration of this spec)
   1. On an up-to-date, clean `main` with the final snapshot imported into local Supabase (`pnpm eval:import` if needed), the agent writes a validation replay result for the production treatment (spec 007 tuning summary) with no preferences, and records its path in this spec as the parity baseline for criterion 2.1.
   2. At the same clean `HEAD`, the agent runs `pnpm eval:freeze` with that treatment and then the one-time `pnpm eval:replay --window test` under the spec 006 guard, without `--params` or `--new-experiment`. `evaluation/frozen-params.json` is gitignored, so the tree stays clean between the two commands.
   3. The test result (`evaluation/results/test-<experiment ID>.json` and `.csv`) and the baseline file are committed. design.md §4 records the test-window numbers next to the validation numbers; spec 006's status no longer says the test run is deferred. The AI log entry follows AGENTS.md (the agent asks the user to confirm the model first).
   4. If any guard refuses to run, the agent stops and reports the error instead of working around it.

1. **Task 1 — tables and limit**
   1. `supabase db reset` applies the migration cleanly.
   2. Two-user tests: user A cannot read, update, or delete B's preferences or read B's usage rows; users cannot insert preferences or update/delete usage rows; a user cannot insert a usage row for another user or set its `created_at`; only `direction` is updatable; `anon` has no access to either table or the function.
   3. `reserve_llm_call`: returns true 10 times and then false for the same user; other users are unaffected; a row older than 24 hours (inserted with the service role) does not count; an unknown kind raises an error; two concurrent calls at count 9 insert one row in total.
   4. The cap: a single insert reaching 21 rows saves nothing; two concurrent batches at 19 rows leave at most 20.
   5. `pnpm test:integration` passes with 0 skipped.
2. **Task 2 — scorer and feed**
   1. Existing `rank_items` and `get_feed` integration tests pass, updated only for the new return column. Parity: `pnpm eval:replay` on validation with the production treatment and no preferences reproduces the ranked IDs of the task 0 parity baseline.
   2. Controlled-vector tests: a `more` preference alone personalizes and moves a matching item to first place; a `less` preference moves a matching item down in rank; centering uses each description's language; hand-computed scores for a mix of likes and a preference in `average_vector`, `blend`, and `top_m_mean` (one signal per preference); an ineligible preference (wrong model, missing mean) does not personalize or explain; duplicate IDs are ignored and an ID in both lists raises an error; explanation ties go to likes; `newest_first` and `random` ignore preferences.
   3. Preference-only feeds have no exploration slots; with only `less` preferences, cold start keeps source round-robin and demotes matches at $s \ge \theta$.
   4. `get_feed` passes only the caller's preferences (two-user test), applies the reason precedence, and returns the label for `preference`.
   5. The ranking-effect check (check 1) has run and its targets are met, or the user has decided how to proceed.
   6. Grants match spec 007 exactly; `pnpm test:integration` passes with 0 skipped.
3. **Task 3 — server action**
   1. Unit tests with mocked `fetch`: unauthenticated calls are rejected; text over 300 characters, empty, or not a string is rejected before any request; a reservation error, null, or false makes no OpenAI request; the request has the object-root strict schema, `store: false`, no tools, and the token, time, and size limits; refusal, incomplete, and malformed responses save nothing; invalid items are dropped; an all-invalid result saves nothing; exceeding 20 active preferences saves nothing; an embedding failure or a count or dimension mismatch saves nothing; the embedding request has at most 10 inputs; `user_id` comes from the verified claims; no log line contains the request text or model output.
   2. Flip and delete verify the user themselves and write through the user's own client: unauthenticated calls, invalid IDs or directions, and another user's preference ID change nothing.
   3. The LLM-output check (check 2) has run and its target is met, or the user has decided how to proceed.
4. **Task 4 — page and docs**
   1. The page verifies the user itself and works on phone and desktop widths: submit, pending, error, limit message with remaining count updated after each attempt, cap message, list, flip and delete with per-row pending and errors, empty state, persistence after reload; the feed card shows the preference explanation. Unit tests for the reason mapping.
   2. The check outputs, the user's review notes, and the ranking table are recorded in `docs/ai-log.md` and design.md §2 and §2.5, including that `less` is a soft penalty and that description-to-article similarity was a hypothesis tested by check 1.
   3. design.md §6 documents both tables; plan.md marks per-user LLM limits as decided.
5. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [x] 0. Parity baseline, freeze, and the one-time test-window run under spec 006 (criterion 0). Parity baseline: `evaluation/results/parity-021-production.json` (and `.csv`), commit `c65b6c8d715956f1275104a487c6caa6d196f59a`, production treatment, no preferences. Test result: `evaluation/results/test-5c4b9226cf16d14720a63969c11b696fd32bdefa839d41e141f07e2acd40bb0f.json` (and `.csv`).
- [x] 1. Migration: `feed_preferences`, `llm_usage`, `reserve_llm_call`, RLS, cap trigger, two-user tests (criterion 1).
- [x] 2. Migration: preferences in the private scorer and wrapper, `because_preference_id`, `get_feed` changes, tests; `pnpm eval:preferences --rank` and check 1 before merging (criterion 2). Check 1: `evaluation/results/preferences-021-check1.json`. More improved 4/4; less lowered the B-exclusive share in 12/12. Parity replay: `evaluation/results/parity-021-after-scorer.json`.
- [x] 3. Server actions: tune, flip, delete; LLM and embedding calls with limits; `pnpm eval:preferences --parse` and check 2 (criterion 3). Check 2: `evaluation/results/preferences-021-check2.json`. The user marked 12 of 12 outputs correct.
- [x] 4. Preferences page and feed explanation; design.md, plan.md, and AI log (criterion 4). Check 1: `evaluation/results/preferences-021-check1.json` (more 4/4, less 12/12). Check 2: `evaluation/results/preferences-021-check2.json` (user marked 12 of 12 correct). Ranking table and review notes: design.md §2.6 and §2.5; AI log 2026-11-23.

## Decisions

- Preferences are saved straight away and shown immediately, instead of a separate confirmation step. The user sees and can flip or delete every item before the next feed load, and the server never has to trust preference text sent back from the client.
- Each preference is embedded as a one-sentence description in both Finnish and English, not just the label. The hypothesis is that a sentence lands closer to article embeddings than a short label, and that two languages help cross-lingual matching; check 1 tests the effect.
- A preference counts as one signal (the better of its two language vectors), so it weighs the same as one like.
- Preferences use the existing signal sets and parameters; no new weight is tuned. The ranking check decides whether that is good enough.
- Preference-only users get personalization but no exploration slots: exploration relies on liked sources, and without likes every source would count as unliked.
- Only the server action inserts preferences (service role, user from verified claims), so caps, validation, and embedding cost are enforced in one place.
- The limit is 10 requests per user per rolling 24 hours, counted before the call; at the current `gpt-6-luna` rates this is far below a cent per user per day.

## Open questions

- None.
