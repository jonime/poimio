# 007 — Exploration slots and diversity

**Status:** Done
**Milestone:** Final (weeks 5–6, before the parameter freeze and gate 2)  
**Depends on:** 006 (evaluation harness), 020 (tuned `blend` default and tuning tools)  
**Estimate:** 13 h

## Goal

Keep the personalized feed from narrowing to one cluster of near-identical items, and let users meet sources they have not liked yet. The diversity strength is chosen on the validation window with a rule fixed before the search; the exploration share is a fixed product choice whose effect is measured and reported. Both become part of the configuration that is frozen for the one-time test run.

## Context

- Ranking, the tuned default, and the planned slot mix: [design.md §2.1–2.2](../design.md#2-recommendation)
- Explanations: [design.md §7.4](../design.md#74-explanations)
- Evaluation protocol and the tuning tools: [spec 006](006-evaluation.md), [spec 020](020-ranking-tuning.md), `lib/evaluation-tuning.ts`, `pnpm eval:tune`
- Scorer: `ranking_private.rank_items` behind the service-role-only `public.rank_items`; `get_feed` calls the private scorer (migration `20261120000000_adopt_blend_ranking_default.sql`)
- Freeze and gate 2: [plan.md §9](../plan.md#9-decision-gates-and-cut-order)

## In scope

- Diversity re-ranking (maximal marginal relevance, MMR) in the private scorer, with one tuned strength parameter.
- Exploration slots in the private scorer: fixed positions filled with items from sources the user has not liked.
- `get_feed` returns an `exploring` reason; the feed card shows the exploration explanation.
- A diversity search on the validation window with a committed selection rule, and a report of the exploration effect. No new labels.
- The freeze format records the full production treatment, so the later test run reproduces the feed.

## Out of scope

- Creating the freeze file and the test-window run (spec 006, week 7).
- Negative-feedback reasons and per-user LLM limits (separate specs; see [plan.md §7.1](../plan.md)).
- The "related but unfamiliar" similarity band from the original slot plan (see Decisions).
- Per-source caps, same-story grouping, and changes to cold start.

## Design notes

**Order of operations in the private scorer** (each call starts from scratch)

1. Remove rated and excluded IDs from the candidate pool, as today.
2. Score and order candidates as today (final score, then the existing tie-breaks). The returned `score` stays this score.
3. Apply MMR (if enabled) to get the main sequence.
4. Insert exploration items (if enabled).
5. Apply the limit.

Both transformations happen before the limit, so a shorter limit returns a prefix of a longer one. Both apply only to `nearest_liked`, `average_vector`, `top_m_mean`, and `blend` when there is at least one eligible like; cold start, `newest_first`, and `random` are unchanged.

**Diversity re-ranking (MMR)**

- Take the top 100 candidates in score order. The first pick is the highest-scoring candidate. Each next pick maximizes $(1-\mu) \cdot \text{score}(c) - \mu \cdot \max_{s \in S} \text{sim}(c, s)$, where $S$ is the set already picked; ties go to higher score, then newer publication time, then ID.
- Up to 30 positions are filled this way. The unpicked members of the top 100 follow in score order, then candidates from rank 101 onward. No candidate is lost or duplicated.
- $\text{sim}$ is signed cosine similarity on the same vectors as the interest score (language-centered unless `centered` is false), with the existing zero-vector handling (similarity 0).
- Each remaining candidate's maximum similarity to $S$ is kept and updated after each pick, so each pick compares only against the newest picked item. With $\mu = 0$ the step is skipped.
- New `p_params` key `diversity` ($\mu$), validated as a number 0–1. $\mu = 0$ gives exactly the current order. `because_item_id` is unchanged.

**Exploration slots**

- New `p_params` key `exploration` (boolean). Positions 5, 15, and 25 of the output are exploration slots; other positions take the next item of the main sequence. Lists shorter than a slot position simply have fewer slots; larger limits still have only these three.
- A source counts as liked if any eligible ID in `p_liked_ids` belongs to it. The scorer never reads feedback or identity itself. In `get_feed` this means the latest 200 eligible likes, so a source whose likes are all older than those can count as unliked (documented limitation).
- A slot takes the highest-scoring candidate not yet placed, from any rank (not only the top 100), whose source is not liked. It is removed from the main sequence. If no such candidate exists, the slot takes the next main item and is not flagged.
- An unliked-source item that the main sequence places in a normal position stays there and is not flagged.
- The private scorer and the public wrapper return a new boolean column `exploration`. `get_feed` keeps its return columns and returns reason `exploring` for flagged rows; the card shows "Exploring: something new" ([design.md §7.4](../design.md#74-explanations)).
- Positions are relative to each call, so each 30-item page has up to 3 exploration items. Feedback on an exploration item is an ordinary signal.
- Exploration is off by default in the private scorer and the public wrapper, so baselines and earlier result files keep their meaning. `get_feed` passes `exploration: true` only from task 4, after the UI can show the reason.
- The share (3 of 30, about 10%) is a fixed product choice, not tuned for relevance. Exploration may raise, keep, or lower precision; the report shows the signed effect.

**Migration safety**

- Adding the `exploration` column changes the return type, so the private scorer and the public wrapper are dropped and recreated in one migration, by exact signature and without `CASCADE`.
- The `with ordinality` aliases in the wrapper and in `get_feed` are updated for the new column.
- Revokes and grants from migration `20261110000000_restrict_rank_items_rpc.sql` are restored explicitly: `anon` has no access, the private scorer stays executable by `authenticated` (for `get_feed`) and the service role, and the public wrapper stays service-role-only. `SECURITY INVOKER` and empty search paths are kept.

**Evaluation tooling**

- `pnpm eval:tune --rule <path>` selects the rule file; the default stays `evaluation/tuning-rule.json`, and spec 020 behaviour and tests are unchanged. The diversity rule has its own validated format (the fixed configuration and the $\mu$ grid) and its own selector; aggregation and availability helpers are reused.
- `diversity` and `exploration` are part of the resolved parameters, configuration IDs, summaries, and replay provenance (including the hash of the rule file actually used).
- Replay keeps the `exploration` flag for the returned top 10.
- The freeze format records the production treatment explicitly: method and all resolved parameters, including `diversity` and `exploration`. Test replay ranks the production row with exactly that treatment; baseline rows run with `diversity: 0` and `exploration: false`. Creating the freeze and running the test window stay in spec 006.

**Diversity search** (validation window only)

- Fixed: the spec 020 winner (`blend`, $\alpha = 0.5$, centered, $\lambda = 0.5$, $\beta = 0$), exploration off, and the same seeds, $k$ values, near-duplicate threshold, label set, and personas (4 single, 6 composite) as spec 020.
- Grid: $\mu \in \{0, 0.1, 0.2, 0.3, 0.5\}$. The rule is committed in `evaluation/diversity-rule.json` before the first run.
- Metrics per configuration: the spec 020 objective (mean headline precision@10), balanced coverage, en→fi and fi→en precision@10, and mean distinct sources in the top 10 (reported, not used for selection). Population, aggregation, availability, insufficient-data errors, and the missing-cell consistency check are exactly as in spec 020.

**Selection rule** (fixed before the search runs; boundaries inclusive, compared with a tolerance of $10^{-9}$)

1. **Reference:** $\mu = 0$.
2. **Eligible:** objective at least reference − 0.02; en→fi and fi→en precision@10 each at least reference − 0.05 (a direction with no available cells does not constrain, as in spec 020); balanced coverage at least reference + 0.02.
3. If no configuration with $\mu > 0$ is eligible, $\mu = 0$ stays and MMR is off.
4. Otherwise take the highest balanced coverage among eligible configurations, keep those at least that value − 0.01, and choose the smallest $\mu$ among them.

The 0.02 coverage margin equals about five seed-level changes across the 24 composite persona × $k$ cells; smaller differences are treated as noise.

**Exploration report** (no tuning)

- Replay the chosen configuration on validation with exploration off and on, using the same-language headline runs (single and composite personas, the selection $k$ values). Cross-lingual runs are left out: every target-language source is unliked by construction.
- Within the top 10 only position 5 is a slot, so the report covers that slot:
  - signed objective difference (on − off) and change in distinct sources in the top 10;
  - slot fill rate: share of runs where position 5 is flagged;
  - hit rate: relevant flagged items / flagged items, pooled over all runs; null if nothing was flagged.
- Manual check, small: the user reviews the top 10 for 2 composite personas before and after MMR, and about 10 exploration items from their own feed. The notes are qualitative; there is no labeling task.

**Applying the choice**

- A migration sets the chosen $\mu$ as the `diversity` default in the private scorer, the public wrapper, and `get_feed`, and `get_feed` passes `exploration: true`. The tuning summary records the full treatment as the input for the freeze.
- design.md §2.2 replaces the planned 70/20/10 slot mix with the implemented design and the results; §7.4 stays.

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — scorer**
   1. `supabase db reset` applies the migration cleanly. Existing `rank_items` and `get_feed` integration tests pass; tests that compare exact return rows are updated only for the new `exploration` column, and parity tests compare identical treatments.
   2. Security: grants match migration `20261110000000` exactly. `anon` cannot use the `ranking_private` schema or execute either function; `authenticated` can execute the private scorer (needed by `get_feed`) but not the public wrapper; the service role can execute both. Both functions are `SECURITY INVOKER` with an empty search path.
   3. MMR tests with controlled vectors: $\mu = 0$ returns the previous order; a hand-computed sequence of at least 3 picks for $\mu > 0$ in both vector modes; $\mu = 1$; negative and zero similarity; deterministic ties; a fixture with more than 100 candidates where an item below rank 30 is promoted and the tail order follows the rule; returned `score` is unchanged; invalid `diversity` raises an error.
   4. Exploration tests: positions 5, 15, and 25 hold the best not-yet-placed items from unliked sources and are flagged, including a candidate below rank 100; other items keep their main-sequence order; a slot without a candidate takes the next main item unflagged; an ineligible ID in `p_liked_ids` does not make its source liked; a short pool has only the slots that fit; with `exploration: false` nothing is flagged; `get_feed` maps flagged rows to reason `exploring`.
   5. Both transformations: limit 10 returns a prefix of limit 30; two consecutive 30-item `get_feed` pages with exclusions; cold start, `newest_first`, and `random` ignore both parameters; `get_feed` limit and exclusion clamps are unchanged.
   6. Latency: on the local snapshot with 200 likes and 200 dislikes, the median of 10 `get_feed` calls with $\mu = 0.3$ and exploration on is under 500 ms and at most twice the median with both off. The numbers are recorded in the AI log.
   7. `pnpm test:integration` passes with 0 skipped.
2. **Task 2 — feed UI**
   1. A feed card with reason `exploring` shows "Exploring: something new"; unit test for the reason mapping. Existing explanations are unchanged.
3. **Task 3 — tooling, search, and report**
   1. `evaluation/diversity-rule.json` is committed before the first run.
   2. Unit tests for the diversity selector on synthetic results: each eligibility boundary, a direction without cells, the example reference 0.650 / $\mu = 0.1$ at 0.665 / $\mu = 0.2$ at 0.675 (selects 0.2), chained near-ties, and $\mu = 0$ when nothing is eligible.
   3. Unit tests: `--rule` selection; a wrong rule hash in provenance is rejected; spec 020 tuning tests pass unchanged; configuration IDs include `diversity` and `exploration`; the exploration report computes signed difference, fill rate, and hit rate (including null) on a synthetic fixture.
   4. Freeze contract: unit test that the freeze format records the method and all resolved parameters, and that test replay ranks baselines with `diversity: 0` and `exploration: false`; integration test that the frozen production treatment gives the same order as `get_feed`.
   5. The snapshot is re-imported and verified after the task 1 reset. `pnpm eval:tune --rule evaluation/diversity-rule.json` runs the grid on the validation window only, refuses `--window test`, and writes a summary with each configuration's resolved parameters, metrics, eligibility, and result-file hash. The exploration report is written for the chosen configuration.
4. **Task 4 — decision and default**
   1. The chosen $\mu$ follows the committed rule. A migration makes it the default in the private scorer, the public wrapper, and `get_feed`, and `get_feed` passes `exploration: true`; integration tests confirm both.
   2. design.md §2.2 and `docs/ai-log.md` record the decision, the grid table, the exploration report, the manual notes, the liked-source limitation, and the evaluation limitations (validation numbers are optimistic; labels are LLM proxies; persona results are correlated).
5. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [x] 1. Migration: MMR, exploration slots, `exploration` column, `exploring` reason in `get_feed` (exploration still off there), grants, tests, latency check (criterion 1).
- [x] 2. Feed card explanation for exploration items (criterion 2).
- [x] 3. `--rule` and the diversity selector, parameters in IDs and provenance, freeze contract, exploration report; commit the rule; re-import the snapshot; run the grid and the report (criterion 3).
- [x] 4. Apply the chosen $\mu$ and turn exploration on in `get_feed`; manual check; update design.md and the AI log (criterion 4).

## Decisions

- Negative-feedback reasons move to a separate spec; per-user LLM limits move to the natural-language feed tuning spec, the first feature that calls an LLM per user.
- No bulk labeling: the search and the report use the existing label set; manual work is limited to reviewing a few examples.
- One exploration type (sources without likes) instead of the original 70/20/10 mix. The "related but unfamiliar" band needs its own thresholds and cannot be judged without new labels.
- Exploration is not tuned: its purpose is variety and learning new interests, which relevance labels for fixed personas cannot measure. Its signed effect is reported instead.
- MMR instead of a per-source cap: relevant items for a topic often come from few sources, so a cap would remove relevant items, while MMR targets redundancy directly.
- Diversity and exploration live in the private scorer, so replay and the feed use one implementation, as required by spec 006.
- The exploration report covers the top 10 (slot 5) only, so replay does not need 30-row results; slots 15 and 25 are covered by the integration tests and the manual check.
- No intra-list similarity metric: balanced coverage and distinct sources are enough to judge diversity here.

## Open questions

- None.
