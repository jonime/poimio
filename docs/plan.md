# Poimio — Personal Content Discovery

**Version:** 1.1 — Project plan  
**Status:** Planning complete — submitted  
**Project type:** Solo AI course assignment  
**Duration:** 7 weeks (26 Oct – 13 Dec 2026)  
**Estimated workload:** 135 hours (course definition)  
**Long-term potential:** Standalone application

**Deadlines and grading:**

| Phase                | Deadline              | Weight |
| -------------------- | --------------------- | ------ |
| Planning (this plan) | Sun 8 Nov 2026 12:00  | 25%    |
| Prototype + video    | Sun 22 Nov 2026 12:00 | 25%    |
| Final version        | Sun 13 Dec 2026 12:00 | 50%    |

Deadlines are Sunday noon, so each phase's work is planned to finish by Saturday.

Related documents:

- [design.md](design.md) — technical design (sources, recommender, discovery, evaluation, stack, security, data model)
- [feeds.md](feeds.md) — feed catalog
- [specs/](specs/) — feature specs (one per feature, see [AGENTS.md](../AGENTS.md) for the workflow)
- [ai-log.md](ai-log.md) — log of significant AI-assisted work
- [course/plan-deliverable.md](course/plan-deliverable.md) — course forum submission

## 1. Project goal

Develop a web-based content aggregation system that learns a user's interests and recommends relevant links to news, articles, and other online content.

Unlike traditional RSS readers, the application should automatically personalize recommendations based on user interactions, requiring minimal manual configuration.

Content is in Finnish and English. The application is primarily a link list: clicking an item opens the original website.

The application supports multiple users (Google login); each user has a personal feed and interest profile.

The longer-term vision includes autonomous discovery of new content sources.

## 2. Concrete examples

**Example 1: Learning user preferences**

A user likes several English articles about Linux and artificial intelligence and marks entertainment news as not interesting.

The application gradually prioritizes articles about Linux, AI, and related topics — including Finnish articles on the same subjects, because the content representation is multilingual. Each recommendation can be explained, e.g. "Similar to _Ubuntu 26.04 released_, which you liked."

**Example 2: Discovering relevant sources**

The system recognizes that a user is interested in self-hosting and discovers a previously unknown technical blog with an RSS feed.

Articles from that blog become candidates for the personalized feed.

## 3. AI in the application (summary)

Technical details are in [design.md](design.md).

- **Semantic embeddings** (multilingual, Finnish + English) represent every article and video.
- **Recommender:** each item is scored by its similarity to the closest item the user liked, minus a penalty for similarity to items marked _Not interested_, combined with recency, diversity, and exploration slots. Every recommendation can be explained. The negative and visibility actions are intentionally separate: _Not interested_ means "not this topic", **Hide source** filters that source, and _Seen_ is neutral.
- **Natural-language feed tuning:** an LLM turns a request such as "less crypto, more local AI models" into structured, editable preferences once per edit; their embeddings act as extra positive or negative signals in the existing scoring. No LLM call at ranking time.
- **Same-story grouping:** embeddings only (no LLM or Jev); `get_feed` filters near-duplicates of recently rated items before ranking and groups near-duplicate rows within each page (`duplicate_of`). The feed shows one card per story with "Also covered by" links to the other sources.
- **LLM tasks:** fill missing item descriptions from extracted article text, readable interest summary, relevance labels for evaluation, and (stretch goal) source discovery with web search. The LLM does not rank items.
- **Source descriptions:** a one-time `gpt-6-luna` run drafts short English descriptions of active sources from their metadata and recent titles. The reviewed text appears on the Sources settings page.
- **Description quality (experiment):** TypeSafe Jev, a non-generative scoring model, flags poor item descriptions; compared offline with deterministic rules and `gpt-6-luna` as a judge ([spec 009](specs/009-description-quality-jev.md)).
- **Evaluation:** replay test with simulated personas against average-vector, newest-first, and random baselines. Relevance labels from the local Qwen model are compared with Jev and with manual labels.

## 4. Deliverables

### 4.1 Prototype (proof of concept, due 22 Nov)

Goal: prove the core AI idea. The prototype is a rough first version that the final application grows from, not throwaway code.

