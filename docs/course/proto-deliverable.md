# Poimio — Prototype

## Short description of what the prototype does.

Poimio is a personal content feed. It collects news, articles, and videos from 17 Finnish and English RSS/Atom/YouTube feeds (Yle, BBC, Ars Technica, The Verge, TechCrunch, Hacker News, NASA, New Scientist, and others) and learns what each user is interested in from simple feedback. Users sign in with Google; there are no topics or subscriptions to configure.

What works in the prototype:

- **Ingestion pipeline:** every hour, GitHub Actions fetches the feeds, normalizes and deduplicates the items, and converts each item into a multilingual semantic embedding.
- **AI descriptions:** when a feed provides no usable description (e.g. Hacker News links), Poimio first tries the page's metadata, then extracts the article text and has an LLM write a short summary. Each card shows where its description came from.
- **Personalized ranking:** each item is scored by its similarity to the closest item the user has liked, minus its similarity to items marked _Not interested_, plus a recency boost. Every recommendation is explained ("Similar to _X_, which you liked").
- **Cross-language matching:** an early experiment showed that the embeddings favored same-language matches, so unrelated Finnish news crowded out relevant English items. Subtracting each language's mean embedding ("language centering") fixed it: precision@10 of the nearest-liked method rose from 0.65 to 1.00 in a blind-judged comparison against average-vector (0.95) and newest-first (0.30).
- **Interaction:** _Like_, _Not interested_, and _Seen_ buttons, swipe right/left on phones, Undo, infinite scrolling, and a page of liked items. New users get a source-balanced feed of recent items until their first like.
- **Security and deployment:** each user's feedback is protected by Row Level Security with automated two-user tests; production deploys only after unit tests, database integration tests, and the build pass in CI.

## What technologies did you use?

| Area                        | Technology                                                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend and backend        | Next.js 16 (App Router, TypeScript), React 19, Tailwind CSS v4, shadcn/ui (Base UI), lucide icons                                                                                                                                                                       |
| Hosting                     | Vercel (production promoted from GitHub Actions only after CI passes), custom domain poimio.cc                                                                                                                                                                          |
| Database                    | Supabase PostgreSQL with pgvector; ranking as SQL functions; migrations applied by the Supabase GitHub integration                                                                                                                                                      |
| Authentication and security | Supabase Auth (Google), Row Level Security on every table, verified identity in every server action                                                                                                                                                                     |
| Embeddings                  | OpenAI `text-embedding-3-small`, 512 dimensions, with per-language mean centering                                                                                                                                                                                       |
| LLM                         | OpenAI `gpt-6-luna` for summaries of items without a description                                                                                                                                                                                                        |
| Content ingestion           | TypeScript scripts with `rss-parser`; article text extraction with Mozilla Readability and jsdom; SSRF-safe, size- and time-limited fetching                                                                                                                            |
| Automation                  | GitHub Actions: hourly ingestion, CI (lint, typecheck, unit tests, build, database integration tests on a local Supabase stack), deployment promotion                                                                                                                   |
| Testing                     | Vitest unit tests with saved real-feed fixtures; integration tests for ranking, user isolation, and RLS                                                                                                                                                                 |
| AI development tools        | Spec-driven workflow with `AGENTS.md`; GitHub Copilot agent mode (Claude Opus 5.5, GPT-6.1 Sol, GPT-6 Luna), Codex desktop, and a local Qwen3 27B model (MTPLX) in OpenCode for some ingestion tasks; every significant AI-assisted step is recorded in an AI usage log |

## TODO list (list and prioritize what you need to do next)

1. **Evaluation harness (most important for the final grade):** simulated personas, LLM relevance labels checked against ~100 manual labels, time-based data splits, identical feedback histories for every method, near-duplicate exclusion, repeated runs; compare against newest-first, random, and average-vector baselines. Includes the cross-lingual check: whether Finnish–English article pairs about the same event match, with raw and centered vectors.
2. **Exploration and diversity:** reserve part of each page for related-but-unfamiliar and exploratory items, and keep the same story from several sources from filling the list.
3. **Interest summary with per-user LLM limits:** a readable LLM summary of each user's interests. Sign-in is open to any Google account, so limits come with this first user-triggered LLM feature.
4. **Tuning:** tune ranking parameters on the validation data and freeze them before the final test run.
5. **Click tracking** as a weak positive signal (optional).
6. **Source discovery** (stretch goal): first score inactive catalog feeds against user interests, then LLM web search with verification and admin approval.
7. **Final documentation and demonstration**, including the evaluation results and the AI usage report.

## Update the weekly schedule

Implementation ran well ahead of the original plan: all prototype features were finished in week 1, mostly by AI coding agents following specs. The cross-lingual check moved into the evaluation, and the remaining weeks move the final-phase work earlier.

| Week | Dates          | Work                                                                                                                                                                                                            | Status  |
| ---- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1    | 26 Oct – 1 Nov | Setup, ingestion and hourly runs, embeddings, early ranking experiment and language centering, Google login, feedback with RLS, feed UI with gestures, deployment with CI gate, AI descriptions; plan submitted | Done    |
| 2    | 2 – 8 Nov      | Evaluation harness spec and first implementation, including the cross-lingual check                                                                                                                             | Planned |
| 3    | 9 – 15 Nov     | Record the prototype video; LLM relevance labels and manual agreement check; exploration and diversity spec                                                                                                     | Planned |
| 4    | 16 – 22 Nov    | Submit prototype (22 Nov); exploration slots and diversity; interest summary with per-user limits                                                                                                               | Planned |
| 5    | 23 – 29 Nov    | First validation results and tuning; optional click tracking; gate 2 as soon as its criteria hold                                                                                                               | Planned |
| 6    | 30 Nov – 6 Dec | Freeze parameters; catalog-based source discovery if gate 2 passed                                                                                                                                              | Planned |
| 7    | 7 – 12 Dec     | Final evaluation run on the test window; documentation and final demonstration; submit final version (13 Dec)                                                                                                   | Planned |

The evaluation still needs at least two weeks of ingested content for its time-based split; ingestion has run hourly since 28 Oct.

## Links

GitHub repository: https://github.com/jonime/poimio

Prototype video: https://www.youtube.com/watch?v=(not yet)

Deployed application: https://poimio.cc
