# Poimio — Project Plan

## What is the goal of your project? Give at least 1-2 concrete examples what it can achieve.

A web app that collects Finnish and English news, articles, and videos from RSS/Atom feeds and **learns each user's interests** from feedback; links open the original sites. AI is the core:

- **Embeddings:** multilingual, so topics match across languages.
- **Recommender:** similarity to liked items minus disliked ones, plus recency, diversity, and exploration. Feedback reasons (topic, source, already known) adjust the penalty.
- **Natural-language tuning:** an LLM turns _"less crypto, more local AI"_ into editable preferences for ranking.
- **Same-story grouping:** embeddings find candidates; TypeSafe Jev, a non-generative classifier, tells same events from follow-ups.
- **Descriptions:** `gpt-6-luna` summarizes articles without one; a Jev experiment flags poor descriptions.
- **Evaluation:** simulated users against newest-first, random, and average-of-likes baselines; LLM labels compared with Jev and manual labels.

**Examples:** (1) A user likes English AI articles and dismisses sports; Finnish Yle tech articles also rise, labeled _"Similar to 'X', which you liked."_ (2) A new user types _"more space, no sports"_ and gets a matching feed before any likes.

## What technologies you plan to use? Be as specific as you can.

| Area       | Technology                                                                               |
| ---------- | ---------------------------------------------------------------------------------------- |
| App        | Next.js (App Router, TypeScript) on Vercel; deploys after tests pass                     |
| Database   | Supabase PostgreSQL + pgvector; recommender as SQL functions                             |
| Auth       | Supabase Auth (Google), Row Level Security                                               |
| AI         | OpenAI `text-embedding-3-small` (512 dimensions) and `gpt-6-luna`; TypeSafe `jev-1.14.0` |
| Ingestion  | TypeScript + `rss-parser`, hourly on GitHub Actions; 17 feeds (Yle, BBC, NASA, YouTube…) |
| Evaluation | TypeScript replay scripts; local Qwen 3.8 27B via MTPLX for labels                       |

## What are the risks related to this project e.g. what could make the project fail?

| Risk                                       | Mitigation                                                        |
| ------------------------------------------ | ----------------------------------------------------------------- |
| Scope too large for 135 h solo             | Decision gates, cut order (discovery first), 12 h buffer          |
| No win over baselines, or inflated results | Week-2 experiment; time-based splits, frozen parameters, 10+ runs |
| User data leaks                            | RLS on every table; two-user tests                                |
| Weak Finnish quality (embeddings, Jev)     | Per-language tests; switch model or fall back to embeddings only  |
| API costs or LLM errors                    | Budgets, per-user limits, editable preferences, no LLM in ranking |

## Make a weekly schedule (what each group member does each week and how many hours you think it takes). Plan also the utilization of AI tools.

Solo project, about 19 h per week.

| Week | Work                                                                                                | Hours   |
| ---- | --------------------------------------------------------------------------------------------------- | ------- |
| 1    | Setup (Next.js, Supabase, pgvector, Google login); start ingestion                                  | 16      |
| 2    | Embeddings, hourly ingestion, ranking experiment (gate 1), feedback with RLS; **plan (8 Nov)**      | 21      |
| 3    | Feed UI, recommender, explanations, description enrichment — **prototype**                          | 19      |
| 4    | **Prototype video (22 Nov)**; start evaluation; Jev description experiment                          | 13      |
| 5    | Evaluation (snapshot, personas, Qwen/Jev/manual labels, replay, baselines); natural-language tuning | 19      |
| 6    | Exploration, diversity, feedback reasons, story grouping; freeze parameters (gate 2)                | 19      |
| 7    | Final evaluation, documentation, **final version (13 Dec)**; source discovery if time               | 16      |
| —    | Buffer                                                                                              | 12      |
|      | **Total**                                                                                           | **135** |

**AI tools in development**

- **Spec-driven workflow:** a short spec per feature; GitHub Copilot (agent mode) implements it task by task, running lint, type checks, and tests; I review and commit.
- **ChatGPT / Copilot chat:** research, design review.
- **My role:** architecture, code review (especially security and evaluation), validating results.