- Ingestion of the initial feeds ([design.md §1](design.md#1-content-sources-and-representation)), Finnish and English, including YouTube channels; normalization, deduplication, embeddings. Runs hourly from week 2 so content accumulates for the evaluation: first via GitHub Actions, since 7 Nov via Vercel Schedules ([spec 016](specs/016-vercel-scheduled-ingestion.md)), because GitHub's scheduled runs started only every 4–9 hours.
- Google login (Supabase Auth); feedback stored per user and protected by RLS.
- Automated two-user RLS tests for every per-user table, written together with the table. They must pass before deployment or testing with another person.
- Early ranking experiment with language centering (gate 1, [design.md §4.1](design.md#41-early-checks-week-2-spec-001)).
- Next.js link list with _Like_ / _Not interested_ / _Seen_ buttons, swipe gestures on touch devices, and undo ([design.md §7](design.md#7-user-interaction)).
- Recommender ranking ([design.md §2.1](design.md#21-interest-scoring-nearest-liked-item)) with recency and "why recommended" explanations.
- Deployed on Vercel; production deploys only after CI, including the RLS integration tests, passes; any verified Google user can sign in without an invitation ([spec 004](specs/004-deployment-access.md)).

Not included: exploration slots, interest summary, evaluation harness, cross-lingual check (moved to the evaluation), source discovery.

**Video (2–3 min), recorded on the deployed app:**

1. Empty profile → varied feed.
2. Like 4–5 Linux/AI articles → feed re-ranks with explanations.
3. Finnish articles on the same topic appear (cross-lingual embeddings).
4. Mark sports as not interesting → sports articles drop; a swipe on a phone.
5. Gate 1 result: nearest-liked vs average-vector vs newest-first, raw and language-centered (precision@10 from the early experiment).

### 4.2 Final application (due 13 Dec)

- Per-user LLM usage limits, added with the first LLM-triggering user action.
- Exploration slots and diversity re-ranking ([spec 007](specs/007-exploration-diversity.md)); explicit source hiding ([spec 022](specs/022-hide-source.md)), separate from topic and neutral-item feedback.
- Natural-language feed tuning and same-story grouping (see cut order in §9).
- Evaluation harness and results ([design.md §4](design.md#4-evaluation)).
- Optional (see cut order in §9): LLM interest summary; click tracking as a weak positive signal.
- Optional experiment ([spec 009](specs/009-description-quality-jev.md)): description quality with TypeSafe Jev against rules and an LLM judge. Offline with no production changes, so it does not wait for gate 2.
- Stretch goals, only after gate 2 passes ([design.md §3](design.md#3-source-discovery-stretch-goal)): (a) catalog-based source discovery; (b) LLM web-search discovery.
- Documentation and final demonstration.

## 5. Scope boundaries

Outside the course scope:

- Sign-in providers other than Google and public email/password sign-up
- Per-user source subscriptions (all approved sources are shared)
- Video transcripts, podcasts, and research papers (videos are supported through YouTube channel feeds, metadata only)
- Autonomous web crawling
- Collaborative filtering, learned ranking models, bandit algorithms (possible later upgrades)
- Separate "For You" / "Discover" modes (covered by exploration slots)
- Bookmarks as a separate signal (treated as a like)
- Production-scale hosting

The content data model should stay generic enough to add other media types later.

## 6. Schedule

About 19 hours per week over 7 weeks. Most code is written by AI agents, so implementation may run ahead of these estimates; when a spec finishes early, the next one starts immediately and saved time goes to the stretch goals.

### Phase 1 — Prototype

| Week | Dates          | Focus                                                                                                                                                                                                                                   | AI tool support                                       | Hours |
| ---- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----- |
| 1    | 26 Oct – 1 Nov | Project setup (Next.js, Supabase CLI, pgvector), Google OAuth configuration, start ingestion (fetch, parse, fixtures), LLM model choice, plan polish; **plan submitted** (deadline 8 Nov)                                               | Research, scaffolding, parser drafts                  | 16    |
| 2    | 2 – 8 Nov      | Finish ingestion and embeddings, **hourly ingestion with GitHub Actions** (moved to Vercel Schedules in spec 016), cross-lingual check, **early ranking experiment (gate 1)**, Google login, feedback table with RLS and two-user tests | SQL and test drafts, workflow file, experiment script | 21    |
| 3    | 9 – 15 Nov     | Link list and feedback UI, recommender SQL function, recency, explanations, demo data — **prototype ready**                                                                                                                             | SQL review, component generation                      | 19    |
| 4    | 16 – 22 Nov    | **Record and submit prototype video (22 Nov)**; deployment was finished early, so the remaining time starts the evaluation harness and the Jev experiment (spec 009)                                                                    | Deployment configuration                              | 13    |

### Phase 2 — Final application

| Week | Dates          | Focus                                                                                                                                                                                                                                                                                                                                                                                          | AI tool support               | Hours   |
| ---- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------- |
| 5    | 23 – 29 Nov    | Evaluation harness with protocol safeguards (time-based splits, identical histories, near-duplicate handling, repeated runs); LLM labels and manual agreement check; first validation results; Jev experiment test run and report; **freeze parameters, test-window run, and gate 2** (moved from weeks 6–7, since the ranking was settled by specs 020 and 007); natural-language feed tuning | Metric code, labeling scripts | 19      |
| 6    | 30 Nov – 6 Dec | Exploration slots and diversity; negative-feedback reasons; same-story grouping; optional LLM interest summary and click tracking; source discovery if gate 2 passed                                                                                                                                                                                                                           | Debugging, algorithm review   | 19      |
| 7    | 7 – 12 Dec     | Documentation and final demonstration; **submit final version (13 Dec)**; stretch goals only if gate 2 passed earlier                                                                                                                                                                                                                                                                          | Documentation drafts, tests   | 16      |
| —    |                | Buffer                                                                                                                                                                                                                                                                                                                                                                                         |                               | 12      |
|      |                | **Total**                                                                                                                                                                                                                                                                                                                                                                                      |                               | **135** |

## 7. Development approach

- Iterative: the prototype (week 3) is the first end-to-end version and is extended into the final application.
- AI coding tools (e.g. GitHub Copilot, ChatGPT) assist with scaffolding, repetitive code, tests, debugging, research, and documentation drafts.
- The developer is responsible for architecture decisions, reviewing all generated code, evaluation design, and validating results.
- Documentation distinguishes AI used **in the application** (embeddings, recommender, LLM tasks) from AI tools used **during development**.
- Documentation is written continuously (AI log, design updates at the end of each spec), so the final week is not consumed by writing.

### 7.1 Spec roadmap

Specs are written just in time: the next spec is drafted when the current one reaches its last few tasks, so it reflects what was learned. A spec gets the next free number when it is drafted; 007 is reserved for exploration and diversity, and 011–012 were never used. Workflow and rules are in [AGENTS.md](../AGENTS.md); the template is [specs/\_template.md](specs/_template.md). Weeks are when the spec was drafted and worked on.

**Drafted specs**

| Spec                                                | Content                                                                                         | Week | Status                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---- | -------------------------------- |
| [001](specs/001-ingestion.md)                       | Project setup, ingestion, hourly scheduled run, early ranking experiment (gate 1)               | 1    | Done                             |
| [002](specs/002-auth-feedback.md)                   | Google login, feedback table, two-user RLS tests                                                | 1    | Done                             |
| [003](specs/003-feed-ui.md)                         | Feed UI (buttons, swipe gestures, Seen, undo), recommender SQL function, recency, explanations  | 1    | Done                             |
| [004](specs/004-deployment-access.md)               | Vercel deployment from CI, authenticated access with database RLS                               | 1    | Done                             |
| [005](specs/005-description-enrichment.md)          | Enrich missing descriptions from page metadata and article text; backfill existing items        | 1    | Done                             |
| [006](specs/006-evaluation.md)                      | Evaluation harness, including the cross-lingual check moved from spec 001                       | 2–7  | In progress (test run in week 7) |
| [007](specs/007-exploration-diversity.md)           | Exploration slots and MMR diversity re-ranking; diversity tuned on validation                   | 5–6  | Done                             |
| [008](specs/008-guest-feed-preview.md)              | Cached guest feed preview for signed-out visitors                                               | 2    | Done                             |
| [009](specs/009-description-quality-jev.md)         | Description quality experiment with TypeSafe Jev (optional)                                     | 2–3  | Done                             |
| [010](specs/010-site-wide-metadata-descriptions.md) | Reject site-wide metadata descriptions                                                          | 2    | Done                             |
| [013](specs/013-liked-search.md)                    | Search liked items                                                                              | 2    | Done                             |
| [014](specs/014-agent-readiness.md)                 | Agent readiness                                                                                 | 2    | Done                             |
| [015](specs/015-search-and-trust.md)                | Search discovery and trust pages                                                                | 2    | Done                             |
| [016](specs/016-vercel-scheduled-ingestion.md)      | Hourly ingestion on Vercel                                                                      | 2    | Done                             |
| [017](specs/017-article-thumbnails.md)              | Article thumbnail quality and coverage                                                          | 2    | Done                             |
| [018](specs/018-bound-embedding-inputs.md)          | Bound embedding inputs                                                                          | 3    | Done                             |
| [019](specs/019-bound-ingestion-work.md)            | Bound ingestion and embedding work                                                              | 3    | Done                             |
| [020](specs/020-ranking-tuning.md)                  | Ranking tuning on validation with multi-interest personas; choose the production interest model | 3–6  | Done                             |
| [021](specs/021-natural-language-tuning.md)         | Natural-language feed tuning with per-user LLM limits                                           | 5–6  | Done                             |
| [022](specs/022-hide-source.md)                     | Hide a source; source visibility is separate from topic dislike and Seen                        | 6    | Done                             |
| [023](specs/023-description-style.md)               | AI-generated descriptions state the subject directly; blind old-vs-new comparison               | 6    | Done                             |
| [024](specs/024-sources-page.md)                    | Sources page with on/off switches and one-time AI source descriptions (English)                 | 6    | Done                             |
| [025](specs/025-same-story.md)                      | Same-story handling: covered-story filter and per-page grouping (embeddings only)               | 6    | Draft                            |

**Planned, not yet drafted** (in order; see the cut order in §9)

| Spec      | Content                                                                    | Week |
| --------- | -------------------------------------------------------------------------- | ---- |
| next free | Optional: LLM interest summary and click tracking                          | 6    |
| next free | Source discovery: (a) catalog-based, (b) LLM web search; only after gate 2 | 6–7  |

## 8. Risks

| Risk                                              | Mitigation                                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope grows too large                             | Fixed prototype scope; decision gates and cut order (§9); 12 h buffer                                                                                                                                                   |
| Prototype not ready for the video window          | Prototype ready by 15 Nov; week 4 is slack for re-recording                                                                                                                                                             |
| Final phase is only three weeks                   | Ingestion runs from week 2 so evaluation data is ready; gate 2 is criteria-based and can pass early; documentation written continuously; cut order (§9)                                                                 |
| Recommendations do not clearly beat baselines     | Early ranking experiment in week 2 (gate 1); a rigorous comparison counts as success either way                                                                                                                         |
| Evaluation results inflated                       | Time-based splits, identical feedback histories, near-duplicate exclusion, frozen parameters, repeated runs ([design.md §4.3](design.md#43-protocol-safeguards))                                                        |
| Little real feedback data (few users)             | Persona-based replay evaluation                                                                                                                                                                                         |
| LLM labels are biased proxies                     | Manual agreement check reported overall and for Finnish vs English; different model family possible                                                                                                                     |
| Poor Finnish embedding quality                    | Multilingual model required; tested in week 2                                                                                                                                                                           |
| Small or noisy content pool                       | Add Finnish topic-specific and non-tech feeds; balance by source                                                                                                                                                        |
| Some feed items have no usable description        | Spec 005 tries feed text, page metadata, then an AI summary of extracted article text; unresolved items stay hidden from users                                                                                          |
| RSS feeds unreliable                              | Multiple sources, robust error handling                                                                                                                                                                                 |
| API costs or provider changes                     | Limited LLM use, cached results, model name stored with embeddings                                                                                                                                                      |
| Source discovery too complex                      | Two independent stages, both after gate 2; first cuts                                                                                                                                                                   |
| Jev is weak in Finnish or adds nothing over rules | Per-language success criteria; rules only or an LLM judge are valid outcomes; grouping falls back to an embedding threshold; cut order (§9)                                                                             |
| LLM misreads a natural-language request           | Preferences are shown as structured, editable items before use; per-user limits; no LLM at ranking time                                                                                                                 |
| LLM suggests invented or unsafe URLs              | Every candidate fetched and validated; SSRF safeguards                                                                                                                                                                  |
| Free-tier limits (Vercel, Supabase)               | Ingestion on Vercel Schedules within the five-minute function limit, with bounded work per run and a Supabase lease against overlapping runs; GitHub Actions as manual fallback; 512-dim embeddings; prune old articles |
| Supabase free project pauses when idle            | Scheduled jobs keep it active; check before demos                                                                                                                                                                       |
| RLS mistakes leak another user's data             | Functions use `auth.uid()`, no `user_id` parameters; two-user tests written with each per-user table from week 2                                                                                                        |
| Other users run up LLM costs                      | Shared ingestion AI work (descriptions, embeddings) does not grow with users and has per-run budgets; per-user limits come with the first user-triggered LLM feature; no LLM in request-time ranking                    |

## 9. Decision gates and cut order

**Gate 1 — end of week 2:** the early ranking experiment ([design.md §4.1](design.md#41-early-checks-week-2-spec-001)). If nearest-liked is not at least on par with average-vector and better than newest-first, investigate before building the UI around it; average-vector is the fallback ranking.

**Gate 2 — as soon as its criteria hold (earliest end of week 5, latest end of week 6):** source discovery starts only if all of these hold:

- the core application is deployed and working (ingestion, feed, feedback, recommender);
- the evaluation harness produces validation results and parameters are frozen;
- RLS tests pass.

If gate 2 has not passed by the end of week 6, week 7 goes to the final evaluation run, documentation, and fixes only.

**Gate 2 status (24 Nov, week 5): passed.** The core application is deployed at poimio.cc; parameters were frozen and the one-time test-window run completed on 23 Nov (spec 021 task 0, `evaluation/results/test-5c4b9226….json`); RLS integration tests pass in CI. Source discovery may start after spec 022 and same-story grouping, following the cut order below.

**Cut order** if time runs short:

1. LLM web-search discovery
2. Catalog-based discovery
3. Jev description-quality experiment
4. LLM interest summary
5. Click tracking
6. Same-story grouping
7. Natural-language feed tuning

The minimum acceptable result is: ingestion, personal feed with feedback, the recommender, RLS tests, and the baseline comparison.

**Success definition:** a rigorous, honest baseline comparison is a successful outcome even if the proposed recommender does not beat the baselines; the report then analyzes why.

## 10. Decisions made

- Solo course project, 7 weeks (26 Oct – 13 Dec 2026), 135 hours; may continue as a standalone application.
- Three submissions: plan (8 Nov, 25%), prototype with video (22 Nov, 25%), final version (13 Dec, 50%).
- Link aggregator; clicking opens the original website.
- Multiple users with personal feeds; Google login via Supabase Auth; any verified Google user can sign in.
- Row Level Security on all tables; shared content is read-only for users, per-user data is owner-only.
- RSS/Atom feeds (including YouTube channel feeds) are the content source; articles and videos, metadata only.
- Finnish and English supported from the start.
- Recommender: embedding-based interest scoring (tuned `blend` of nearest-liked and average vector, spec 020) with negative penalty, recency, diversity, and exploration slots.
- Average-vector, newest-first, and random as evaluation baselines.
- OpenAI for embeddings and LLM; LLM used for missing-description summaries, natural-language preferences, interest summary, evaluation labels, and (stretch) web-search source discovery — not for ranking.
- Stack: Next.js on Vercel, Supabase Postgres + pgvector, supabase-js with SQL migrations (no ORM), Supabase Auth. Hourly ingestion runs on Vercel Schedules (spec 016); it ran on GitHub Actions until 7 Nov, and that workflow remains as a manual fallback. GitHub Actions also runs CI.
- Source discovery is a two-stage stretch goal (catalog-based, then LLM web search), attempted only after gate 2; admin-approved sources join a shared pool.
- Optional offline experiment: TypeSafe Jev for description quality, compared with rules and an LLM judge (spec 009); called with plain `fetch`, no SDK.
- Additional AI features chosen for product value and measurability: natural-language feed tuning (LLM) and same-story grouping (embeddings only, no LLM or Jev; Jev was dropped from grouping after spec 009 found it added nothing over simpler rules, see spec 025). Source hiding has a separate spec: _Not interested_ maps to a negative topic signal, **Hide source** maps to source visibility, and _Seen_ maps to no topic signal. Jev as a relevance judge was dropped: the Qwen label set was already final when it would have been added, and Jev is evaluated in spec 009 instead.
- No spec after spec 020 may require bulk manual labeling. Evaluation reuses the existing label set; manual checks are limited to reviewing a few examples (about 10–20 items).
- Cut order: web-search discovery, catalog discovery, Jev description experiment, LLM interest summary, click tracking, same-story grouping, natural-language feed tuning.

## 11. Open decisions

None of these block spec 001; each is decided in the spec that first needs it.

| Decision                                                                                  | Decided in                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM models (price, Finnish quality)                                                       | Decided: `gpt-6-luna` for descriptions (spec 005); local Qwen 3.8 27B via MTPLX for evaluation labels, `gpt-6-luna` as fallback (spec 006)                                                     |
| Parameter values (click weight, $\lambda$, recency decay, slot mix)                       | Defaults in spec 003; tuned and frozen through evaluation in week 6                                                                                                                            |
| How long older but relevant items stay in the feed (possibly longer for videos than news) | Spec 003 (recency defaults)                                                                                                                                                                    |
| More YouTube channels or Finnish technology media in the active set                       | After about a week of ingestion data shows volume per topic                                                                                                                                    |
| Per-user LLM limits (e.g. interest summaries per day, discovery runs per week)            | Decided for preferences: 10 requests per user per rolling 24 hours, counted before the call; a failed call still counts (spec 021). Other LLM-triggering actions remain open until their spec. |
