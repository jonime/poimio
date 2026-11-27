# Technical Design

Companion to [plan.md](plan.md). Describes _how_ the application works; the plan describes _what_ is delivered and _when_.

## 1. Content sources and representation

The full catalog of candidate feeds is in [feeds.md](feeds.md) (all verified on 27 Oct 2026 except Reddit, which returns HTTP 429). The initial active set is chosen for topic diversity, Finnish + English coverage, and usable descriptions:

| Topic                     | Sources                                                                      | Language |
| ------------------------- | ---------------------------------------------------------------------------- | -------- |
| Finnish news              | Yle Latest, Yle Technology and Economy, Yle Science, Yle Culture, Yle Sports | fi       |
| Finnish news in English   | Yle News in English                                                          | en       |
| World news                | BBC World                                                                    | en       |
| Technology and AI         | Ars Technica, The Verge, TechCrunch, Hacker News                             | en       |
| Security                  | BleepingComputer                                                             | en       |
| Science and space         | New Scientist, NASA News Releases                                            | en       |
| Videos (cars, technology) | Engineering Explained, carwow, Technology Connections (YouTube)              | en       |

Not used initially:

- **Subsets or aggregators that duplicate other feeds:** Yle Main Headlines and Most Read, TechCrunch AI, Techmeme.
- **Paywalled, tabloid, or very high volume:** Helsingin Sanomat, Ilta-Sanomat, Iltalehti, Phys.org, ScienceDaily.
- **Regional or niche:** regional newspapers, SAK, AWS Blog, Finland Today.
- **No usable text:** Nature (empty descriptions), xkcd (image only).
- **Blocked:** Reddit (HTTP 429; requires its API).

The rest of the catalog is stored as inactive sources and can be activated later. Source discovery evaluates these catalog sources before using web search, which is cheaper and safer.

Notes:

