# 020 — Ranking tuning with multi-interest personas

**Status:** Draft  
**Milestone:** Final (weeks 3–6, before the parameter freeze and gate 2)  
**Depends on:** 006 (evaluation harness, final snapshot, validation run)  
**Estimate:** 14 h

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

- All 6 pairs of the 4 existing personas (e.g. "AI and software + Finnish sports"), derived in the replay from `evaluation/personas.json` and the existing label set. For precision, an item is relevant if it is relevant to either member.
- **Member-exclusive items:** an item is exclusive to a member if it is relevant to that member and not to the other. Labels overlap (e.g. in the feedback window, 23 of 62 relevant cars items are also relevant to AI), so likes and coverage use exclusive items only.
- Feedback per persona and seed: likes alternate between the members' exclusive feedback-window items, so no item is liked twice. The starting member alternates by seed index (even seeds start with the first member), so odd $k$ does not favour one member. Each member's likes keep the prefix property of spec 006. Dislikes are $\lfloor k/2 \rfloor$ items relevant to neither member.
- Extra metric **balanced coverage** per seed and $k$: 1 if the top 10 contains at least 2 items exclusive to each member, else 0.
- Composite personas are evaluated for $k \in \{3, 5, 10, 20\}$. A cell is missing if either member has fewer exclusive feedback items than its like quota, there are fewer than $\lfloor k/2 \rfloor$ items relevant to neither, or the candidate pool has no item relevant to the composite. Otherwise spec 006 missing-cell rules apply.

**New interest models** (in the private scorer; same dislike penalty, recency, cold start, tie-breaking, and eligibility as the existing methods)

- `top_m_mean`: interest = mean of the $m$ highest similarities between the candidate and the likes ($m = \min(m, |P|)$). $m = 1$ equals `nearest_liked`.
- `blend`: interest $= \alpha \cdot \max_{p} s(c,p) + (1-\alpha) \cdot s(c, \bar{p})$. $\alpha = 1$ equals `nearest_liked`, $\alpha = 0$ equals `average_vector`.
- New `p_params` keys `top_m` and `blend_alpha`, validated (integer 1–10; number 0–1).
- `because_item_id` stays the most similar like for every method, so explanations keep working.
- $m$ is capped by the number of eligible likes; cold start is unchanged for every method.

**Search** (validation window only)

- Stage 1, interest model at default $\lambda$ and $\beta$: `nearest_liked`, `average_vector`, `top_m_mean` with $m \in \{2, 3, 5\}$, `blend` with $\alpha \in \{0.25, 0.5, 0.75\}$, each centered and raw (16 configurations).
- Stage 2, for the two stage-1 configurations with the best objective that meet the constraints: $\lambda \in \{0, 0.25, 0.5, 1\}$ × recency weight $\beta \in \{0, 0.05, 0.1, 0.2\}$.
- Same seeds, $k$ values, near-duplicate threshold, and label set as the first validation run.
- The replay takes a method and its parameters as explicit input instead of a fixed method list. Each configuration is one validation result file whose provenance records the method, all resolved parameters (not only overrides), and the hash of `evaluation/tuning-rule.json`.
- `pnpm eval:tune` drives the grid by calling the replay for each configuration and writes a summary table (`evaluation/results/tuning-<timestamp>.csv` and `.json`).
- After the task 2 migration and `supabase db reset`, the snapshot is re-imported with `pnpm eval:import` and its hashes verified before the first stage-1 run.

**Selection rule** (fixed before the search runs)

- **Baseline:** the pre-tuning production configuration, fixed in `evaluation/tuning-rule.json`: `nearest_liked`, centered, $\lambda = 0.5$, $\beta = 0.1$.
- **Aggregation:** headline precision@10 is averaged over complete seeds within each cell (persona × $k$), then over cells. Missing cells depend only on the snapshot and labels, not on the configuration; the tuner fails if any two configurations have different sets of missing cells.
- **Objective:** mean headline precision@10 over $k \in \{3, 5, 10, 20\}$ and all 10 personas (4 single, 6 composite), each persona weighted equally.
- **Constraints:**
  - balanced coverage, averaged over complete seeds, then over composite persona × $k$ cells, not more than 0.05 below the highest balanced coverage among all searched configurations;
  - en→fi and fi→en precision@10, aggregated the same way over available cross-lingual cells, each not more than 0.05 below the baseline. A direction with no available cells is reported as not assessable and does not constrain.
