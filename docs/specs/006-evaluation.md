# 006 — Evaluation harness

**Status:** Approved  
**Milestone:** Final (weeks 2–5; final test run in week 7)  
**Depends on:** 001 (content, embeddings), 003 (`get_feed`, centering), 005 (completed descriptions)  
**Estimate:** 23 h

## Goal

Measure, reproducibly and without inflating the results, whether the production recommender (nearest-liked on language-centered vectors) ranks relevant items better than simple baselines, and whether interests transfer between Finnish and English. The harness evaluates the **same SQL ranking code** that serves the feed.

## Context

- Protocol and metrics: [design.md §4](../design.md#4-evaluation)
- Production ranking: `get_feed` in `supabase/migrations/20261031000002_return_summary_origin_from_feed.sql`, [spec 003](003-feed-ui.md)
- Cross-lingual check moved from [spec 001](001-ingestion.md) (task 11, criterion 10)
- Early experiment scripts for reference: `lib/early-ranking.ts`, `scripts/*ranking*.mts`
- Environment rules: [AGENTS.md](../../AGENTS.md) (production is read-only unless authorized)

## In scope

- Refactor the scoring in `get_feed` into a reusable SQL function `rank_items` with explicit inputs, used by both the feed and the evaluation.
- Snapshot export from production (read-only) and import into local Supabase.
- Evaluation personas, LLM relevance labels, and a manual agreement check.
- Cross-lingual check (moved from spec 001).
- Replay runner with the protocol safeguards of design §4.3 and the metrics of §4.4.
- A guarded, one-time test-window run with frozen parameters.

## Out of scope

- Parameter tuning itself (week 6, with spec 007), beyond running the validation window.
- Charts and the final report text (week 7); the harness writes CSV and JSON.
- Exploration slots and diversity re-ranking (spec 007); evaluated later with the same harness.
- Online metrics from real users.

## Design notes

**Shared ranking function**

- `public.rank_items(p_candidate_ids uuid[], p_liked_ids uuid[], p_disliked_ids uuid[], p_as_of timestamptz, p_method text default 'nearest_liked', p_params jsonb default '{}', p_seed integer default 0, p_limit integer default 30)` returns `item_id`, `score`, `because_item_id`, ordered by rank.
- `SECURITY INVOKER`, `set search_path = ''`, reads only shared tables (`content_items`, `sources`, `embedding_language_means`); it never reads `feedback` and takes no `user_id`. Execute granted to `authenticated` and `service_role`.
- Only eligible items (design §1 / spec 003 rules: active model, embedding, mean row, completed description) count as candidates or signals; others in the arrays are ignored.
- Notation: $s(a, b)$ is centered similarity (`centered_similarity`), or raw cosine similarity when `centered = false`; $P$ = eligible likes, $N$ = eligible dislikes; $r(c) = 0.5^{\text{age}(c)/h}$ with age measured at `p_as_of`.
- Methods and their exact ordering (ties broken by `published_at desc`, then `id`):
  - `nearest_liked` (production): score $= \max_{p \in P} s(c, p) - \lambda \cdot \max_{n \in N} s(c, n) + \beta \cdot r(c)$; order by score descending.
  - `average_vector`: score $= s(c, \bar{p}) - \lambda \cdot \max_{n \in N} s(c, n) + \beta \cdot r(c)$, where $\bar{p}$ is the mean of the liked items' centered (or, with `centered = false`, raw) vectors; order by score descending. Only the interest term differs from `nearest_liked`.
  - `newest_first`: **feedback-independent** reference: order by `published_at desc`, then `id`; `score` is null.
  - `random`: **feedback-independent** reference: order by `md5(id::text || p_seed::text)`; `score` is null.
  - The dislike penalty term is 0 when $N$ is empty.
- With no eligible likes, `nearest_liked` and `average_vector` use the existing cold-start ordering (source round-robin, dislike-similar items last), so they are identical at $k = 0$.
- **Defaults block moves into `rank_items`**: `lambda`, `recency_weight`, `dislike_threshold`, half-lives, and `centered` (default `true`; `false` gives the raw-vector variant for the report). `p_params` overrides individual keys; unknown keys raise an error.
- Recency is computed relative to `p_as_of`, not `now()`.
- `get_feed` keeps its signature and behaviour: it selects candidates (window, not rated, not excluded) and the caller's likes and dislikes, then calls `rank_items(..., now(), 'nearest_liked', '{}')` and joins the card fields.

**Snapshot**

- `pnpm eval:export` reads **production** read-only (`--env-file=.env.production.local`, explicit) and writes gitignored files under `evaluation/snapshot/`, with a schema version:
  - `sources.jsonl`: every source referenced by the exported items, with **original UUIDs** (cold-start ordering partitions by `source_id`) and all non-null columns.
  - `items.jsonl`: eligible items in the chosen date range with **original UUIDs** and every column needed to satisfy the current schema and constraints: `id`, `source_id`, `type`, `url`, `title`, `summary`, `summary_origin`, `enrichment_status` and the other enrichment-state columns, `language`, `categories`, `thumbnail_url`, `published_at`, `embedding`, `embedding_model`, `created_at`.
  - `means.jsonl`: the frozen `embedding_language_means` rows, including the mean vectors.
- A committed manifest `evaluation/snapshot/manifest.json` records the schema version, date range, window boundaries, item IDs, a hash of each exported item row (all exported fields), a hash of each mean vector, and counts per language and source.
- `pnpm eval:import` loads the snapshot into **local** Supabase only (service role; refuses non-local URLs), requires empty `sources`, `content_items`, and `embedding_language_means` (run after `supabase db reset`), inserts rows with their original UUIDs, and fails on any missing column, schema-version mismatch, or hash mismatch. All later steps run locally.
- Window split by `published_at`: feedback (oldest ~50%), validation (~25%), test (newest ~25%), stored in the manifest. The snapshot must cover at least 14 days (ingestion has run since 28 Oct, so the earliest freeze is about 11 Nov).

**Personas**

- `evaluation/personas.json`: 4 personas with a one-paragraph description each, e.g. "AI and software", "cars and engineering", "science and space", "Finnish sports".
- Personas are configuration, not database users: the replay passes explicit liked/disliked IDs to `rank_items`. User isolation is already covered by the RLS tests.

**LLM relevance labels**

- `pnpm eval:label` labels every (persona, snapshot item) pair as relevant or not, in batches of ~20 items per request, with JSON output validated by schema, temperature 0, and a versioned prompt.
- The model endpoint is configurable (`LLM_BASE_URL`, `LLM_MODEL`) and defaults to the local MTPLX server; the command refuses to run in CI.
- Labels are cached and committed in `evaluation/labels/<model>.jsonl` keyed by persona, item, model, and prompt version; runs are resumable and only label missing pairs.
- **One label set per experiment.** A label set is complete only when every (persona, snapshot item) pair has a label from the same model and prompt version. The replay refuses to run with an incomplete set or with labels from more than one model, and records the label set's ID and hash.
- Labels are proxy judgments; the manual check below measures how far they can be trusted.

**Manual agreement check**

- Sampling design: (persona, item) pairs are drawn with stratification by persona, language, and the primary model's (Qwen's) label; stratum sizes in the snapshot and in the sample are recorded. Each sampled pair has a known inclusion probability.
- Two disjoint blind sets of 60 pairs each (15 per persona, balanced by language), labeled without seeing any LLM label:
  - **selection set:** used only to decide whether the fallback model is needed;
  - **reporting set:** scored once, after the label model is chosen, to report its agreement.