- Hacker News items have only a title; Yle items sometimes lack a description. YouTube descriptions contain a lot of boilerplate that is removed before embedding.
- Known site-wide page metadata descriptions, including Yle's "Uutiset nopeasti ja luotettavasti.", are treated as unavailable; readable article text is summarized instead, and existing matches are requeued by the enrichment backfill.
- Yle News in English and Finnish Yle feeds often cover the same events, which gives natural test pairs for the week 1 cross-lingual embedding check.
- Feed windows are small (e.g. Yle Latest shows only the 20 newest items, all within a few hours), so ingestion runs **hourly** to avoid missing items.
- The same Yle article can appear in several Yle feeds; it is stored once (unique normalized URL).
- Volume is uneven (Yle publishes far more than the others), so the cold-start feed and exploration slots balance by source.
- URLs are normalized by removing tracking parameters (e.g. `?origin=rss`, `?at_medium=RSS&at_campaign=rss`) and deduplicated on the normalized URL. The same story from several sources (e.g. Verge + TechCrunch + Hacker News) is handled by embedding-based same-story filtering and per-page grouping in `get_feed` ([§2.2](#22-final-ranking-and-exploration), [spec 025](specs/025-same-story.md)), not ingestion-time deduplication.
- Feed category tags (Yle, Verge, TechCrunch) are stored for diversity measurement and evaluation, not used for ranking.
- Only title, short description, thumbnail, and link are shown; Yle and BBC RSS terms of use are reviewed in week 1.

Representation:

- Each item has a type: _article_ or _video_. Videos come from YouTube channel feeds; only metadata is used (no transcripts). Boilerplate in video descriptions (links, sponsor and subscribe text) is removed before embedding.
- Every item shown to users must have a completed, non-empty summary. Its provenance is `feed`, `page_metadata`, or `ai_generated`; unresolved items remain stored but are hidden.
- Embeddings use exactly `title + "\n\n" + summary`, and are created only after the summary is complete. Enrichment updates the summary and clears any stale vector/model in the same database update. Unresolved items cannot retain embeddings and therefore cannot be candidates or ranking signals.
- The embedding model must be **multilingual (Finnish + English)** so that interests transfer across languages.
- The embedding model name is stored with each vector, so embeddings can be regenerated if the model changes.
- **Language bias:** with `text-embedding-3-small`, texts in the same language are similar just because of the language (random-pair cosine: Finnish–Finnish 0.232, English–English 0.148, Finnish–English 0.077 on 306 items). This favors same-language matches and hurts both nearest-liked scoring and cross-lingual recommendations.
- **Language centering (decided):** subtract the language's mean embedding before comparing. In a first test, random-pair similarity dropped to about 0 for all language pairs and neighbours of a Finnish energy article became topical (including English ones). In the gate 1 re-run ([spec 001](specs/001-ingestion.md), task 13), nearest-liked on centered vectors reached precision@10 1.00 (raw 0.65, centered average-vector 0.95, newest-first 0.30), so ranking uses centered vectors. Means are computed from the corpus and frozen per embedding model ([spec 003](specs/003-feed-ui.md)).

## 2. Recommendation

The core recommender is embedding-based. An LLM is used only for tasks that embeddings cannot handle well.

### 2.1 Interest scoring: nearest liked item

A candidate item is scored by its similarity to the _closest_ item the user has reacted to, not to an averaged profile:

$$
\text{interest}(c) = \max_{p \in P} w_p \cdot \text{sim}(c, p) \;-\; \lambda \cdot \max_{n \in N} \text{sim}(c, n)
$$

- $P$ = positive interactions. Likes and `more` preferences have weight 1.0; opens have weight 0.3 because they are a weak signal.
- $N$ = items marked _Not interested_. $\lambda$ controls the strength of the penalty.
- Skipped or ignored items are not used as negative feedback.
- Items marked _Seen_ are hidden from the feed but are neutral: they are neither positive nor negative signals ([§7](#7-user-interaction)).
- Signal precedence per item: explicit feedback overrides clicks. If an item is liked or marked _Not interested_, only that signal counts (the latest explicit action wins). Clicks count only for items without explicit feedback.
- Click weight 0.3 is an untuned product assumption, not an evaluation result. The frozen replay has no click behavior and is not rerun.

The implementation uses explicit likes, `more` preferences, and the 200 most recent eligible opens without explicit feedback as positive signals. Each explicit-feedback set contains at most the 200 most recently updated eligible items of the caller; likes and preferences have weight 1, clicks have weight 0.3, and the dislike penalty is $\lambda = 0.5$. Similarity uses language-centered embeddings of `text-embedding-3-small@512` only. An eligible item has an embedding and a matching `(embedding_model, language)` mean row. Zero-length centered vectors have similarity 0. A nonpositive click similarity contributes nothing. Newly embedded items use the existing frozen mean immediately; recomputing the means is not required for each ingestion run.

Saved preferences (spec 021) join those same signal sets. A `more` preference is one positive signal and a `less` preference is one negative signal, with the same $\lambda$ and no extra weight. A preference with both language vectors still counts once: its similarity is the better of the two centered vectors. `less` is a soft penalty, not a filter, so a strongly matching item can still appear. Whether a one-sentence description embeds close enough to articles to steer the feed was a hypothesis; check 1 tested that effect ([§2.6](#26-natural-language-preferences)).

Why this approach:

- Handles multiple unrelated interests (an averaged profile of "Linux + astronomy" matches neither well).
- Works with very little feedback (a handful of likes).
- Explainable: the closest liked item is the reason for the recommendation.

#### Tuned default (spec 020)

The production default is now `blend` with $\alpha = 0.5$: the interest score is $\alpha \cdot \text{nearest-liked} + (1 - \alpha) \cdot \text{average-vector similarity}$, with language-centered vectors, $\lambda = 0.5$, and recency weight $\beta = 0$. `nearest_liked`, `average_vector`, and `top_m_mean` remain available in the private scorer. The private scorer, the public `rank_items` wrapper, and `get_feed` all use this default (migration `20261120000000`). `because_item_id` is the highest-value positive signal, with ties preferring likes, then preferences, then clicks, then the smaller ID. This is where the data contradicts gate 1: nearest-liked alone was the gate-1 choice, but on the multi-interest personas it covers both interests better than the average vector and ranks worse than either blend or average vector, so a blend beats both.

Method: validation window only, 4 single personas and their 6 pairs as composites, 10 seeds, $k \in \{3, 5, 10, 20\}$, equal persona weights. The objective is mean precision at $k$. Selection used the committed rule in `evaluation/tuning-rule.json` (hash `083b2217…`): balanced coverage within 0.05 of the best configuration, cross-lingual precision constraints, then the simplest configuration within 0.01 of the best objective (fewer parameters; `blend` after simpler methods). Raw results: `evaluation/results/tuning-2026-11-19t07-44-10.395z.json`.

Stage 1 (centered / raw vectors, $\lambda = 0.5$, $\beta = 0.1$; coverage = balanced coverage):

| Method                     | Vectors  | Objective | Coverage | EN→FI | FI→EN | Eligible |
| -------------------------- | -------- | --------- | -------- | ----- | ----- | -------- |
| `nearest_liked` (baseline) | centered | 0.7522    | 0.625    | 0.299 | 0.661 | no       |
| `nearest_liked`            | raw      | 0.7665    | 0.567    | 0.299 | 0.655 | no       |
| `average_vector`           | centered | 0.8303    | 0.496    | 0.323 | 0.700 | no       |
| `average_vector`           | raw      | 0.8273    | 0.308    | 0.347 | 0.536 | no       |
| `top_m_mean`, $m = 2$      | centered | 0.7807    | 0.604    | 0.316 | 0.664 | no       |
| `top_m_mean`, $m = 2$      | raw      | 0.7990    | 0.500    | 0.316 | 0.643 | no       |
| `top_m_mean`, $m = 3$      | centered | 0.7737    | 0.613    | 0.306 | 0.644 | no       |
| `top_m_mean`, $m = 3$      | raw      | 0.7923    | 0.450    | 0.310 | 0.611 | no       |
| `top_m_mean`, $m = 5$      | centered | 0.7552    | 0.542    | 0.291 | 0.616 | no       |
| `top_m_mean`, $m = 5$      | raw      | 0.7845    | 0.388    | 0.294 | 0.568 | no       |
| `blend`, $\alpha = 0.25$   | centered | 0.8195    | 0.567    | 0.322 | 0.704 | no       |
| `blend`, $\alpha = 0.25$   | raw      | 0.8262    | 0.367    | 0.343 | 0.597 | no       |
| `blend`, $\alpha = 0.5$    | centered | 0.8038    | 0.638    | 0.320 | 0.711 | yes      |
| `blend`, $\alpha = 0.5$    | raw      | 0.8123    | 0.508    | 0.337 | 0.641 | no       |
| `blend`, $\alpha = 0.75$   | centered | 0.7815    | 0.688    | 0.311 | 0.691 | yes      |
| `blend`, $\alpha = 0.75$   | raw      | 0.7957    | 0.550    | 0.321 | 0.658 | no       |

Stage 2 grid (centered; $\alpha \in \{0.5, 0.75\}$, $\lambda \in \{0, 0.25, 0.5, 1\}$, $\beta \in \{0, 0.05, 0.1, 0.2\}$; 32 configurations). Best objective per $\alpha$ and the winner:

| Configuration                                  | Objective | Coverage | EN→FI | FI→EN | Note                      |
| ---------------------------------------------- | --------- | -------- | ----- | ----- | ------------------------- |
| $\alpha = 0.5$, $\lambda = 0$, $\beta = 0$     | 0.8345    | 0.646    | 0.365 | 0.760 | best objective            |
| $\alpha = 0.5$, $\lambda = 0.25$, $\beta = 0$  | 0.8320    | 0.663    | 0.368 | 0.760 | within 0.01 band          |
| $\alpha = 0.5$, $\lambda = 0.5$, $\beta = 0$   | 0.8253    | 0.650    | 0.358 | 0.732 | **winner** (within band)  |
| $\alpha = 0.5$, $\lambda = 0.5$, $\beta = 0.1$ | 0.8038    | 0.638    | 0.320 | 0.711 | stage-1 reference         |
| $\alpha = 0.75$, $\lambda = 0.5$, $\beta = 0$  | 0.8027    | 0.671    | 0.352 | 0.712 | best $\alpha = 0.75$ rows |

The winner improves the baseline's objective from 0.7522 to 0.8253 and balanced coverage from 0.625 to 0.650. The tie-break rule kept $\lambda = 0.5$ (the existing penalty) over $\lambda = 0$ and $0.25$, which scored within the 0.01 band. Recency weight 0 won every comparison: any positive $\beta$ lowered the objective, and $\beta = 0.2$ lowered it by about 0.07. The labels do not reward newness within the candidate window. Every raw-vector configuration failed the coverage constraint, even where its objective was higher, so the §1 default (centered) is unchanged.

Limitations: the validation window was used for selection, so these numbers are optimistic. The held-out test-window run is recorded in [§4.5](#45-held-out-test-run). Labels are LLM proxies (local Qwen), not real feedback. The 4 single and 6 composite personas share items and labels, so their results are correlated and the 10 seeds are not independent evidence. Differences of about 0.01 in the objective should not be treated as real.

### 2.2 Final ranking and exploration

- The final score is interest plus $\beta \cdot 0.5^{\text{age}/h}$. The prototype used $\beta = 0.1$; the tuned default is $\beta = 0$ ([§2.1](#21-interest-scoring-nearest-liked-item)), so the age term is a no-op unless a caller passes a weight. The half-life $h$ is 24 hours for articles and 7 days for videos. Candidate windows are 7 days for articles and 30 days for videos; all rated and opened items are excluded.
- `get_feed` is `STABLE` and runs as `SECURITY INVOKER`, reads identity from `auth.uid()`, and is executable by authenticated users only. One snapshot covers candidates, references, signals, and explanations. Pages contain 30 items; later pages exclude already shown IDs instead of using offsets. The limit is clamped to 1-100 and exclusions to 1,000 IDs.
- Before ranking, `get_feed` removes items from the caller's `hidden_sources` set and drops eligible candidates whose centered similarity to any of the caller's latest 300 eligible rated or opened items (published within 30 days) is at least $0.74$ regardless of language (covered-story filter, [spec 025](specs/025-same-story.md)). Rated and opened rows are merged by item ID and use the later event time before ordering. Likes and dislikes from hidden sources still contribute as topic signals and story-filter references. With 200 click signals, the local warm median across 10 calls was 277.7 ms.
- After ranking, `get_feed` walks the returned page in rank order and marks near-duplicates (`duplicate_of`) against earlier non-exploration, eligible representatives (same language $\ge 0.74$; Finnish–English $\ge T_{xl}$, capped at 5 rows per group including the representative). Exploration slots never lead or join a group, and `limit` still counts rows. Each row returns `source_id` so the client can match sources independently of non-unique source names.
- These defaults are kept together in the SQL function and were tuned in spec 020. Cards already displayed do not reorder; refreshing reloads the ranking, and subsequent pages use the latest feedback.
- The spec 007 validation search fixed the spec 020 winner and compared MMR strengths $\mu \in \{0, 0.1, 0.2, 0.3, 0.5\}$:

  | $\mu$ | Objective | Coverage | EN→FI  | FI→EN  | Distinct sources | Eligible                   |
  | ----- | --------- | -------- | ------ | ------ | ---------------- | -------------------------- |
  | 0     | 0.8253    | 0.6500   | 0.3575 | 0.7324 | 3.978            | reference                  |
  | 0.1   | 0.8130    | 0.6708   | 0.3573 | 0.6800 | 4.165            | no (FI→EN)                 |
  | 0.2   | 0.7918    | 0.7292   | 0.3473 | 0.6377 | 4.430            | no (objective, FI→EN)      |
  | 0.3   | 0.7598    | 0.8042   | 0.3340 | 0.5902 | 4.820            | no (objective, FI→EN)      |
  | 0.5   | 0.6417    | 0.7750   | 0.2753 | 0.5041 | 5.495            | no (objective, directions) |

  The committed rule therefore retains $\mu = 0$: MMR remains off because no positive strength met all guardrails. Distinct-source count rose with stronger MMR, but the same rows lost headline and Finnish-to-English relevance.

- Positions 5, 15, and 25 are exploration slots. Each takes the highest-scoring remaining item from a source that has no eligible item in the latest 200 likes; if no such item exists, the slot falls back to the next main item without an exploration flag. A 30-item page therefore has up to three exploration items. Other unliked-source items can still appear normally, and exploration feedback is stored as an ordinary signal.
- With $\mu = 0$, turning exploration on over 480 same-language validation runs changed headline precision@10 by $-0.003958$ and mean distinct sources by $+0.28125$. Position 5 was flagged in 440 runs (91.67% fill rate); 309 flagged items were relevant (70.23% hit rate). Cross-lingual runs are excluded because every target-language source is unliked by construction.
- After local ingestion, the user reviewed about ten exploration items and found them useful, not irrelevant or repetitive. Two composite-persona top-10 lists were not manually reviewed; the selected $\mu = 0$ leaves MMR off, so those lists have no before/after ranking difference from MMR.
- A source counts as liked only through the latest 200 eligible likes supplied to the scorer. Older likes fall out of this determination, so a previously liked source can be treated as unliked. This is a documented product limitation, not an identity lookup in the ranking function.
- These validation numbers are optimistic because selection used the validation window. Labels are LLM proxies, and the four single and six composite persona results share items and labels and are correlated. They do not measure long-term learning or the value of discovering a new interest.

### 2.3 Cold start

With no eligible positive signals, the feed round-robins sources, newest first within each source. Candidates with similarity at least $\theta = 0.4$ to any eligible _Not interested_ item or `less` preference follow all other candidates, with source round-robin within each group. Explanations say "Recent from source". Personalization starts after the first eligible like or `more` preference; clicks alone do not start it. The closest positive signal is the explanation; a tie prefers a like over a preference over a click. MMR and exploration still require eligible likes, so a preference-only or click-only feed has no exploration slots.

### 2.4 Baselines (evaluation only)

- **Average vector:** rank by similarity to the mean embedding of liked items.
- **Newest first.**
- **Random.**

### 2.5 LLM usage (limited)

OpenAI API with `gpt-6-luna` (chosen in week 1). The LLM is **not** used to rank individual items (cost, latency, reproducibility). It is used for:

1. **Interest summary:** on demand, `gpt-6-luna` turns up to 50 recent liked titles, 20 recent _Not interested_ titles, and active preference labels into one to three English sentences and at most eight short topic labels. It requires three positive signals, is display-only, and never runs on page load or changes ranking. A previous summary is retained on failure. Responses are not stored, calls reserve before fetch, and each user has 10 summary requests per rolling 24 hours separately from preference requests.
2. **Evaluation judge:** labels items as relevant/not relevant for simulated personas. The primary labeler is Qwen 3.8 27B, with `gpt-6-luna` as fallback (§4.2). The final snapshot was labeled via OpenRouter with approval after local MTPLX proved too slow.
3. **Source discovery** (stretch, stage b): finds candidate sites with the built-in web search tool and assesses source quality.
4. **Description enrichment:** `gpt-6-luna` via the Responses API creates a concise, factual description only when feed and page metadata descriptions are unavailable. The request has no tools or URL access; extracted article text is untrusted content, not instructions. The output must state the subject or main point directly in the item's language, usually in one sentence, without source narration or an unnecessary recap. Attribution, uncertainty, negation, and the scope of personal experience take precedence over concision. The output uses only facts in the text and fits the existing 1,000-character summary limit. Prompt constraints and representative tests live with the enrichment implementation.

   Spec 023 compared the current and candidate instructions on the frozen 24-item sample with blind human review. Run 1 was rejected for revision after 3 wins, 9 losses, and 12 ties (62.5% wins plus ties), despite no observed unsupported or wrong-language output. The one allowed revision produced 14 wins, 2 losses, and 8 ties (91.7%), removed the five observed English opening-narration cases, and again produced no observed unsupported or wrong-language output. The Finnish opening-narration comparison was 0 versus 0, so the strict “fewer than current” rule reported a local miss despite no regression; the user approved activation based on the overall pass and 8-to-2 Finnish preference result. Six revised English outputs were still flagged for later-sentence narration, and zero errors is a small-sample observation rather than proof of perfect accuracy. Results are recorded in `evaluation/description-style/summaries/`; generated review text and extracted article text remain gitignored.

5. **Natural-language feed tuning** (spec 021): one `gpt-6-luna` call turns a request of at most 300 characters into at most five preferences. The instruction is fixed; the user's text is untrusted and is not stored or logged. Each saved preference has a short label, a direction (`more` or `less`), and one positive sentence in Finnish and one in English. Those sentences are embedded once with `text-embedding-3-small` at 512 dimensions. Ranking uses the vectors and does not call the LLM. Each user may make 10 preference requests per rolling 24 hours. The count is reserved before the call, and a failed call still counts. At most 20 active preferences are stored.

6. **Source descriptions** (spec 024): generate short English descriptions with `pnpm sources:describe --out source-descriptions-review.json --all`. For each active source, `gpt-6-luna` gets the name, site host (feed host as fallback), language, kind, and up to 20 recent titles as untrusted data. Each request uses no tools, stores no response, and has a 120-token output cap, a 15-second timeout, and a 64 KB response limit. Sources without items are skipped. Review and edit the gitignored file, then save the exact text with `pnpm sources:describe --apply source-descriptions-review.json`. Apply matches by feed URL and makes no model calls. The default target is local. For an approved production run, use `node --env-file=.env.production.local scripts/describe-sources.mts --apply source-descriptions-review.json --production`. Generation runs manually and independently of ingestion.

Description generation is bounded to 20 API requests per ingestion run, including retries, at most 24,000 extracted characters per item and 200 output tokens per request. At an estimated 6,000 input tokens per request, the full request budget is about $0.014 at the model's current standard rates ($0.10/M input tokens and $0.50/M output tokens); this is an estimate, not a hard dollar cap. A failed item gets at most three attempts total, with retries due after 1 hour and 6 hours; exhausted items require an explicit backfill retry. Readable article text is extracted with the approved `@mozilla/readability` and `jsdom` dependencies. No full page or article text is retained.

Check 2 (`evaluation/results/preferences-021-check2.json`) ran the 12 committed requests once. The user marked 12 of 12 outputs correct (target 10). Two named subjects were split into two preferences. Empty lists for the ambiguous and off-topic requests were correct. The injection attempt did not change the football preference, and negation stayed in `direction`. Command-like and first-person descriptions were accepted because they still named the subject positively. The prompt was not tuned after the run. The ranking effect is in [§2.6](#26-natural-language-preferences).

Planned AI features that are not implemented yet (same-story grouping and TypeSafe Jev experiments; see [plan.md §3](plan.md#3-ai-in-the-application-summary)) are designed in their own specs and added here when implemented.

### 2.6 Natural-language preferences

A signed-in user can save preferences from a short request. `get_feed` reads that user's rows and passes them by direction. A card whose closest positive signal is a preference says "Matches your preference: _label_" as plain text. Saved preferences apply on the next load or **Refresh feed**.

Check 1 tested the hypothesis that a one-sentence description, embedded in Finnish and English, is similar enough to articles to steer ranking. It did not compare sentences with labels. The run used the production blend ($\alpha = 0.5$, centered, $\lambda = 0.5$, $\beta = 0$, diversity 0, exploration off) on the validation window, seeds 0–9, and the existing labels. Result: `evaluation/results/preferences-021-check1.json`.

`more` alone, against cold start with no signals (target: higher precision@10 for at least 3 of 4):

| Persona              | Cold precision@10 | `more` precision@10 |
| -------------------- | ----------------: | ------------------: |
| AI and software      |              0.20 |                0.90 |
| Cars and engineering |              0.20 |                0.50 |
| Science and space    |              0.20 |                0.80 |
| Finnish sports       |              0.00 |                0.60 |

All 4 improved.

`less` is a soft penalty. For each composite and each member (12 ordered cases, $k = 10$), the treatment was the same likes plus a `less` preference for member B. The gated measure was the share of top-10 items relevant to B and not to A (target: lower in at least 10 of 12). A-exclusive share and composite precision were reported, not gated.

| Liked pair                       | `less` for           | B-exclusive share | Precision@10 |
| -------------------------------- | -------------------- | ----------------: | -----------: |
| AI and software + Cars           | AI and software      |       0.56 → 0.44 |  0.85 → 0.81 |
| AI and software + Cars           | Cars and engineering |       0.22 → 0.19 |  0.85 → 0.84 |
| AI and software + Science        | AI and software      |       0.45 → 0.30 |  0.94 → 0.94 |
| AI and software + Science        | Science and space    |       0.44 → 0.34 |  0.94 → 0.94 |
| AI and software + Finnish sports | AI and software      |       0.40 → 0.33 |  0.82 → 0.82 |
| AI and software + Finnish sports | Finnish sports       |       0.42 → 0.31 |  0.82 → 0.86 |
| Cars + Science                   | Cars and engineering |       0.22 → 0.13 |  0.79 → 0.76 |
| Cars + Science                   | Science and space    |       0.47 → 0.30 |  0.79 → 0.73 |
| Cars + Finnish sports            | Cars and engineering |       0.34 → 0.22 |  0.77 → 0.73 |
| Cars + Finnish sports            | Finnish sports       |       0.43 → 0.24 |  0.77 → 0.74 |
| Science + Finnish sports         | Science and space    |       0.51 → 0.23 |  0.88 → 0.82 |
| Science + Finnish sports         | Finnish sports       |       0.37 → 0.19 |  0.88 → 0.88 |

The B-exclusive share fell in all 12 cases. The A-exclusive share rose in all 12. Composite precision@10 fell in 7, stayed the same in 4, and rose in 1. That is the expected cost of a soft penalty: unwanted items become less common, but some relevant items can move down with them. The held-out ranking table without preferences is in [§4.5](#45-held-out-test-run).

## 3. Source discovery (stretch goal)

Two independent stages, both attempted only after gate 2 ([plan.md §9](plan.md#9-decision-gates-and-cut-order)). Both feed the same validation and approval steps.

**Stage (a) — catalog-based (no LLM, ~5 h):** inactive sources from the catalog ([feeds.md](feeds.md)) are fetched, their recent items embedded and scored against each user's liked items. Sources that match well are proposed to the admin.

**Stage (b) — LLM web search (~6–8 h):** the LLM, using web search and the interest summary, suggests candidate sites. The LLM only _suggests_; deterministic code verifies.

Validation and approval (both stages):

1. Fetch each site and detect RSS/Atom feeds (autodiscovery). Feed URLs proposed by the LLM are never trusted without fetching.
2. Parse the feed: is it active, with recent posts?
3. Embed recent items and score them against the user's interests; in stage (b) the LLM also assesses source quality.
4. An admin approves a source before it is ingested. Approved sources join the shared source pool; each user's recommender decides whether its items are relevant to them.

Optional extra candidate source: outbound links from liked articles, fed into the same validation pipeline.

Safeguards: discovery runs manually or weekly with a cap on searches per run; fetching is restricted to http/https, blocks private/internal addresses (SSRF), and enforces timeouts and response size limits.

The core recommender must work without this feature.

## 4. Evaluation

Goal: a rigorous comparison of the recommender against simple baselines. A careful comparison is a successful result even if the recommender does not win; the report then analyzes why.

### 4.1 Early checks (week 2, [spec 001](specs/001-ingestion.md))

- **Cross-lingual check** (moved to the evaluation, spec 006): Finnish–English pairs of the same event (Yle News in English vs Finnish Yle feeds) must be clearly more similar than random pairs.
- **Early ranking experiment:** a fixed bilingual sample of ~300 items; for 2 personas, ~5 hand-picked liked items each (at least one Finnish). Rank the rest with nearest-liked, average-vector, and newest-first, then judge the top 10 of each by hand. The three lists are merged and shuffled before judging, so the method behind each item is not visible.
- **Gate 1:** if nearest-liked is not at least on par with average-vector and better than newest-first, investigate (embedding input text, $\lambda$, sample) before building the UI around it. Average-vector is the fallback ranking; the rest of the application does not depend on the choice.
- The sample is small, so the result is indicative only; it is recorded in [ai-log.md](ai-log.md).

### 4.2 Dataset and labels

1. Export a read-only production snapshot of eligible items spanning at least 14 days. Preserve source, item, and language-mean UUIDs/vectors. Import it only into an empty local Supabase database. Split by publication time into feedback (oldest 50%), validation (next 25%), and test (newest 25%) windows.
2. Personas are configuration, not database users: "AI and software", "cars and engineering", "science and space", and "Finnish sports". Replay passes explicit item IDs to `rank_items`; user isolation is covered by the RLS integration tests.
3. Label every persona-item pair with Qwen 3.8 27B, a different model family from the OpenAI embedding model. The intended endpoint is local MTPLX; for the final snapshot, the user approved OpenRouter model `qwen/qwen3.8-27b` after the local endpoint could not complete a batch within the request timeout. The remote provider's exact build and quantization were not captured. Labels are proxy judgments, not independent ground truth. The label cache records the model ID and prompt version, is resumable, and must form one complete, single-model label set before replay.
4. Draw two disjoint blind sets of 60 pairs each, 15 per persona and balanced by language. Stratify by persona, language, and the primary model's label; record population/sample stratum sizes and inclusion probabilities. The selection set decides whether the whole snapshot must be relabeled with `gpt-6-luna`; score the reporting set once with the selected label set. Report inverse-probability-weighted agreement, Cohen's κ, precision, and recall overall and by language.

### 4.3 Protocol safeguards

- `rank_items` is the production SQL ranking surface and the only ranking implementation used by replay. It supports `nearest_liked`, `average_vector`, feedback-independent `newest_first` and seeded `random`; it also supports the raw-vector variant with `centered = false`. Recency uses a fixed `p_as_of` for each candidate window.
- For each persona and seed, sample one fixed feedback sequence from the feedback window: $k$ relevant items as likes and $\lfloor k/2 \rfloor$ non-relevant items as dislikes, for $k \in \{0,1,3,5,10,20\}$. Larger $k$ values are prefixes of the same sequences. Every method receives the same lists; rated items are removed from every candidate pool.
- Cross-lingual retrieval uses only feedback in the source language and a candidate pool in the target language: English-to-Finnish and Finnish-to-English. Both likes and dislikes use the source language.
- Freeze the near-duplicate threshold after inspecting feedback-window pairs only. For the headline metric, remove candidates whose centered similarity to any feedback item meets the threshold **before** ranking. Rank the full candidate pool separately for the duplicate-inclusive metric.
- Tune parameters only on validation. Before one test-window run, freeze parameters, commit, snapshot/label/config hashes, threshold, seeds, and $k$ values. Test replay requires a clean tree and matching `HEAD`, refuses `--params` and duplicate runs, and records the reason for an explicitly authorized new experiment.
- Use at least 10 seeds. Report means, standard deviations, and paired 95% intervals across seeds; do not pad missing cells.

### 4.4 Metrics

- Precision@10 by method, persona, $k$, and ranking scope (headline and duplicate-inclusive), with seed mean, standard deviation, and paired difference to `average_vector` with a 95% interval.
- Distinct sources and categories in each top 10, plus top-10 Jaccard overlap between personas at $k=10$.
- Cross-lingual retrieval precision@10 for relevant target-language items under source-language-only feedback. Record the number of relevant candidates for each cell.
- The separate embedding check compares at least 10 manually confirmed Yle Finnish-English event pairs against the 95th percentile of random cross-language pairs, for raw and centered vectors. If fewer than 9 of 10 matched pairs exceed the random threshold for both variants, compare a local multilingual embedding model.

Limitation: this demonstrates adaptation in a controlled setting, not real-world recommendation accuracy.

### 4.5 Held-out test run

The one-time test-window replay ran at commit `c65b6c8` under the spec 006 guard (experiment `5c4b9226cf16d14720a63969c11b696fd32bdefa839d41e141f07e2acd40bb0f`). The production treatment is `blend`, $\alpha = 0.5$, centered, $\lambda = 0.5$, $\beta = 0$, $\mu = 0$, exploration on. Baselines ran with diversity 0 and exploration off. Result: `evaluation/results/test-5c4b9226cf16d14720a63969c11b696fd32bdefa839d41e141f07e2acd40bb0f.json`.

The same treatment on the validation window, with no preferences, is `evaluation/results/parity-021-production.json` (objective 0.8213). The earlier tuning validation, exploration off, was objective 0.8253, coverage 0.650, EN→FI 0.358, FI→EN 0.732 ([§2.1](#21-interest-scoring-nearest-liked-item), [§2.2](#22-final-ranking-and-exploration)).

Test-window headline objective (mean precision@10 over $k \in \{3, 5, 10, 20\}$, equal persona weight):

| Method                               | Objective | Coverage |  EN→FI |  FI→EN |
| ------------------------------------ | --------: | -------: | -----: | -----: |
| production (`blend`, exploration on) |    0.8297 |   0.5833 | 0.3810 | 0.6682 |
| `nearest_liked`                      |    0.7722 |   0.5833 | 0.3493 | 0.6210 |
| `nearest_liked`, raw                 |    0.7808 |   0.4750 | 0.3675 | 0.6069 |
| `average_vector`                     |    0.8485 |   0.4375 | 0.3837 | 0.6445 |
| `newest_first`                       |    0.0400 |   0.0000 | 0.1200 | 0.1600 |
| `random`                             |    0.2140 |   0.0500 | 0.0870 | 0.2420 |

Headline precision@10 at $k = 10$ for the four single personas, next to the first validation run (`nearest_liked`, $\beta = 0.1$, commit `7c0549f`) and the production-treatment validation baseline:

| Persona              | Validation `nearest_liked` | Validation production | Test production |
| -------------------- | -------------------------: | --------------------: | --------------: |
| AI and software      |                       0.93 |                  0.93 |            0.90 |
| Cars and engineering |                       0.47 |                  0.78 |            0.67 |
| Science and space    |                       0.87 |                  0.94 |            0.94 |
| Finnish sports       |                       0.68 |                  0.79 |            0.90 |

The test objective (0.8297) is close to the same-treatment validation objective (0.8213). `average_vector` still scores higher on the objective and lower on coverage. These are held-out estimates against LLM proxy labels, not real-user relevance. Persona results remain correlated. Note: these frozen results measure the unchanged `ranking_private.rank_items` scorer, not the production `get_feed` covered-story filter or per-page grouping ([spec 025](specs/025-same-story.md)).

## 5. Technology stack

Guiding principle: lowest possible cost, single language (TypeScript).

| Part                 | Choice                                                                                                  | Cost               |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ |
| Frontend and API     | Next.js (App Router, TypeScript) on Vercel Hobby                                                        | Free               |
| Database and vectors | Supabase Postgres + pgvector                                                                            | Free tier          |
| Database access      | supabase-js (`@supabase/ssr` in Next.js), SQL migrations via Supabase CLI, generated TypeScript types   | Free               |
| Authentication       | Supabase Auth with Google login                                                                         | Free               |
| Scheduled jobs       | Vercel Schedules for hourly ingestion. GitHub Actions provides manual fallback.                         | Free tier          |
| Embeddings           | OpenAI `text-embedding-3-small`, 512 dimensions                                                         | < 1 €/month        |
| LLM                  | OpenAI GPT models via Responses API; description enrichment uses `gpt-6-luna`                           | A few € total      |
| Evaluation labels    | Qwen 3.8 27B via MTPLX; final snapshot via OpenRouter with approval                                     | Provider-dependent |
| Classification       | TypeSafe Jev `jev-1.14.0` via plain `fetch` (planned, [spec 009](specs/009-description-quality-jev.md)) | < 1 € total        |
| RSS parsing          | `rss-parser`; article text with `@mozilla/readability` and `jsdom`                                      | Free               |
| UI                   | shadcn/ui (Base UI) + Tailwind CSS v4                                                                   | Free               |

Implementation notes:

- Recommender and baseline scoring are Postgres SQL functions called via RPC, so vectors never leave the database.
- Vercel runs ingestion hourly through a private function with a five-minute limit. The Supabase lease prevents overlapping Vercel runs and expires if the function times out. Regular ingestion also keeps the Supabase project active. [Spec 016](specs/016-vercel-scheduled-ingestion.md)
- For a GitHub fallback, pause `feed-ingestion` in Vercel, let any in-flight run finish, and dispatch **Ingest feeds** in GitHub Actions. To restore automatic GitHub ingestion, also restore the previous cron trigger (`17 * * * *`). Wait for GitHub ingestion to finish before resuming Vercel.
- 512-dimension embeddings and pruning of old items keep the database within the 500 MB free limit.
- Evaluation scripts are TypeScript; results are exported as CSV/JSON for charts.
- Vercel Hobby is non-commercial only; a paid plan is needed if the project becomes a product.
- Google OAuth consent screen stays in "Testing" mode during the course (only listed test users can log in).

### 5.1 Data access and security

User-facing queries run through supabase-js with the user's session, or a cookie-free anonymous client for the public preview. Row Level Security (RLS) and column privileges are enforced by the database.

| Data     | Examples                                                     | Read                                                 | Write                                |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------ |
| Shared   | `sources`, content items, embedding language means           | Authenticated users; public metadata exception below | Service role only (ingestion, admin) |
| Per-user | feedback, feed preferences, hidden sources, usage, discovery | Owner only (`user_id = auth.uid()`)                  | Owner only where applicable          |

Rules:

- RLS is enabled on every table.
- Public-preview exception ([spec 008](specs/008-guest-feed-preview.md)): anonymous clients can select `sources.id,name` for active sources and `content_items.id,source_id,url,title,summary,summary_origin,type,language,thumbnail_url,published_at` for completed items with nonblank summaries and HTTP(S) URLs from active sources, published within seven days for articles or thirty days for videos, never in the future. Explicit column grants and anonymous SELECT policies enforce this boundary. All eligible public metadata can be queried directly through the Data API, beyond the twelve cached preview cards. Anonymous writes, vectors, ingestion internals, ranking/feedback functions, and user data remain protected.
- Only authenticated users can read `sources.description` and `sources.description_generated_at`. The service-role script saves reviewed descriptions. Anonymous source access is limited to `id` and `name`.
- Any verified Google user can use the app; no invitation or email provisioning is required.
- App pages verify identity with `getClaims()`; RLS and database functions remain the authorization boundary. Google OAuth must be published to Production for sign-in beyond Google's configured test users.
- Feed and scoring functions read the user from `auth.uid()` internally and never accept a `user_id` parameter; they run as `SECURITY INVOKER`.
- `hidden_sources` and `hide_source_of_item` are owner-scoped per-user surfaces. Anonymous clients have no table or function access, and hiding an item never writes feedback for it.
- Views are created with `security_invoker = true`.
- The service-role key is used only in GitHub Actions secrets and server-only environment variables, never in `NEXT_PUBLIC_` variables.
- Description enrichment fetches only an ingested item's canonical `http` or `https` URL. It rejects loopback, private, link-local, reserved, and mixed DNS answers; pins each validated public answer to its connection; and validates every redirect target before connecting, preserving the hostname for Host and TLS verification. It forwards no credentials or feed validators, accepts only HTML, caps each request at 8 seconds and 1 MB with at most 3 redirects and 3 concurrent fetches, executes no JavaScript, and never stores or logs fetched page/article text.
- RLS does not limit cost. Current AI usage is shared ingestion work, independent of user count; per-user limits must be implemented with the first user-triggered LLM action.
- Policies are covered by automated tests with two users.

## 6. Data model

Tables are added by the spec that first needs them. Shared tables are writable only with the service role; reads require authentication except for the explicitly public source/content metadata in §5.1. Spec 008 adds no table: its twelve-card guest preview reads the existing tables through an anonymous client and caches the result for thirty-minute revalidation.

### 6.1 `sources` (shared)

| Column                               | Type               | Notes                                               |
| ------------------------------------ | ------------------ | --------------------------------------------------- |
| `id`                                 | `uuid` PK          |                                                     |
| `name`                               | `text`             | e.g. "Yle — Science"                                |
| `feed_url`                           | `text` unique      |                                                     |
| `site_url`                           | `text` null        |                                                     |
| `description`                        | `text` null        | Reviewed English description, 1–300 characters when present |
| `description_generated_at`           | `timestamptz` null | Timestamp set when reviewed text is applied         |
| `kind`                               | `text`             | `rss` or `youtube` (RSS also covers Atom)           |
| `language`                           | `text`             | `fi` or `en`; set per source, not detected per item |
| `is_active`                          | `boolean`          | Initial set active, rest of the catalog inactive    |
| `etag`, `last_modified`              | `text` null        | Conditional GET                                     |
| `last_fetched_at`, `last_success_at` | `timestamptz` null |                                                     |
| `last_error`                         | `text` null        | Last fetch/parse error                              |
| `created_at`                         | `timestamptz`      |                                                     |

### 6.2 `content_items` (shared)

| Column                       | Type                  | Notes                                                             |
| ---------------------------- | --------------------- | ----------------------------------------------------------------- |
| `id`                         | `uuid` PK             |                                                                   |
| `source_id`                  | `uuid` FK → `sources` | First source that delivered the item                              |
| `type`                       | `text`                | `article` or `video`                                              |
| `url`                        | `text` unique         | Normalized URL; deduplication key                                 |
| `title`                      | `text`                | Plain text                                                        |
| `summary`                    | `text` null           | Plain text, cleaned, max ~1,000 characters                        |
| `summary_origin`             | `text` null           | `feed`, `page_metadata`, or `ai_generated`; null while unresolved |
| `enrichment_status`          | `text`                | `pending`, `completed`, or `exhausted`                            |
| `enrichment_attempt_count`   | `integer`             | Non-negative; bounded by the retry policy                         |
| `enrichment_last_attempt_at` | `timestamptz` null    |                                                                   |
| `enrichment_next_attempt_at` | `timestamptz` null    | Due time for a pending retry                                      |
| `enrichment_error`           | `text` null           | Bounded to 500 characters                                         |
| `language`                   | `text`                | Copied from the source                                            |
| `categories`                 | `text[]`              | Feed category tags; not used for ranking                          |
| `thumbnail_url`              | `text` null           |                                                                   |
| `published_at`               | `timestamptz`         | Falls back to fetch time                                          |
| `embedding`                  | `vector(512)` null    | Null until embedded                                               |
| `embedding_model`            | `text` null           | e.g. `text-embedding-3-small@512`                                 |
| `created_at`                 | `timestamptz`         |                                                                   |

Known site-wide page metadata descriptions are rejected; existing matching `page_metadata` summaries are requeued by the enrichment backfill.

Non-empty existing summaries are backfilled as `feed`/`completed`; empty summaries are `pending` with no provenance. Database checks enforce valid provenance and enrichment-state combinations. Indexes cover `published_at desc`, due pending enrichment, and completed items missing embeddings. An HNSW index on `embedding` is added only if exact search becomes slow (tens of thousands of rows are fine without it).

### 6.3 `feedback` (per-user)

One row per user and item; the current state only (latest action wins). Undo deletes the row.

| Column                     | Type                        | Notes                                                    |
| -------------------------- | --------------------------- | -------------------------------------------------------- |
| `user_id`                  | `uuid` FK → `auth.users`    | Part of PK; defaults to `auth.uid()`                     |
| `item_id`                  | `uuid` FK → `content_items` | Part of PK                                               |
| `kind`                     | `text` not null             | `like`, `not_interested`, or `seen`                      |
| `via`                      | `text` not null             | `button` or `swipe`; used to analyze accidental gestures |
| `created_at`, `updated_at` | `timestamptz` not null      | Default `now()`; trigger updates `updated_at`            |

RLS: owner-only `select`, `insert`, `update (kind, via)`, `delete`; covered by two-user tests. Writes go through `set_feedback(item_id, kind, via)` (`SECURITY INVOKER`, user from `auth.uid()`), because a client-side upsert would also try to update `item_id`.

### 6.4 `embedding_language_means` (shared)

| Column            | Type                   | Notes                                         |
| ----------------- | ---------------------- | --------------------------------------------- |
| `embedding_model` | `text`                 | Part of PK; e.g. `text-embedding-3-small@512` |
| `language`        | `text`                 | Part of PK; `fi` or `en`                      |
| `mean`            | `vector(512)` not null | Corpus mean for the model and language        |
| `item_count`      | `integer` not null     | At least 50 embedded items                    |
| `computed_at`     | `timestamptz` not null | Time the mean was computed                    |

RLS is enabled. Authenticated users have `select` only; anonymous users have no access, and only the service role writes. `pnpm embeddings:means` manually computes the means from all embedded items of the active model, upserts qualifying groups, and reports skipped groups below 50 items. Means remain frozen until the next run. The normal command targets `.env.local`; hosted runs explicitly load `.env.production.local` without changing the local environment file.

### 6.5 Access-control removal

The email allowlist table was removed by a forward migration. `public.is_allowed()` remains temporarily for rollout compatibility with the previous app: it is `stable`, `SECURITY INVOKER`, has an empty search path, is executable only by `authenticated`, and returns whether `auth.uid()` is non-null. No current policy, feed/feedback RPC, or app page calls it. Drop this compatibility function in a later migration after the updated app is deployed.

### 6.6 Later tables

Click events and interest summaries are described in §6.10 and §6.11. Discovery candidates remain a later feature. Feed preferences and LLM usage are in §6.7 and §6.8.

### 6.7 `feed_preferences` (per-user)

| Column            | Type                   | Notes                                                   |
| ----------------- | ---------------------- | ------------------------------------------------------- |
| `id`              | `uuid` PK              | `gen_random_uuid()`                                     |
| `user_id`         | `uuid` not null        | Default `auth.uid()`; cascade when the user is deleted  |
| `label`           | `text` not null        | 1–40 characters after trim                              |
| `direction`       | `text` not null        | `more` or `less`                                        |
| `description_fi`  | `text` not null        | 1–200 characters; the Finnish sentence that is embedded |
| `description_en`  | `text` not null        | 1–200 characters; the English sentence that is embedded |
| `embedding_fi`    | `vector(512)` not null | Centered at ranking time                                |
| `embedding_en`    | `vector(512)` not null | Centered at ranking time                                |
| `embedding_model` | `text` not null        | Active model, `text-embedding-3-small@512`              |
| `created_at`      | `timestamptz` not null | Default `now()`                                         |
| `updated_at`      | `timestamptz` not null | Set by a trigger on update                              |

RLS is owner-only `select`, `update`, and `delete`. Authenticated users can update only `direction`. They cannot insert. The server action inserts with the service role after `getClaims()`, and sets `user_id` from those claims. A trigger takes a per-user advisory lock, counts rows, and rejects an insert that would exceed 20; the whole batch rolls back. Two-user tests cover read, update, and delete.

### 6.8 `llm_usage` (per-user)

| Column       | Type                   | Notes                                        |
| ------------ | ---------------------- | -------------------------------------------- |
| `id`         | `uuid` PK              | `gen_random_uuid()`                          |
| `user_id`    | `uuid` not null        | Default `auth.uid()`; cascade on user delete |
| `kind`       | `text` not null        | `preferences` or `interest_summary`          |
| `created_at` | `timestamptz` not null | Default `now()`; the user cannot set it      |

RLS is owner-only `select` and `insert`. There is no update or delete policy. Authenticated users can insert only `kind`; `user_id` and `created_at` come from column defaults. A direct insert uses up the caller's own quota and cannot be backdated or deleted by the user.

`reserve_llm_call(p_kind text)` is volatile, `SECURITY INVOKER`, and has an empty search path. It reads the user from `auth.uid()`, rejects an unknown kind, locks the user for the transaction, and inserts a row only when that user has fewer than 10 rows of that kind in the last 24 hours. Preference and interest-summary quotas are separate. It inserts only `kind`. Execute is granted to `authenticated` and revoked from `PUBLIC` and `anon`. Both actions call it before any OpenAI request. A failed call still counts.

### 6.9 `hidden_sources` (per-user)

| Column       | Type                     | Notes                                           |
| ------------ | ------------------------ | ----------------------------------------------- |
| `user_id`    | `uuid` FK → `auth.users` | Part of PK; defaults to `auth.uid()`; cascades  |
| `source_id`  | `uuid` FK → `sources`    | Part of PK; cascades when the source is deleted |
| `created_at` | `timestamptz` not null   | Default `now()`                                 |

RLS is owner-only `select`, `insert`, and `delete`; there is no update policy. Anonymous users have no access. `hide_source_of_item(p_item_id uuid)` is `SECURITY INVOKER` with an empty search path and reads the caller from `auth.uid()`. It accepts any readable item, inserts the source idempotently, and returns the source ID and name for UI feedback. Showing a source again is a direct owner-only delete.

### 6.10 `item_clicks` (per-user)

One idempotent row per user and opened feed item. `record_click(p_item_id uuid)` reads `auth.uid()`, requires a readable item, and inserts only the item ID; repeated opens preserve the first `clicked_at`. RLS and column grants permit owner-only `select` and insert of `item_id`; there is no update or delete policy. Anonymous access is denied. Account deletion cascades these rows.

### 6.11 `interest_summaries` (per-user)

One display-only row per user with `summary` (1–400 characters), at most eight topic labels, `like_count`, and `generated_at`. Authenticated users can select and delete only their own row; direct insert and update are denied. The server action verifies claims and writes with the service role, while **Clear** deletes through the user's client and RLS.

## 7. User interaction

The feed is a single column of compact cards, responsive for phone and desktop. Each card shows title, source, time, thumbnail (if any), and a one-line explanation.

### 7.1 Actions

| Action           | Control   | Touch gesture | Meaning           | Effect in the feed                                                           |
| ---------------- | --------- | ------------- | ----------------- | ---------------------------------------------------------------------------- |
| _Like_           | Button    | Swipe right   | Positive topic    | Card stays, marked as liked                                                  |
| _Not interested_ | Button    | Swipe left    | Negative topic    | Card collapses immediately; similar content ranks lower                      |
| _Seen_           | Button    | —             | Neutral item      | Card collapses immediately; for items already read or watched elsewhere      |
| **Hide source**  | Card menu | —             | Source visibility | Every loaded card from that source is masked; future candidates are filtered |
| **Open item**    | Title/member link | Primary, Enter, middle-click | Read at publisher | Keeps the card in the current list; later feed loads exclude it and History lists it |

- Pressing an active Like, Not interested, or Seen button again undoes the action; choosing another action replaces it.
- Every action that hides content shows a short **Undo** toast. Hiding a source records no item feedback, so Undo restores visibility rather than changing a rating.
- Buttons are always available on every device; gestures are a touch shortcut, not the only way (accessibility).
- Rated items (any feedback action) do not return in the feed. A hidden source's existing likes and dislikes remain valid topic signals.
- _Seen_ is a button only, so swipe-left keeps its existing _Not interested_ meaning. **Hide source** is separate and available from the card's accessible action menu.
- Hidden cards stay mounted in their original positions, preserve feedback state, and still count as loaded for pagination exclusions. Late-arriving pages use the same source-ID mask. The list does not re-fetch or re-rank after hiding or Undo; the next feed load applies the persistent database filter.
- Same-story groups render as one card per representative with an "Also covered by: _source_ · _source_" line for members in the same page. Member links sit above the stretched card link, accept only HTTP(S) URLs, open in a new tab, and record the member's ID. Context-menu opens and swipes do not record clicks; members from hidden sources are omitted. Hiding or Undo on a representative masks or restores the entire group.
- Tune feed and Sources are separate pages at `/preferences/tune` and `/preferences/sources`. Both are reached from the header's user menu. Sources lists the active sources by name with language badges, a Videos badge for YouTube, and an English description when available. Turning off a switch hides the source for the signed-in user. Changes apply on the next feed load or refresh.

The Liked page searches the titles, full summaries, and source names of items already loaded by the page. It trims the query and matches it as a case-insensitive substring in any one field, preserving accents, punctuation, and newest-liked-first order. The result count is relative to the loaded list, which can be smaller than the user's full liked history. The query stays active when the mounted list refreshes after Unlike and starts empty on a new mount.

History is in the signed-in main navigation after Liked. It shows opened and _Seen_ items newest by latest event time, with both badges when applicable, and 20-row keyset pagination through **Load more**. Cards keep their feedback controls and mounted order; subsequent fresh loads reflect current membership.

### 7.2 Gesture safeguards

Swipe-to-dismiss is a common habit (e.g. in email), so a left swipe meaning "already seen" could be recorded as _Not interested_. Safeguards:

- The swipe reveals a colored background with an icon and label ("Like" / "Not interested") and only commits past a threshold (~40% of card width).
- Horizontal swipes lock direction so vertical scrolling is never misread as a swipe.
- Undo toast after every swipe.
- Feedback records `via` (`button` / `swipe`), so undo rates by input method can be measured and reported.

### 7.3 Ranking updates

The ranking does not reorder while the user is interacting. New feedback and saved preferences take effect on the next load or when the user presses **Refresh feed**.

### 7.4 Explanations

- Personalized items: "Similar to _X_, which you liked".
- Preference matches: "Matches your preference: _label_".
- Opened matches: "Similar to _X_, which you opened".
- Exploration slots: "Exploring: something new".
- Cold start: "Recent from _source_".
- Reason precedence: exploring, preference, opened, similar, recent.

### 7.5 Not included

Impression tracking and weak implicit skip signals remain possible later additions. Hiding a source is already implemented as a separate source-visibility action, not as a negative-feedback reason.

**Implicit skip signals** (scrolling quickly past an item as a weak negative) are deliberately left out:

- Scrolling past is ambiguous: the user may have already read the story elsewhere, got enough from the title, or been in a hurry. Lower positions are skipped more just because of their position.
- Most items are skipped, so even small negative weights would add up and, with the nearest-item penalty, push down whole topics.
- It needs impression tracking (which cards were visible and for how long) and would have to be simulated in the evaluation, where realistic skip behavior is hard to model.

If added later, the safer variant is "skip above click": items shown above a clicked item without any interaction get a small negative weight. It requires click tracking and a log of the ordered item IDs per feed load.
