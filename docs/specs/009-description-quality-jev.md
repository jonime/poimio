# 009 — Description quality experiment with TypeSafe Jev

**Status:** Approved
**Milestone:** Final (optional side experiment using the final snapshot from 11 Nov; third in the [plan's cut order](../plan.md#9-decision-gates-and-cut-order))
**Depends on:** 005 (description provenance), 006 (evaluation snapshot export)  
**Estimate:** roughly 10 h; reduced human audit approved on 16 Nov 2026

## Goal

Find out with a small, reproducible, offline experiment whether TypeSafe Jev can tell useful item descriptions from poor ones better than cheap deterministic rules, and whether it is accurate, reliable, and cheap enough for a later description-quality gate in ingestion. The experiment does not change ingestion, enrichment, embeddings, ranking, or the database.

### Approved reduced-effort pilot (16 Nov 2026)

This pilot replaces the original full human test-labelling requirement. Keep the
30 completed human dev labels and the original 150-item model test sample.
Human test work is capped at 30 articles total: retain the 8 completed labels
and select 22 more before viewing model outputs. Relabel 10 of those 30 at least
24 hours after audit completion. No video labels or replacement-pair labels are
required in this pilot; task 8 is deferred. Do not create an additional
disagreement-labelling queue.

Jev and L independently judge all 150 original test articles and the video
census after human audit labels and configuration are frozen. Only the
30-item human audit supports accuracy estimates. On other items, report
classifier agreement, stability, and operations, never AI-generated ground
truth. The small audit cannot establish per-language accuracy, a false
replacement rate of at most 5%, or production readiness. Report those claims
as insufficient evidence even if point estimates meet the original targets.
The outcome is whether a larger validation study is worth doing, not approval
for a production gate.

## Context

- Description fallback and provenance: [spec 005](005-description-enrichment.md), [design.md §1](../design.md#1-content-sources-and-representation), [§2.5](../design.md#25-llm-usage-limited), [§6.2](../design.md#62-content_items-shared)
- Snapshot, labelling, and agreement tooling reused here: [spec 006](006-evaluation.md)
- Environment, dependency, and security rules: [AGENTS.md](../../AGENTS.md)

Labels used below: **Verified** means checked in this repository, the local provisional snapshot, or the official TypeSafe docs on 3 Nov 2026. **Proposed** means a design choice for review.

## 1. Problem statement

A description is accepted when it is non-empty after normalization and is not link-only. Nothing checks whether it says what the item is about. The description is half of the embedding input (`title + "\n\n" + summary`), so a poor description affects ranking and is also shown on the card.

**Verified historically** in the pre-fix local provisional snapshot (`evaluation/snapshot/provisional/`, 1,074 completed items, 28 Oct – 2 Nov 2026; read-only check). Spec 010 later fixed the known Yle metadata description; this experiment uses the post-fix final snapshot:

| Origin          | Items | Examples of accepted poor descriptions                                                                                                                                                                              |
| --------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feed`          |   783 | BleepingComputer `"[...]"`; New Scientist `"Tom Gauld's weekly cartoon"`; Yle `"Testaa, oletko todellinen USA-tietäjä."` (quiz teaser); Technology Connections `"Innovation is sometimes funny. Links 'n stuff: …"` |
| `page_metadata` |   256 | **42 Yle items share the site-wide description `"Uutiset nopeasti ja luotettavasti."`**; Hacker News `"None"`, `"Alpine Linux"`, `"Table of contents"`, `"Northflank Status"`, `"This live blog is now closed."`    |
| `ai_generated`  |    35 | Hacker News `"The text lists 12 books with their authors or editors and publication years, followed by pagination links."` (describes the page, not the topic)                                                      |

61 items have descriptions shorter than 40 characters. Some are fine (`"Tekninen vika on saatu korjattua."`), so length alone is not a quality rule.

Two consequences shape the experiment:

1. **Some failures need no model.** Repeated site-wide text, placeholders, and descriptions equal to the title can be caught with deterministic rules. Jev is useful only if it catches failures these rules miss (vague, teaser, promotional, publisher-level, or page-structure text) without rejecting good descriptions.
2. **Under the current pipeline, Jev cannot reduce LLM generation.** AI summaries are created only when no feed or metadata description exists, and then there is nothing for Jev to judge. A quality gate would add generation for rejected descriptions. Jev reduces LLM calls only compared with broader policies, such as regenerating whenever a heuristic flags an item or always regenerating. Research question 3 is therefore answered with a policy simulation (§6.2) and a small replacement probe (task 8).

Research questions (from the request):

- **RQ1:** Can Jev reliably distinguish useful descriptions from poor ones, in Finnish and in English?
- **RQ2:** How does Jev compare with the current rules, simple experiment-only heuristics, and `gpt-6-luna` used as a judge?
- **RQ3:** Would a Jev-gated policy replace more poor descriptions per LLM call, without replacing good ones, than the alternative policies?
- **RQ4:** Is Jev accurate, stable, fast, and cheap enough to justify a production gate?

## 2. Current architecture (verified)

**Ingestion and selection**

- [`runIngestion`](../../lib/ingest.ts#L68) fetches active sources, parses each feed with [`parseFeed`](../../lib/normalize/parse.ts#L174), and inserts new items, then runs enrichment and embedding.
- [`buildSummary`](../../lib/normalize/parse.ts#L132) uses only RSS `description` or Atom `summary`. It treats link-only HTML ([`isLinkOnly`](../../lib/normalize/text.ts#L99), for example the Hacker News "Comments" link) as empty. For YouTube items without a summary, it falls back to `media:description` after [`removeYouTubeBoilerplate`](../../lib/normalize/boilerplate.ts). It converts HTML to text and applies [`truncateSummary`](../../lib/normalize/text.ts#L116) (1,000 characters).
- [`toContentItemRows`](../../lib/db.ts#L206) stores a non-empty summary as `feed` / `completed`. An empty summary is stored as `pending` with no provenance. **Feed descriptions never enter enrichment.** Spec 005 also leaves replacing a feed-supplied description out of scope.

**Enrichment** ([`runEnrichment`](../../lib/enrich/coordinator.ts#L151))

- Selects due `pending` items, at most 20 per run.
- [`fetchPageHtml`](../../lib/enrich/page.ts#L360) fetches the page with SSRF protection: pinned DNS, an 8 s timeout, a 1 MB limit, and at most 3 redirects.
- [`extractPageContent`](../../lib/enrich/page.ts#L496) returns the first usable value from `og:description`, `twitter:description`, and `description`. [`normalizedDescription`](../../lib/enrich/page.ts#L489) checks only that it is non-empty and not link-only. If none is usable, Readability provides the article text.
- [`summarizeArticleText`](../../lib/enrich/coordinator.ts#L84) calls `gpt-6-luna` through the Responses API with a raw `fetch`, without an SDK. Requests use a 15 s timeout and at most 200 output tokens. The run allows at most 20 summary requests. Before summarizing, [`articleContainsMoreThanTitle`](../../lib/enrich/coordinator.ts#L126) rejects article text that only repeats the title.
- Failures are isolated per item and retried after 1 h and 6 h. Provenance is `page_metadata` or `ai_generated`.
- Spec 010 now rejects Yle's known site-wide description through `SITE_WIDE_DESCRIPTIONS`. The experiment tests other poor descriptions and repeated text in the post-fix snapshot.

**Embeddings**

- [`embedPendingItems`](../../lib/embeddings.ts#L88) embeds only completed, non-empty summaries. It uses [`embeddingInput`](../../lib/embeddings.ts#L30) = `title + "\n\n" + summary` with `text-embedding-3-small@512`.
- Changing a summary clears the embedding, so the item is re-embedded.

**Reusable evaluation infrastructure**

- [`lib/evaluation-snapshot.ts`](../../lib/evaluation-snapshot.ts) provides `parseJsonLines`, `sha256`, and `hashSnapshotRow`, plus the manifest. The snapshot `items.jsonl` contains `title`, `summary`, `summary_origin`, `language`, `type`, and `source_id`, so **the experiment needs no database access**.
- [`lib/evaluation-agreement.ts`](../../lib/evaluation-agreement.ts) has the stratified sampling pattern with inclusion probabilities and weighted κ/precision/recall. The `seededShuffle` helper is private.
- [`lib/manual-judging.ts`](../../lib/manual-judging.ts) and [`scripts/judge-csv.mts`](../../scripts/judge-csv.mts) provide a resumable CSV judging CLI. They are hard-wired to the `persona_*` and `relevant` 0/1 columns.
- [`scripts/label-evaluation-items.mts`](../../scripts/label-evaluation-items.mts#L222) shows the patterns for an LLM-calling evaluation script: refuse to run in CI, read keys from the environment, and keep a resumable JSONL cache keyed by model and prompt version.
- Vitest unit tests use injected `fetch` fakes (see `lib/enrich/coordinator.test.ts` and `lib/embeddings.test.ts`).

## 3. TypeSafe Jev (verified from official docs)

Sources: `docs.typesafe.ai` (quick start, models, primitives, confidence, errors, model jaggedness, JS SDK reference) and the OpenAPI document at `https://api.typesafe.ai/openapi.json`. Several unofficial sites with similar names exist; they were not used.

- **What it is:** a non-generative "System One" model. You send a `state` (a string, JSON object, or array) and named `questions`, and get typed answers. It does not generate text.
- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>`. The request has `model`, `state`, and `questions`. The response has `model` (the resolved version), `answers`, and `usage {input_tokens, output_tokens}`.
- **Primitives:**
  - **Score:** ordered `criteria`, 1–10 levels. The answer has `score` (the probability-weighted level), `probabilities` per level, `legend`, and `confidence`.
  - **Choice:** up to 255 options. The answer has `choice`, `probabilities`, and `confidence`.
  - **Noul:** an optional `criteria {true, false}`. The answer is the probability `noul` and has no `confidence`.
  - Every question in a request is evaluated in parallel. Extra questions cost only tokens.
- **Confidence:** derived from the returned probabilities, not an independent correctness estimate. For a Score it is $\max(0, 1 - \sum_i p_i|i-m| / \text{MAD}_{\text{unif}})$. Docs recommend thresholds tuned on your own data. For a Noul, use $|2p-1|$.
- **Models and price:** `jev-1.14.0` (`jev-latest`, since 14 Oct 2026) and `jev-1.13.0`. Input costs **$0.042 per million tokens**; output tokens are free. Context is 64k tokens per request and 32k per question. The docs say to pin a versioned ID when thresholds are tuned, because aliases move.
- **Language:** "English is the primary training language … other languages … are handled but not equally well; test on your own content." **This is the main risk for Finnish.**
- **Known weaknesses (model jaggedness page):**
  - It reads instructions literally.
  - In a Choice question, it favours the first option.
  - Accuracy falls when the state contains irrelevant material.
  - Adversarial text in the state can move answers.
  - It is poor at counting and arithmetic, so length checks belong in code.
- **Errors:**
  - 400 (including `max_tokens_exceeded`), 401, 413, 415, and 422 (validation detail).
  - 429 (rate limit) and 529 (overloaded) should be retried with backoff.
  - Rate limits are per organization (tokens/s and requests/s) and shown only in the console.
- **JS SDK:** `@typesafe-ai/sdk` 0.7.0, requires Node ≥ 22.
  - Provides `new TypeSafeClient({ apiKey, defaultModel, timeout, retry, fetch })`, `client.systemOne({ state, questions })`, and the helpers `score()`, `choice()`, and `noul()`. Answer types are inferred.
  - Defaults: 10 s timeout per attempt with no total budget, 2 retries on 408/429/5xx, and `retry-after` support.
  - `logLevel: "debug"` logs request bodies.
  - Registry metadata for 0.7.0 shows only dev dependencies. Adding it is still a new dependency and requires approval.
- **Latency:** the official pages fetched did not state a latency figure. Third-party claims (about 70–500 ms) are unverified, so the experiment measures latency.
- **Data handling:** the docs say Jev is not trained on customer requests. Zero data retention is enterprise-only. The experiment sends only public feed titles and descriptions, with no user data.

**Integration (decided):** call the HTTP API with plain `fetch`, using the same pattern as `summarizeArticleText` and the embeddings client. This adds no dependency, gives direct control of retries (needed for clean latency measurement), and allows testing with an injected `fetch`. Validate responses against the OpenAPI shapes above. Pin `jev-1.14.0` and record the response `model`. The SDK is not used.

**Proposed request (one call per item):**

```jsonc
{
  "model": "jev-1.14.0",
  "state": {
    "title": "…",
    "description": "…",
    "language": "Finnish", // or "English"
    "content_type": "news article", // or "video"
  },
  "questions": {
    "usefulness": {
      "type": "score",
      "instructions": "How well does `description` tell a reader what this specific item (`title`) is about?",
      "criteria": [
        {
          "what": "Says nothing specific about this item",
          "examples": [
            "site slogan",
            "placeholder such as [...] or None",
            "only a call to click, subscribe, or take a quiz",
          ],
        },
        {
          "what": "Some information about the item, but vague, teaser-like, or incomplete",
          "examples": [
            "a question instead of a statement",
            "names the format but not the subject",
          ],
        },
        {
          "what": "States the specific subject or main point of the item",
          "examples": ["who did what", "what the article explains or reports"],
        },
      ],
    },
    "about_publisher": {
      "type": "noul",
      "instructions": "`description` describes the website, publisher, or section in general rather than this item.",
    },
    "promotional": {
      "type": "noul",
      "instructions": "`description` mainly tries to get the reader to click, buy, subscribe, or take part instead of saying what the item is about.",
    },
    "describes_page": {
      "type": "noul",
      "instructions": "`description` describes the web page's layout, navigation, or format instead of its subject.",
    },
  },
}
```

Instructions are written in English, the model's primary language. The state stays minimal, as the docs recommend: the source name, URL, and provenance are left out. The rubric gets a version string (for example `desc-quality-v1`). Only `usefulness` drives decisions. The Nouls are diagnostic, used for failure analysis.

## 4. Proposed experiment and scope

### In scope

- An offline command that reads a local evaluation snapshot. It does not access the database or production systems and needs no migrations.
- A stratified, seeded sample of about 180 real items: a 30-item dev set, a 150-item test set, and all video items as a descriptive census.
- Blind human labels, plus an intra-rater consistency check.
- Three classifiers on the same items:
  - **H0, current rules:** accepts every completed description.
  - **H1, experiment-only heuristics:** listed below.
  - **J, Jev:** described in §3.
  - **L, LLM judge:** `gpt-6-luna` with the same rubric, described below.
  - Plus the cascades **H1→J** and **H1→L**: H1 rejects first, and the model judges only what H1 accepts.
- Recording each model call's answers, probabilities or label, confidence (Jev only), resolved model, tokens, estimated cost, latency, status, retries, and errors.
- A reduced human audit of 30 test articles and 10 delayed repeats; no additional video or probe labels.
- A report with exploratory metrics, per-language and per-origin limitations, a policy simulation, and a disagreement table. The replacement probe is deferred.

### Out of scope

- Any change to ingestion, enrichment, embeddings, ranking, UI, or the database schema.
- Judging factual accuracy against the article. Labellers and Jev both see only the title and description, the same text the embedding uses.
- Generating replacement descriptions at scale. Only the task 8 probe generates them, without database writes.
- Fixing Yle's known site-wide metadata description. Spec 010 handles that case; this experiment tests the remaining description-quality problem.

### H1: experiment-only heuristics (proposed, code only)

Each rule returns a reason code. Any match means "reject".

1. `empty`: blank after trimming. This never reaches Jev, and the pipeline already treats it as missing.
2. `placeholder`: no letters at all (for example `[...]`, `…`), or a normalized value in a short list (`none`, `null`, `undefined`, `n/a`).
3. `repeated`: the same normalized text appears in at least 3 distinct items from the same source in the snapshot (site-wide boilerplate).
4. `equals_title`: the normalized description equals the title or is contained in it.
5. `too_short`: fewer than _w_ words. _w_ is chosen on the dev set and may be disabled if it causes false rejections.

"Missing" descriptions are handled deterministically and never sent to Jev. The snapshot contains only completed items, so missing cases appear in unit tests and in the routing counts, not in the labelled set.

Task 2 implementation normalizes text with Unicode NFC, trimming, whitespace collapse, and lowercasing; punctuation is preserved. Word count uses whitespace-separated tokens after normalization. The word limit defaults to disabled (`null`) until dev-set tuning. H1 reports matching reasons in rule order, with empty and placeholder cases handled first. Standalone J and L route only empty or placeholder descriptions to deterministic replacement; other H1 flags must remain eligible for standalone judging so the model comparison is not reduced to a cascade.

### L: LLM judge baseline (proposed)

`gpt-6-luna` is already used for summaries, so it is the simplest alternative to adding a new vendor.

- One Responses API request per item with plain `fetch`, `reasoning: { effort: "none" }`, no tools, `store: false`, and a strict JSON schema output `{ "quality": "good" | "weak" | "unusable" }`. Re-check the structured-output parameter shape in task 1.
- The prompt uses the same level descriptions and examples as Jev's `usefulness` question, and the same title, description, language, and content type as input. It treats the description as untrusted content, not instructions.
- L returns a label but no probabilities, so it has a fixed decision (`unusable` → replace) and no thresholds, AUC, or confidence bands.
- Cost is about 500 input tokens and 10 output tokens per item, roughly $0.00006 at the [design.md §2.5](../design.md#25-llm-usage-limited) rates. It reads `OPENAI_API_KEY` from the environment.

### Commands and files (proposed)

- `pnpm eval:description-quality sample|run|probe|report`. It runs with Node `--experimental-strip-types` and `--env-file-if-exists=.env.local` like the other evaluation scripts, refuses to run when `CI=true`, and reads `TYPESAFE_API_KEY` and `OPENAI_API_KEY` from the environment only. Logs never contain keys or request bodies.
- `lib/evaluation-description-quality.ts` (+ `.test.ts`): pure functions for H1, sampling, request building, response validation, decisions, and metrics.
- `lib/evaluation-description-judges.ts` (+ `.test.ts`): the shared rubric, pinned requests, validated responses, HTTP retry/timeout handling, and response-only cache runner. HTTP and cache code are kept separate from sampling and metrics; no production pipeline modules are changed.
- `scripts/description-quality.mts`: command-line wiring and file input/output.
- `evaluation/description-quality/`:
  - `sample.json` (committed): snapshot manifest hash, seed, strata sizes, item IDs, weights, and the SHA-256 of each item's title and description.
  - `items.jsonl`: a copy of the sampled items' fields needed by the experiment, so later snapshot exports or production fixes cannot change the inputs.
  - `labels-dev.csv`, `labels-audit.csv`, `labels-repeat.csv`: the required pilot human labels. Preserve the original `labels-test.csv` and `labels-videos.csv`; their remaining blank rows need not be labelled.
  - `audit.json` (committed): selected audit item IDs, original sample hash, source-label CSV hash, retained flags, and second-stage inclusion probabilities and weights; no text or human answers.
  - `config.json` (committed, frozen before the test run): rubric version, pinned models, thresholds, and H1 word limit.
  - `judge-cache.jsonl`: one row per Jev or LLM judge call, keyed by `[classifier, itemId, textHash, model, rubricVersion, run]`. Runs are resumable.
  - `results/report-<config hash>.{json,csv,md}`.
- Commit `sample.json`, `config.json`, finalized labels as `labels.jsonl` (item ID, label, and reason only), the response-only judge cache, and reports that refer to items by ID. Keep `items.jsonl`, the blind labeling CSVs, and full-text disagreement tables local and gitignored. Keep the exact snapshot files locally for reproduction; the committed hashes alone do not preserve the feed text.

## 5. Dataset and labelling

### 5.1 Source data

- Sample from the final, non-provisional snapshot created on 11 Nov 2026. It includes the spec 010 Yle fix and represents the current pipeline. This experiment reads the snapshot files only; it does not access the database or change spec 006 results.
- `sample` copies the sampled items into local, gitignored `evaluation/description-quality/items.jsonl` and freezes item IDs and text hashes in committed `sample.json`. Later snapshot exports cannot change the inputs: `run` fails on any hash mismatch. Keep the exact snapshot files locally for reproduction.

### 5.2 Sampling

Simple random sampling would find only about 5–10 poor descriptions in 150 items. The sample is therefore stratified, with known inclusion probabilities, following the [spec 006 agreement design](006-evaluation.md):

- **Strata:** language (`fi`, `en`) × origin (`feed`, `page_metadata`, `ai_generated`) × H1 result (flagged, not flagged), for articles. Videos are a separate census stratum.
- **Allocation:**
  - Each non-empty stratum gets `min(N_h, 8)` items. The rest of the 150 is allocated in proportion to `N_h`.
  - Inside a stratum, items are drawn by seeded shuffle.
  - Weight = `N_h / n_h`. Population estimates use these weights; sample counts are reported too.
- **Not-flagged strata stay large.** They are where H1 misses poor descriptions, and they get most of the proportional allocation.
- **Dev set:** 30 articles drawn first, disjoint from the test set. The approved seeded draw targets 15 H1-flagged and 15 H1-unflagged articles, redistributing when either group has insufficient eligible items. Reserve `min(N_h, 8)` articles in every original stratum for testing before selecting dev items. This enriches detectable failures but does not guarantee semantic failures such as teasers. Dev items have no reporting weights and are used only for rubric wording, thresholds, and _w_.
- **Test population:** `N_h` is the original snapshot stratum size, not the size after removing dev items. Test allocation uses those original sizes and is capped by the remaining capacity; weights are `N_h / n_h`. Within each stratum, seeded dev selection and test selection treat item IDs uniformly. Videos never enter dev or article test sampling: all are exported separately with weight 1.
- **Coverage report:** `sample` prints counts per source, language, origin, and stratum. The pilot reports actual human-labelled counts and marks per-language accuracy as insufficient evidence.

Task 3 command: `pnpm eval:description-quality sample` uses `evaluation/snapshot/`, writes to `evaluation/description-quality/`, and defaults to seed `9112026`. Optional `--snapshot <directory>`, `--output <directory>`, and `--seed <integer>` override those values; paths must stay in this worktree. It validates the final manifest and every snapshot item row hash, copies only experiment input fields, and refuses to overwrite existing sample files or labels. Blind CSVs contain shuffled opaque IDs, title, description, language, content type, and blank quality/reason columns. Human poor-item language coverage is checked after labelling, not inferred from H1 flags.

Real export completed on 12 Nov 2026 after the exact snapshot items file was supplied: 30 dev articles, 150 test articles, and 8 videos, with reporting weights representing all 3,283 snapshot items. The reserved rare-stratum coverage limited eligible flagged dev items to 4, so the approved redistribution produced 4 flagged and 26 unflagged dev articles. Frozen inputs, blank blind-label columns, and local-only text files were verified. Human labels remain pending.

Pilot audit: `pnpm eval:description-quality audit` preserves every started test
row (8 completed at approval), then fills 30 total slots by seeded draws from
remaining language × original H1-flag groups. Each nonempty remaining group
gets at least one slot; additional slots prioritize the less represented
language, then proportional group coverage. Selection uses only completion
status and pre-existing sampling strata, never human label values or model
outputs. Retained rows have conditional audit inclusion probability 1; newly
drawn rows have `n_group / N_remaining_group`. Multiply original test weights
by the inverse audit probability for exploratory two-stage estimates. These
conditional weights do not remove original-sample uncertainty or make the
small audit adequate for production claims. The command writes `audit.json`
and `labels-audit.csv`, refuses overwrites, and leaves original files unchanged.

### 5.3 Human labels

- **Blind:** the CSV shows only the shuffled title, description, language, and content type. It hides source, provenance, H1 flags, and Jev output. Labelling happens before any Jev run on that set.
- **`quality`:**
  - `good`: states the specific subject or main point.
  - `weak`: some item-specific information, but vague, teaser-like, or incomplete.
  - `unusable`: nothing specific about this item.
- **`reason`:** one of `none`, `boilerplate`, `placeholder`, `promotional`, `teaser`, `vague`, `page_structure`, `off_topic`, `other`.
- **Definitions** sit at the top of the CSV/README with real examples from §1. Ambiguous cases follow one rule: if a reader could not tell the topic from title and description together, the label is `unusable`.
- **Primary binary target:** `unusable` vs not (should the description be replaced?). Secondary: `good` vs not, and ordinal agreement on all three levels.
- **Intra-rater check:** at least one day after completing the 30-item audit, relabel 10 audit items selected by seeded shuffle in a new order. Report raw agreement and binary Cohen's κ (undefined if the marginals are constant); with only 10 repeats this is descriptive, not a reliability certification. Low agreement or κ below 0.7 is a limitation and a reason to revise the rubric before a larger study, not a request for more pilot labels. Labels are never adjusted to match a classifier.

Repeat preparation uses `pnpm eval:description-quality repeat --completed-at <timestamp> --audit-hash <sha256>`. It checks the completed audit hash, validates all 30 labelled input rows against the audit design, enforces the 24-hour delay, and draws 10 items with seed `9112026` by default. `labels-repeat.csv` contains blank answers; `repeat.json` records selection IDs, seed, source hashes, and timestamps, not previous answers. Both files are overwrite-protected. The completed audit was verified on 16 Nov 2026 at 08:06:36.734 Finnish time with SHA-256 `2008148f8fdeb325bbe2b215ced95dce6e88f3c06411513ac070b8ad6d7aee64`.
- **Tool:** generalize `lib/manual-judging.ts` to accept a column/answer configuration, keeping the existing relevance judging behaviour and tests. Alternatively, edit the CSV by hand.

Task 4 setup uses `pnpm eval:judge --description-quality <file.csv>`. The shared CSV helper accepts display-column and allowed-answer configuration; existing relevance judging retains its original command and behaviour. Description judging shows one blind item at a time, accepts numbered or exact-label answers for quality and reason, saves each cell immediately, and resumes partial rows. It preserves all other CSV bytes and checks for external edits before saving. The [labelling guide](../../evaluation/description-quality/README.md) contains the rubric, reason definitions, terminal instructions, and the delayed 10-item repeat procedure. All 30 dev labels, 30 audit labels, and 10 delayed repeat labels are complete.

Task 4 consistency result (17 Nov 2026): binary replacement agreement is 9/10
(90%), exact quality agreement is 8/10 (80%), and reason agreement is 7/10
(70%). Binary Cohen's κ is 0: the original repeat subset had zero `unusable`
labels and the repeat had one, so expected and observed agreement both equal
0.9. This small, class-imbalanced check does not establish label reliability;
carry the limitation into the report rather than treating raw agreement as a
pass or requesting more labels. Original audit labels remain unchanged.
Hashes and descriptive results are recorded in
[`repeat-consistency.json`](../../evaluation/description-quality/repeat-consistency.json).
Task 5 (judge clients) is next; no model judgments have been run.

### 5.4 Avoiding biased or misleading conclusions

- Human audit selection and labels are frozen (CSV and design hashes in the report) before model test outputs are viewed. Do not infer labels for the other 120 items from model agreement.
- Rubric, thresholds, the L prompt, and _w_ are fixed on the dev set and frozen in `config.json` before the single test run. A changed config gets a new hash and is reported as a separate run, not as an overwrite.
- Model versions are pinned and the resolved models are recorded.
- L judges `ai_generated` descriptions written by the same model, so its results are also reported with that origin excluded.
- Results are reported per language, because the docs warn about non-English accuracy. A pooled result must not hide a Finnish failure.
- Population estimates use inclusion weights. Unweighted sample numbers come with 95% Wilson intervals. With small cells, the report says "insufficient evidence" instead of pass or fail.
- The Jev vs H1 comparison is paired, on the same items. Report discordant counts (Jev right/H1 wrong vs the reverse), not just two accuracies.
- Choice option-order bias does not apply, since a Score is used. Stability is checked by rerunning all test calls once.
- H1-flagged items are capped through stratification, so one easy pattern cannot inflate accuracy. The report also shows results with H1-flagged items excluded, which is Jev's marginal value.

## 6. Metrics and success criteria

### 6.1 Decisions

- Jev's `p0` = `probabilities["0"]` of `usefulness`.
- **Replace** if `p0 ≥ τ`; **uncertain** if `confidence < c_min`; otherwise **keep**.
- `τ` and `c_min` are chosen on the dev set. `uncertain` counts as keep in the binary metrics (fail-open to current behaviour), and coverage is reported.

### 6.2 Metrics (test set)

- **Classification (human audit only):** for H0, H1, J, L, H1→J, and H1→L (weighted and unweighted, overall, `fi`, `en`, and per origin): precision, recall, and F1 for `unusable`; **false replacement rate** (share of human-`good` items replaced); binary Cohen's κ. J and L are also compared pairwise with discordant counts. Report denominators, Wilson intervals for unweighted proportions, and insufficient evidence for small or undefined cells. Do not score unlabelled model-test items as correct or incorrect.
- **Ordinal and confidence:** Spearman correlation between Jev `score` and the 3-level label; ROC-AUC of `p0`; accuracy by confidence band; coverage at `c_min`.
- **Diagnostics:** each Noul against the human `reason`, descriptive only.
- **Stability:** share of identical decisions across the two test runs for J and L, and the mean absolute difference in `p0` for J.
- **Operations (J and L):**
  - p50/p95 latency of the first attempt, measured sequentially;
  - error rate by status;
  - retries;
  - input and output tokens per item;
  - cost from the prices recorded in `config.json` (Jev $0.042/M input; `gpt-6-luna` $0.10/M input and $0.50/M output).
- **Replacement probe:** deferred in the reduced pilot; no additional human pair labels are required.
- **Policy simulation (RQ3)**, weighted to the snapshot. For each policy, report LLM generation calls per 1,000 items, poor descriptions replaced, and good descriptions wrongly replaced:
  - P0: current (generate only when missing);
  - P1: H1 flags → generate;
  - P2: J replace → generate (and P2-L for L);
  - P3: H1→J → generate (and P3-L for H1→L);
  - P4: always generate.

  It also projects cost using the [design.md §2.5](../design.md#25-llm-usage-limited) summary estimate (about 6,000 input + 200 output tokens per `gpt-6-luna` call) and about 5,400 new items per month (about 180 per day in the snapshot). Call counts and costs may use the full model sample; poor/good replacement estimates use only the human audit and its weights. These are hypothetical routing estimates, not measured replacement improvements.

### 6.3 Original validation targets (not certification gates for the reduced pilot)

The original targets below remain reference values for a future larger study.
In this pilot S0 is descriptive, S1–S3 and S6 cannot certify production
readiness, and S7 is not measured. S4–S5 can still be measured on the full model
sample. Do not lower thresholds or treat missing evidence as a pass.

| ID  | Criterion                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0  | Labels are reliable: intra-rater binary κ ≥ 0.7.                                                                                                                                                        |
| S1  | Jev is accurate: for `unusable`, precision ≥ 0.80 and recall ≥ 0.80; false replacement rate ≤ 5%.                                                                                                       |
| S2  | Language holds: S1 holds separately for `fi` and `en`, each with ≥ 15 labelled `unusable` items. Otherwise the result is "insufficient evidence" for that language.                                     |
| S3  | A model adds value: H1→J (or H1→L for L) recovers ≥ 25% of the `unusable` items H1 misses, without raising the false replacement rate above 5%. If H1 alone meets S1, a production gate needs no model. |
| S4  | Jev is stable: ≥ 98% identical decisions across reruns.                                                                                                                                                 |
| S5  | Operations are acceptable: error rate ≤ 2% after retries; p95 latency ≤ 2 s; projected cost ≤ $1 per month.                                                                                             |
| S6  | Jev beats the in-stack alternative: L does not meet S1–S2 where Jev does, or Jev is at least as accurate with lower cost or latency.                                                                    |
| S7  | Replacing helps: in the probe, a replacement is produced for at least half of the items and is judged `better` for at least 80% of those.                                                               |

**Pilot outcome:** recommend a larger validation study for Jev, L, or
deterministic rules, or recommend not pursuing the idea now. State uncertainty,
single-annotator limitations, and the absence of replacement-benefit evidence.
No pilot outcome approves a production gate.

Cost alone does not decide. At about 1,000 input tokens per item, Jev costs about $0.00004 per item, against about $0.0007 per `gpt-6-luna` summary. Both are small at Poimio's volume.

## 7. Acceptance criteria

1. Unit tests cover H1 (each rule, including Finnish text and the real §1 patterns) and the deterministic routing (empty, whitespace-only, and placeholder inputs never produce a Jev request).
2. Unit tests cover sampling: identical output for the same seed and snapshot; disjoint dev and test sets; correct strata sizes and weights; and failure on a snapshot hash or text-hash mismatch.
3. Unit tests with an injected `fetch` cover the Jev client:
   - the request body matches §3;
   - valid Score and Noul answers are parsed;
   - 422 and malformed bodies are rejected;
   - 429/529 are retried with `retry-after` and bounded backoff;
   - timeouts are enforced;
   - errors are recorded without request bodies or the key;
   - cached rows are skipped on rerun;
   - the command refuses to run when `CI=true`.

   The same applies to the LLM judge client: the request uses a strict JSON schema with no tools and `store: false`, and invalid or missing labels are recorded as errors.

4. Unit tests check metrics (weighted precision, recall, κ, false replacement rate, Wilson interval, and policy-simulation counts) against a hand-computed example.
5. `sample` writes `sample.json` and blind CSVs with no source, provenance, H1, or Jev columns.
6. `config.json` is committed before the test run. The report records its hash, the label CSV hash, the snapshot manifest hash, the git commit, the resolved model, and the rubric version.
7. The report includes the §6.2 pilot metrics with per-language limitations, exploratory policy simulation, operations, model agreement across all 150 articles, and a disagreement table. Human-label disagreements are restricted to the 30-item audit; unlabelled model disagreements are clearly marked as such. Include title, truncated description, available human label and reason, H1 reason, Jev `p0`/`score`/`confidence`/Nouls, and status; sort confident Jev errors on labelled items first. No additional human adjudication queue is required.
8. `git diff` shows no changes under `supabase/migrations/`, in `lib/ingest.ts`, `lib/enrich/`, `lib/embeddings.ts`, `lib/normalize/`, or `app/`.
9. Deferred with task 8 in this pilot. A future probe must make no database writes and fetch pages only through `fetchPageHtml`; test metadata rejection and per-item failures before running it.
10. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.

## 8. Tasks

- [x] 1. Resolve the remaining open questions. Add `TYPESAFE_API_KEY` to `.env.local`. Re-check the Jev request/response shapes against `openapi.json` and the current model list, and the Responses API structured-output parameters for L. Record the pinned models and prices under Decisions.
- [x] 2. Implement H1 and deterministic routing in `lib/evaluation-description-quality.ts`, reusing `parseJsonLines` and `sha256`. Add unit tests (criterion 1).
- [x] 3. Implement stratified sampling and blind CSV export. Export `seededShuffle` from `lib/evaluation-agreement.ts` instead of copying it. Add unit tests (criteria 2 and 5).
- [x] 4. Set up the labelling tool and reduced audit. Preserve the completed 30 dev labels and 8 test labels; finish only 22 additional test labels in `labels-audit.csv`. Prepare and complete 10 delayed repeat labels (descriptive S0). No video labelling is required.
- [x] 5. Implement the Jev and LLM judge HTTP clients, cache, and `run` subcommand. Add unit tests with an injected `fetch` (criterion 3).
- [ ] 6. Run on the dev set only. Adjust rubric wording, the L prompt, `τ`, `c_min`, and _w_. Commit the frozen `config.json` (criterion 6).
- [ ] 7. Run once on the test set, plus the stability rerun. Implement metrics and the report, with unit tests (criteria 4 and 7). Check criterion 8.
- [ ] 8. **Deferred by the approved reduced-effort pilot:** replacement probe (`probe` subcommand) for at most 30 test items labelled `unusable`, without database writes:
  - fetch the page with `fetchPageHtml` and run `extractPageContent`;
  - if the metadata description passes H1 and J, use it as the replacement;
  - otherwise extract article text with the same Readability and `htmlToText` steps as `extractPageContent`, implemented in the experiment code without changing `lib/enrich/`, and summarize it with `summarizeArticleText`;
  - the human labels each pair (original and replacement in random A/B order) as `better`, `same`, or `worse`, plus the replacement's quality label (criterion 9).
- [ ] 9. Check criterion 10.
- [ ] 10. Record findings and the recommendation in this spec. Add an AI-log entry after the user confirms the model.

## 9. Risks and assumptions

Task 5 implementation (17 Nov 2026): `run --set dev` supports `--classifier
both|jev|llm` (default `both`) and `--run <positive integer>` (default 1).
Only dev runs are enabled; test/video model runs remain blocked until the
configuration is frozen in task 6 and the guarded test path is implemented in
task 7. No live judge calls were made during task 5.

Both clients use the same three rubric levels (`desc-quality-v1`), pinned
models, and minimal input state. Empty/placeholder descriptions get a
deterministic replacement record without a request; other H1 flags do not
bypass standalone model judging. Requests are sequential, with at most three
15-second attempts and two waits of at most 10 seconds (65 seconds per call).
408, 429, 5xx including 529, network failures, and timeouts are retryable.
`Retry-After` seconds and HTTP dates are honoured; a wait over 10 seconds ends
the call as an error instead of retrying early. Non-retryable HTTP errors and
malformed responses are recorded per item. Responses are limited to 64 KB,
and deadlines cover both headers and response bodies.

The runner validates snapshot and frozen input hashes/metadata and requires
complete, unmodified dev-label inputs before calling a service. API keys are
read only from the environment, and required keys are checked before any call.
Each cache row stores the validated judgment or deterministic/error status,
requested and resolved model (on success), rubric version, text hash, run
number, timestamp, per-attempt status/latency, retries, and successful-response
token counts/cost estimate. Jev legend data is reconstructed from the rubric,
not copied from arbitrary response text. Errors contain only fixed categories
and HTTP status codes, never raw bodies, exception messages, or keys. Failed
attempt token usage is unknown and is not included in the cost estimate;
deterministic routes consume no model tokens.

Cache rows use the §4 identity key and are appended after every item. Matching
rows, including errors, are skipped on resume; cached errors still cause a
nonzero command exit. Use a new run number for a deliberate new measurement,
including the later stability rerun; never overwrite earlier results.
Changes to the rubric or prompt require a new rubric version. Malformed/duplicate cache
rows and missing final newlines stop the command. An exclusive
`.judge-cache.lock` records the process ID and start time to prevent concurrent
cache writes; normal completion releases it. After abrupt termination, check
that recorded process before removing only the stale lock file. Input text,
human answers, credentials, and raw response bodies are never written to the
response cache.

| Risk or assumption                                                                    | Mitigation                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finnish accuracy is lower (documented by TypeSafe).                                   | Separate per-language criterion (S2). Finnish items get their own strata.                                                                         |
| Single annotator; "useful" is subjective.                                             | Written definitions with examples, blind labelling, intra-rater κ (S0). Results are reported as one annotator's standard.                         |
| Few positives, and Yle and Hacker News dominate.                                      | Stratified oversampling with weights. Per-source counts are reported. No claims about videos (about 3 in the snapshot).                           |
| Rubric overfits the dev set.                                                          | The test set is used once with a frozen config. A changed config is a new, separately reported run.                                               |
| Model alias drift or Jev release changes.                                             | Pin `jev-1.14.0` and record the resolved `model`.                                                                                                 |
| Adversarial or self-promoting text steers Jev.                                        | Only `promotional`-type text is in the data. In production, Jev's effect is bounded to "replace description", and deterministic rules stay first. |
| Young vendor (Jev launched Sept 2026; SDK is 0.x); price, limits, and API may change. | Raw HTTP behind a small adapter. Re-verify before any production spec.                                                                            |
| Public feed text goes to a third party.                                               | Only titles and descriptions, with no user data. Note the data-handling policy in the report.                                                     |
| The snapshot excludes unresolved items.                                               | Missing descriptions are covered by deterministic routing, not by Jev.                                                                            |
| No article text, so AI-summary faithfulness is not assessed.                          | Stated as a limitation; the task 8 probe covers part of it.                                                                                       |
| L judges summaries written by the same model (self-preference).                       | Report L with `ai_generated` items excluded.                                                                                                      |
| The probe fetches real pages (paywalls, timeouts, blocked fetches).                   | Uses the SSRF-safe `fetchPageHtml`; failures are counted as "no replacement", which is itself a result for RQ3.                                   |
| Time is not in the course plan.                                                       | Side experiment while spec 006 waits for data; estimates are rough.                                                                               |

## 10. Future production integration (not implemented)

A production gate needs its own spec. It would change a spec 005 decision (feed descriptions are never replaced) and would almost certainly need a migration. Considerations:

- **Order of checks:**
  1. Run deterministic rules first. Rules such as `repeated`, `placeholder`, and `equals_title` need no model.
  2. Call Jev only for descriptions that pass them.
  3. Apply the quality gate to page-metadata candidates in `extractPageContent`. Spec 010 already rejects the known Yle site-wide description; the gate would cover other poor metadata descriptions.
- **Decision path:**
  - keep the description;
  - if Jev says replace, try page metadata through the same gate;
  - then generate an AI summary within the existing 20-requests-per-run budget;
  - if all fail, keep the original. Today's behaviour is the floor, so replacement never makes an item disappear.
- **Low confidence:** keep the description and record it for review. Never replace on an uncertain answer.
- **Fewer calls:**
  - only new or changed descriptions;
  - only after the deterministic rules;
  - one request per item with all questions;
  - a per-run cap on Jev calls;
  - nothing for `ai_generated` text until the experiment shows value there.
- **Caching and re-evaluation:**
  - Store the verdict, `p0`, model ID, rubric version, and checked time per item (needs a migration). Key the cache on a hash of title and description.
  - Re-evaluate only through a backfill-style command when the model or rubric version changes, with `--dry-run` and `--limit` as in `enrich:backfill`.
- **Failures:**
  - Fail open: on timeout, 429/529 after bounded retries, 5xx, or a validation error, keep the description, mark it unchecked, and continue. Ingestion and embedding must never block on Jev.
  - Use a short per-request timeout, a per-run time budget, and stop calling Jev for the rest of a run after N consecutive failures.
- **Provenance:** keep `feed`, `page_metadata`, and `ai_generated` as they are. A replacement takes the provenance of its new source. Store the gate verdict separately, and possibly a hash of the rejected text, so the "AI summary" label and existing constraints are unchanged.
- **Embeddings and evaluation:** a replaced description changes the embedding (re-embed as spec 005 does). Do not enable a gate while a [spec 006](006-evaluation.md) snapshot or frozen test window is in use, or label the change as a new experiment.
- **Security:** the TypeSafe key stays server-side (GitHub Actions secret and `.env*`, never `NEXT_PUBLIC_`). Do not log request bodies (avoid SDK `debug`). Treat descriptions as untrusted input.

## Decisions

- This is an optional side experiment alongside spec 006. Estimates are rough, and `009` is its number.
- Jev is called with plain `fetch`; `@typesafe-ai/sdk` is not added.
- `gpt-6-luna` as an LLM judge (L) is included as a baseline.
- The replacement probe (task 8) is included.
- The user provides a TypeSafe API key; rate limits are expected to be sufficient for about 400 sequential requests.
- On 16 Nov 2026 the user approved the reduced-effort pilot: 22 more human test labels (30 total including 8 existing), 10 delayed repeats, AI comparison over all 150 original model-test articles, no production-readiness claim, and no additional human labelling queue. Keep the existing consolidated AI-log entry unchanged until the spec is finished, as previously requested.
- The known Yle site-wide metadata description was fixed in [spec 010](010-site-wide-metadata-descriptions.md). This experiment samples the final post-fix snapshot and does not evaluate that already-resolved case as part of its labelled sample.
- Task 1 verification (12 Nov 2026): `TYPESAFE_API_KEY` and `OPENAI_API_KEY` are already configured in this worktree's `.env.local`; no credential changes were needed. The authenticated [`GET /v1/models`](https://api.typesafe.ai/openapi.json) returned `jev-latest` and `jev-preview`. The [current model documentation](https://docs.typesafe.ai/models) confirms that versioned IDs are accepted even when absent from that list. Pin `jev-1.14.0`, at $0.042/M input tokens with free output tokens, and record the resolved response model.
- The current [Jev OpenAPI contract](https://api.typesafe.ai/openapi.json) accepts the proposed request in §3: Score criteria are an ordered array of 1–10 strings, objects, or arrays, with levels starting at zero. Score answers require `type`, `score`, `confidence`, `legend`, and `probabilities`; Noul answers require `type` and `noul`. The response requires `model`, `answers`, and integer `usage.input_tokens` / `usage.output_tokens`. Validation errors may echo rejected input, so the experiment must not log raw error bodies.
- Task 3 sampling decisions were approved on 12 Nov 2026: use the seeded 15/15 dev split with redistribution, reserve minimum test coverage in every original stratum, and use full-snapshot rather than residual-population weights. Keep videos in a separate descriptive census.
- Pin L to `gpt-6-luna`, the only snapshot listed in its [current model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna), at $0.10/M input and $0.50/M output tokens. It supports Structured Outputs and `reasoning: { effort: "none" }`. The [Responses API structured-output format](https://developers.openai.com/api/docs/guides/structured-outputs) is `text: { format: { type: "json_schema", name: "description_quality", strict: true, schema: { type: "object", properties: { quality: { type: "string", enum: ["good", "weak", "unusable"] } }, required: ["quality"], additionalProperties: false } } }`. Use `store: false` and no tools; treat refusals, incomplete responses, and missing or invalid labels as errors.

## Open questions

- None.