- Agreement metrics use inverse-inclusion-probability weights, so they estimate agreement on the snapshot distribution: weighted percent agreement, weighted Cohen's κ, and the LLM labels' precision and recall for "relevant". Reported overall, for Finnish, and for English, together with the stratum counts.
- `pnpm eval:agreement export --set selection|reporting` and `pnpm eval:agreement score --set selection|reporting --labels <set>`.
- **Fallback:** if weighted κ on the selection set is below 0.6 for Finnish or English, the **whole snapshot** is labeled with `gpt-6-luna` (all persona–item pairs). The model with the higher weighted κ on the selection set is used for every replay; the other set is kept and reported but never mixed in.

**Cross-lingual check** (from spec 001)

- `pnpm eval:crosslingual propose` pairs each Yle News in English item with Finnish Yle items published within ±2 days; the LLM proposes the best match per English item (or none) from titles and summaries.
- I confirm or reject the proposals in a CSV; at least 10 confirmed pairs are needed.
- `pnpm eval:crosslingual score` reports matched-pair similarity and the 95th percentile of random Finnish–English pairs, for raw and centered vectors.

**Replay**

- `pnpm eval:replay --window validation|test` for every persona, seed (≥ 10), and feedback size $k \in \{0, 1, 3, 5, 10, 20\}$:
  - Feedback is sampled once per persona and seed from the feedback window: $k$ relevant items as likes and $\lfloor k/2 \rfloor$ non-relevant items as dislikes (prefixes of one fixed sequence, so larger $k$ extends smaller $k$). Every method receives exactly the same lists.
  - Candidates: all snapshot items in the chosen window minus rated items; `p_as_of` is the end of the window.
  - Methods: `nearest_liked`, `nearest_liked` with `centered = false`, `average_vector`, `newest_first`, `random`.
  - Validation runs use `--params <file>` (default: the `rank_items` defaults); test runs take parameters only from the freeze file.
