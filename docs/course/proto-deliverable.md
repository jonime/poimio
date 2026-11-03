# Poimio — Prototype

## Short description of what the prototype does.

Poimio is a personal content feed. It collects news, articles, and videos from 17 Finnish and English RSS/Atom/YouTube feeds (Yle, BBC, Hacker News, NASA, and others) and learns each user's interests from feedback. Users sign in with Google; nothing needs configuring.

What works:

- **Ingestion:** an hourly GitHub Actions run fetches, normalizes, deduplicates, and embeds items.
- **AI descriptions:** missing descriptions come from page metadata or a `gpt-6-luna` summary of the article text; cards show the origin.
- **Ranking:** similarity to the closest liked item minus similarity to _Not interested_ items, plus recency, with explanations ("Similar to _X_, which you liked").
- **Cross-language matching:** embeddings favored same-language matches; subtracting each language's mean embedding raised precision@10 from 0.65 to 1.00 (average-vector 0.95, newest-first 0.30).
- **Interaction:** _Like_, _Not interested_, _Seen_, swipes, Undo, infinite scroll, liked page; new users get a source-balanced feed.
- **Security:** Row Level Security with two-user tests; production deploys only after CI passes.

## What technologies did you use?

| Area         | Technology                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| App          | Next.js 16, React 19, Tailwind CSS v4, shadcn/ui; Vercel (poimio.cc)                                                                   |
| Database     | Supabase PostgreSQL + pgvector; ranking in SQL                                                                                         |
| Auth         | Supabase Auth (Google), Row Level Security                                                                                             |
| AI           | OpenAI `text-embedding-3-small` (512 dimensions, language-centered), `gpt-6-luna` for summaries                                        |
| Ingestion    | `rss-parser`, Mozilla Readability + jsdom, SSRF-safe fetching                                                                          |
| Automation   | GitHub Actions: hourly ingestion; CI with lint, typecheck, Vitest unit and database tests; deployment promotion                        |
| AI dev tools | GitHub Copilot agent mode (Claude Opus 5.5, GPT-6.1 Sol, GPT-6 Luna), Codex desktop, local Qwen3 27B (MTPLX) in OpenCode; AI usage log |

## TODO list (list and prioritize what you need to do next)

1. **Evaluation harness:** personas, time-based splits, repeated runs against newest-first, random, and average-vector baselines; Qwen relevance labels checked against TypeSafe Jev and ~100 manual labels; cross-lingual check.
2. **Natural-language feed tuning:** an LLM turns _"less crypto, more local AI"_ into editable preferences used in ranking; per-user LLM limits.
3. **Exploration, diversity, and feedback reasons** (not this topic, not this source, already known).
4. **Same-story grouping:** embeddings find candidates; Jev separates same event from follow-ups.
5. **Tuning:** tune on validation data; freeze before the final test run.
6. **Optional:** Jev description-quality experiment, interest summary, click tracking.
7. **Stretch:** source discovery (catalog, then LLM web search; admin-approved).
8. **Final documentation and demonstration.**

## Update the weekly schedule

Implementation ran well ahead of plan: all prototype features were done in week 1, mostly by AI agents following specs.

| Week | Work                                                                           | Status  |
| ---- | ------------------------------------------------------------------------------ | ------- |
| 1    | All prototype features; plan submitted                                         | Done    |
| 2    | Evaluation harness; guest feed preview; Jev description experiment             | Planned |
| 3    | Prototype video; relevance labels (Qwen, Jev, manual); natural-language tuning | Planned |
| 4    | Submit prototype (22 Nov); exploration, diversity, feedback reasons            | Planned |
| 5    | Same-story grouping; validation results and tuning; gate 2                     | Planned |
| 6    | Freeze parameters; optional features; source discovery if gate 2 passed        | Planned |
| 7    | Final evaluation run, documentation, demonstration; submit (13 Dec)            | Planned |

The time-based split needs at least two weeks of content; ingestion has run hourly since 28 Oct.

## Links

GitHub repository: https://github.com/jonime/poimio/tree/prototype

Prototype video: https://www.youtube.com/watch?v=0VndVQhf-Ag

Deployed application: https://poimio.cc