- **Winner:** among all stage-1 and stage-2 configurations that meet the constraints, take those within 0.01 of the best objective among configurations meeting the constraints, and pick the simplest (fewer parameters; `average_vector` or `nearest_liked` before `top_m_mean` before `blend`; raw before centered, since centering needs the means table). Remaining ties go to the higher objective, then to grid order. If no configuration meets the constraints, the production default stays unchanged.
- Validation gains are optimistic because the window was used for selection. The later test-window run is a held-out estimate against LLM proxy labels, not real-user relevance. Composite personas share labels with single personas, so persona results are correlated.

**Applying the choice**

- A migration changes the private scorer's defaults and the public wrapper's defaults to the chosen method and resolved parameters, and `get_feed` calls the chosen method; all three agree. The chosen method and resolved parameters are recorded in the tuning summary as the input for the later freeze. If raw vectors win, the default becomes `centered: false`; the `centered` option, `embedding_language_means`, and eligibility rules stay unchanged.
- If raw vectors win, design.md §1 records the changed default and why it differs from gate 1.
- design.md §2 is updated with the decision, the numbers, and the reasoning (including where it contradicts gate 1).

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — composite personas**
   1. Unit tests: relevance is the union of member labels; likes use member-exclusive items only and never repeat an item; likes alternate between members with the prefix property and the starting member alternates by seed; dislikes are irrelevant to both; balanced coverage counts exclusive items only; each composite missing-cell rule produces a missing cell.
2. **Task 2 — new interest models**
   1. `supabase db reset` applies the migration cleanly; existing `rank_items` and `get_feed` integration tests pass unchanged.
   2. New integration tests with controlled vectors: `top_m_mean` with $m = 1$ equals `nearest_liked`; `blend` with $\alpha = 1$ and $\alpha = 0$ equals `nearest_liked` and `average_vector`; `top_m_mean` with $m = 2$ and `blend` with $\alpha = 0.5$ match hand-computed scores; $m$ larger than the number of likes uses all likes; cold-start order is identical for every method; a two-interest case ranks items from both interests above an item between them for `nearest_liked`; invalid `top_m` or `blend_alpha` raises an error; `because_item_id` is the most similar like.
   3. `pnpm test:integration` passes with 0 skipped.
3. **Task 3 — search**
   1. The selection rule is committed (in this spec and `evaluation/tuning-rule.json`) before the first stage-1 run.
   2. Unit tests for the selector on synthetic results: constraint failures, the 0.01 band anchored to the best configuration meeting the constraints, the 0.05 boundaries, a not-assessable cross-lingual direction, differing missing cells (fails), ties, and no configuration meeting the constraints (keeps the production default).
   3. The snapshot is re-imported and verified after the task 2 reset. `pnpm eval:tune` runs both stages on the validation window only, refuses `--window test`, and writes the summary with every configuration's method, resolved parameters, objective, constraint values, and result-file hash.
4. **Task 4 — decision and default**
   1. The chosen configuration follows the committed rule; a migration makes it the default in the private scorer, the public wrapper, and `get_feed`; integration tests confirm all three use it.
   2. design.md §2 and `docs/ai-log.md` record the decision, the stage-1 and stage-2 tables, and the limitations: validation numbers are optimistic, labels are LLM proxies, and persona results are correlated.
5. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [ ] 1. Composite personas and balanced coverage in the replay (criterion 1).
- [ ] 2. Migration: `top_m_mean` and `blend` in the private scorer, parameter validation, integration tests (criterion 2).
- [ ] 3. Commit the selection rule; replay configuration input; selector and `pnpm eval:tune`; re-import the snapshot; run stage 1 and stage 2 on validation (criterion 3).
- [ ] 4. Apply the chosen configuration to `get_feed`; update design.md and the AI log (criterion 4).

## Decisions

- Tuning happens before exploration and diversity, because those build on the chosen ranker.
- Composite personas reuse the existing label set; no new labeling.
- The freeze and the test-window run wait until exploration and diversity are settled.
- All personas are weighted equally. Composite personas already carry 6 of 10 weights, and the balanced-coverage constraint guards the multi-interest case directly; a weight chosen after the results would be an unsupported tuned number.
- Likes and balanced coverage use member-exclusive items, so overlapping labels cannot fake coverage of both interests. Precision still counts an item relevant to either member.
- The 0.05 coverage tolerance is kept: coverage is averaged over about 60 seed × persona results per $k$, so it moves in steps of about 0.02, not 0.10.
- If raw vectors win, centering stays as an option (default off) instead of being removed. Gate 1 (raw 0.65 vs centered 1.00) and the validation run (±0.05) disagree, the code is already built and tested, and a future embedding model may bring the language bias back.
