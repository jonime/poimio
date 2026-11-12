# 020 — Ranking tuning with multi-interest personas

**Status:** Draft  
**Milestone:** Final (weeks 3–6, before the parameter freeze and gate 2)  
**Depends on:** 006 (evaluation harness, final snapshot, validation run)  
**Estimate:** 12 h

## Goal

Choose the production interest model and its parameters on the **validation window only**, with personas that also cover several unrelated interests, so the choice is not biased toward single-topic users. The chosen configuration becomes the default in the feed and the candidate for the later freeze and one-time test run.

## Context

- Evaluation harness, protocol, and safeguards: [spec 006](006-evaluation.md), [design.md §4](../design.md#4-evaluation)
- Ranking formulas and the scorer: `ranking_private.rank_items` behind the service-role-only `public.rank_items` (`supabase/migrations/20261110000000_restrict_rank_items_rpc.sql`); production `get_feed` uses `nearest_liked` with default parameters
- Gate 1 (2 hand-judged personas, ~300 items) chose nearest-liked on centered vectors ([ai-log.md](../ai-log.md))
- Plan: tuning and freeze in week 6, gate 2 ([plan.md §9](../plan.md#9-decision-gates-and-cut-order))

## Findings that motivate this spec (verified)

First validation run `evaluation/results/validation-2026-11-12T16-29-08.088Z.json` (commit `7c0549f`, label set `qwen/qwen3.8-27b:relevance-v1:final`, near-duplicate threshold 0.74, default parameters, 10 seeds). Headline precision@10 at $k = 10$:

| Persona              | `nearest_liked` | raw variant | `average_vector` | `newest_first` | `random` |
| -------------------- | --------------: | ----------: | ---------------: | -------------: | -------: |
| AI and software      |            0.93 |        0.95 |             0.93 |           0.10 |     0.44 |
| Cars and engineering |            0.47 |        0.41 |             0.83 |           0.10 |     0.05 |
| Science and space    |            0.87 |        0.82 |             0.93 |           0.10 |     0.05 |
| Finnish sports       |            0.68 |        0.68 |             0.89 |           0.00 |     0.06 |

- `average_vector` ties or beats the production method for every persona; the gap is large for cars and Finnish sports.
- Language centering shows no consistent gain here (raw vs centered differ by ±0.05).
- Cross-lingual en→fi precision is low for every method (0.15–0.36 at $k = 10$); `average_vector` is highest.
- **Limitation:** every persona has one interest. Nearest-liked was chosen for users with several unrelated interests, where an average lands between topics. That case is untested, so these numbers alone cannot decide the method.

## In scope

- Composite personas built from existing labels, with no new LLM labeling.
- Two additional interest models in the scorer: top-$m$ mean and a nearest/average blend.
- A two-stage parameter search on the validation window with a selection rule fixed before the search.
- Applying the chosen configuration as the production default, with tests.

## Out of scope

- The freeze file and the test-window run (after exploration and diversity are settled, week 6–7).
- Exploration slots and diversity re-ranking (spec 007).
- New embedding models or relabeling.
- Changing cold-start behaviour.

## Design notes

**Composite personas**

- All 6 pairs of the 4 existing personas (e.g. "AI and software + Finnish sports"). An item is relevant if it is relevant to either member, using the same frozen label set.
- Feedback per persona and seed: likes alternate between the members' relevant feedback-window items ($\lceil k/2 \rceil$ from the first member, $\lfloor k/2 \rfloor$ from the second, same prefix property as spec 006); dislikes are $\lfloor k/2 \rfloor$ items relevant to neither member.
- Extra metric **balanced coverage**: share of seeds where the top 10 contains at least 2 items relevant to each member. It shows whether a method serves both interests or drifts to one (or between them).
- Composite personas are evaluated for $k \ge 2$; missing-cell rules from spec 006 apply per member.

**New interest models** (in the private scorer; same dislike penalty, recency, cold start, tie-breaking, and eligibility as the existing methods)

- `top_m_mean`: interest = mean of the $m$ highest similarities between the candidate and the likes ($m = \min(m, |P|)$). $m = 1$ equals `nearest_liked`.
- `blend`: interest $= \alpha \cdot \max_{p} s(c,p) + (1-\alpha) \cdot s(c, \bar{p})$. $\alpha = 1$ equals `nearest_liked`, $\alpha = 0$ equals `average_vector`.
- New `p_params` keys `top_m` and `blend_alpha`, validated (integer 1–10; number 0–1).
- `because_item_id` stays the most similar like for every method, so explanations keep working.

**Search** (validation window only)

- Stage 1, interest model at default $\lambda$ and $\beta$: `nearest_liked`, `average_vector`, `top_m_mean` with $m \in \{2, 3, 5\}$, `blend` with $\alpha \in \{0.25, 0.5, 0.75\}$, each centered and raw (16 configurations).
- Stage 2, for the two best stage-1 configurations: $\lambda \in \{0, 0.25, 0.5, 1\}$ × recency weight $\beta \in \{0, 0.05, 0.1, 0.2\}$.
- Same seeds, $k$ values, near-duplicate threshold, and label set as the first validation run. Each configuration is one validation result file with its parameters in the provenance.
- `pnpm eval:tune` drives the grid by calling the existing replay for each configuration and writes a summary table (`evaluation/results/tuning-<timestamp>.csv` and `.json`).

**Selection rule** (fixed before the search runs)

- **Objective:** mean headline precision@10 over $k \in \{3, 5, 10, 20\}$ and all 10 personas (4 single, 6 composite), each persona weighted equally.
- **Constraints:**
  - balanced coverage on composite personas not more than 0.05 below the best configuration;
  - en→fi and fi→en precision@10 not more than 0.05 below the current production configuration.
- **Simplicity:** among configurations within 0.01 of the best objective that meet the constraints, prefer the simplest (fewer parameters; `average_vector` or `nearest_liked` before `top_m_mean` before `blend`; raw before centered, since centering needs the means table).
- Validation gains are optimistic because the window was used for selection; only the later test-window run is reported as the unbiased result.

**Applying the choice**

- A migration changes the scorer's defaults to the chosen method and parameters, and `get_feed` calls the chosen method. If raw vectors win, the default becomes `centered: false`; the `centered` option, `embedding_language_means`, and eligibility rules stay unchanged.
- If raw vectors win, design.md §1 records the changed default and why it differs from gate 1.
- design.md §2 is updated with the decision, the numbers, and the reasoning (including where it contradicts gate 1).

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — composite personas**
   1. Unit tests: relevance is the union of member labels; likes alternate between members with the prefix property; dislikes are irrelevant to both; balanced coverage is computed correctly; missing cells follow per-member rules.
2. **Task 2 — new interest models**
   1. `supabase db reset` applies the migration cleanly; existing `rank_items` and `get_feed` integration tests pass unchanged.
   2. New integration tests with controlled vectors: `top_m_mean` with $m = 1$ equals `nearest_liked`; `blend` with $\alpha = 1$ and $\alpha = 0$ equals `nearest_liked` and `average_vector`; a two-interest case ranks items from both interests above an item between them for `nearest_liked`; invalid `top_m` or `blend_alpha` raises an error; `because_item_id` is the most similar like.
   3. `pnpm test:integration` passes with 0 skipped.
3. **Task 3 — search**
   1. The selection rule is committed (in this spec and `evaluation/tuning-rule.json`) before the first stage-1 run.
   2. `pnpm eval:tune` runs both stages on the validation window only, refuses `--window test`, and writes the summary with every configuration's objective, constraints, and result-file hash.
4. **Task 4 — decision and default**
   1. The chosen configuration follows the committed rule; a migration makes it the default in `get_feed`; integration tests confirm `get_feed` uses it.
   2. design.md §2 and `docs/ai-log.md` record the decision, the stage-1 and stage-2 tables, and the limitation that validation numbers are optimistic.
5. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [ ] 1. Composite personas and balanced coverage in the replay (criterion 1).
- [ ] 2. Migration: `top_m_mean` and `blend` in the private scorer, parameter validation, integration tests (criterion 2).
- [ ] 3. Commit the selection rule; `pnpm eval:tune`; run stage 1 and stage 2 on validation (criterion 3).
- [ ] 4. Apply the chosen configuration to `get_feed`; update design.md and the AI log (criterion 4).

## Decisions

- Tuning happens before exploration and diversity, because those build on the chosen ranker.
- Composite personas reuse the existing label set; no new labeling.
- The freeze and the test-window run wait until exploration and diversity are settled.
- All personas are weighted equally. Composite personas already carry 6 of 10 weights, and the balanced-coverage constraint guards the multi-interest case directly; a weight chosen after the results would be an unsupported tuned number.
- If raw vectors win, centering stays as an option (default off) instead of being removed. Gate 1 (raw 0.65 vs centered 1.00) and the validation run (±0.05) disagree, the code is already built and tested, and a future embedding model may bring the language bias back.