- **Near-duplicates:** a candidate whose centered similarity to any feedback item is at least the threshold is a near-duplicate. The threshold is chosen by inspecting pairs **from the feedback window only**, before any validation run, and stored in `evaluation/config.json`. Each cell is ranked **twice** with `rank_items`:
  - **headline:** near-duplicates are removed from the candidate pool **before** ranking, and precision@10 is computed on that ranking;
  - **duplicate-inclusive:** the full candidate pool is ranked, reported separately.
- **Metrics:** precision@10 per method, persona, and $k$ (mean, standard deviation, and the paired difference to `average_vector` with a 95% interval across seeds); distinct sources and categories in the top 10; top-10 overlap (Jaccard) between personas at $k = 10$.
- **Cross-lingual retrieval** (separate runs, same seeds and $k$):
  - **en→fi:** likes are $k$ relevant **English** items and dislikes $\lfloor k/2 \rfloor$ non-relevant **English** items, so no Finnish signal is given; the candidate pool contains only **Finnish** items of the window. Metric: precision@10 on that Finnish pool, for every method including the raw-vector variant.
  - **fi→en:** the same with the languages swapped.
  - The pool's number of relevant items is reported with each cell.
- **Missing cells:** a cell is reported as missing, not padded, if the persona has fewer than $k$ relevant or fewer than $\lfloor k/2 \rfloor$ non-relevant items in the feedback window (in the required language for cross-lingual runs), or if the candidate pool has no relevant item.
- Output: validation runs write `evaluation/results/validation-<timestamp>.json` and `.csv`; every result includes git commit, snapshot manifest hash, label set ID and hash, near-duplicate threshold, seeds, and parameters.

**Test-window guard (one frozen, one-time run)**

- `evaluation/frozen-params.json` records the parameters, the commit hash, the snapshot manifest hash, the label set ID and hash, the near-duplicate threshold, the seeds, the $k$ values, and a timestamp. Its own hash is the **experiment ID**.
- `--window test` runs only if: the freeze file exists and is valid; the working tree is clean and `HEAD` equals the frozen commit; the imported snapshot, label set, and config hashes match the frozen ones; and no `--params` is given (parameters come only from the freeze file).
- The result is written to a fixed path, `evaluation/results/test-<experiment ID>.json` (and `.csv`). The command refuses to run if **any** test result exists for that experiment ID, and also if any other `test-*.json` exists unless `--new-experiment` is given with a reason that is stored in the result. Test results are committed.
- Tuning uses the validation window only.

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — shared ranking function**
   1. `supabase db reset` applies the migration cleanly; `rank_items` is executable by `authenticated` and `service_role` only and reads no per-user table.
   2. All existing `get_feed` integration tests pass unchanged.
   3. New integration tests: `rank_items` with a user's likes and dislikes returns the same order as `get_feed` for that user; `nearest_liked` and `average_vector` follow the exact formulas with controlled vectors and differ only in the interest term; `newest_first` and `random` ignore feedback; `centered = false` changes the cross-language test case; unknown parameter keys raise an error; `random` is deterministic per seed; ties follow `published_at desc`, then `id`.
2. **Task 2 — snapshot export and import**
   1. Export reads production only with the explicit production env file and performs no writes there; the manifest is committed and the snapshot files are gitignored.
   2. Import loads only into local Supabase with original UUIDs, refuses non-local URLs and non-empty target tables, satisfies all current constraints, and fails on any missing column, schema-version mismatch, or item or mean-vector hash mismatch. After import, cold-start ordering on the snapshot matches the export's source IDs.
3. **Task 3 — LLM labels**
   1. Labels are produced for every (persona, item) pair, validated against the schema, cached, and resumable; the model and prompt version are recorded. The replay refuses incomplete or mixed-model label sets. Unit tests cover batching, parsing, cache keys, and the completeness check.
4. **Task 4 — manual agreement**
   1. Two disjoint blind CSVs (selection and reporting, 60 pairs each) contain no LLM labels; the sampling design and stratum counts are recorded.
   2. Scoring reports weighted percent agreement, weighted κ, precision, and recall overall, for Finnish, and for English. Unit tests cover the weighted κ calculation against a hand-computed example.
   3. The model choice uses only the selection set; the reporting set is scored once, for the chosen label set. If the fallback is triggered, the whole snapshot is labeled with `gpt-6-luna` before any replay.
5. **Task 5 — cross-lingual check**
   1. At least 10 confirmed Finnish–English pairs; the score step reports raw and centered results. It passes if at least 9 of 10 matched pairs score above the 95th percentile of random pairs for at least one of them; otherwise a local multilingual embedding model is compared. The result is recorded in `docs/ai-log.md`.
6. **Task 6 — replay runner**
   1. Unit tests: identical feedback lists across methods, prefix property across $k$, rated-item exclusion, near-duplicates removed **before** ranking for the headline result and kept for the inclusive result, same-language feedback (likes and dislikes) in cross-lingual runs with a target-language-only pool, missing cells for each missing-cell rule, metric calculations.
   2. A validation run completes and writes JSON and CSV with all metrics and provenance fields.
7. **Task 7 — test-window guard**
   1. Unit tests: `--window test` fails without a valid freeze file, with a dirty tree or a different `HEAD`, with any hash mismatch, with `--params`, and when a test result for the experiment already exists; a different existing test result requires `--new-experiment` with a reason.
8. **Task 8 — documentation**
   1. design.md §4 reflects the final protocol (personas as configuration, `rank_items`, label model); the first validation results and the agreement numbers are recorded in `docs/ai-log.md`.
9. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [x] 1. Migration: `rank_items` with methods and parameters; refactor `get_feed` to use it; integration tests (criterion 1).
- [ ] 2. `pnpm eval:export` and `pnpm eval:import` with manifest and hash checks (criterion 2).
- [ ] 3. Personas file and `pnpm eval:label` (criterion 3).
- [ ] 4. `pnpm eval:agreement export|score` with the sampling design and weights; I label the selection set, decide on the fallback, then label the reporting set (criterion 4).
- [ ] 5. `pnpm eval:crosslingual propose|score`; I confirm pairs (criterion 5).
- [ ] 6. Near-duplicate threshold from the feedback window; `pnpm eval:replay` with metrics; first validation run (criterion 6).
- [ ] 7. Test-window guard, `frozen-params.json` format, and experiment ID (criterion 7).
- [ ] 8. Update design.md §4 and log results (criterion 8).

## Decisions

- The evaluation runs the production SQL ranking (`rank_items`) instead of a TypeScript copy, so results describe the deployed recommender.
- Baselines: `average_vector` differs from the recommender only in the interest term; `newest_first` and `random` are feedback-independent references.
- Evaluation data is a frozen snapshot copied from production into local Supabase; production is only read.
- Personas are configuration, not database users.
- The raw-vector variant is reported next to the centered recommender to show the effect of language centering.
- Relevance labels come from a **local Qwen 3.8 27B via MTPLX** (OpenAI-compatible server on localhost): free, and a different model family than the OpenAI embeddings. Labeling runs only locally, never in CI or production; the exact model build and quantization are recorded with the labels and in `docs/ai-log.md`.
- Fallback: decided on the selection set only (weighted κ below 0.6 for Finnish or English); the fallback model then labels the whole snapshot, and one complete label set is used per experiment.
- Personas: "AI and software", "cars and engineering", "science and space", "Finnish sports".

## Open questions

- None.
