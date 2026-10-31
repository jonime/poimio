# 001 — Project setup, content ingestion, and early checks

**Status:** Done (task 11 moved to spec 006, evaluation harness)  
**Milestone:** Prototype (weeks 1–2)  
**Depends on:** —  
**Estimate:** 21 h

## Goal

Fetch the active feeds, normalize and deduplicate their items, embed them, and store them in Supabase, so that the feed and recommender have content to work with. Also verify early that the embedding model handles Finnish and English well and that nearest-liked ranking is promising (gate 1).

## Context

- Sources and normalization rules: [design.md §1](../design.md#1-content-sources-and-representation)
- Stack: [design.md §5](../design.md#5-technology-stack)
- Security rules: [design.md §5.1](../design.md#51-data-access-and-security)
- Tables: [design.md §6.1–6.2](../design.md#6-data-model)
- Feed catalog: [feeds.md](../feeds.md)

## In scope

- Project scaffold: Next.js (App Router, TypeScript), pnpm, Vitest, ESLint, Supabase CLI linked to the cloud project, `.env.example`, `.gitignore`.
- Migration: enable pgvector; create `sources` and `content_items` with RLS.
- Seed `sources` from feeds.md: the 17 initial feeds active, the rest inactive, Reddit excluded.
- Ingestion command `pnpm ingest`.
- Hourly GitHub Actions workflow running `pnpm ingest`, so content accumulates from week 2 for the evaluation.
- Cross-lingual embedding check script.
- Early ranking experiment script ([design.md §4.1](../design.md#41-early-checks-week-2-spec-001)).

## Out of scope

- Vercel deployment.
- Pruning old items.
- Any UI.
- Fetching linked pages (e.g. meta descriptions for Hacker News).
- Video transcripts.

## Design notes

**Fetching**

- Conditional GET with stored `etag` / `last_modified`; 15 s timeout; 5 MB response limit; identifying User-Agent.
- Feeds are fetched with limited concurrency (e.g. 4).
- A failing source is recorded in `sources.last_error` and does not stop the run.

**Parsing and normalization**

- Supported formats: RSS 2.0, Atom, YouTube Atom (`media:group` / `media:description` / `media:thumbnail`).
- URL normalization: lowercase scheme and host; remove fragment; remove tracking parameters (`utm_*`, `origin`, `at_medium`, `at_campaign`, `fbclid`, `gclid`); keep all other parameters (YouTube `v` must survive).
- Text: strip HTML, decode entities, collapse whitespace; summary truncated to ~1,000 characters.
- Summary source: RSS `description` or Atom `summary`; never full `content` (The Verge includes full HTML with ads).
- Hacker News: the description only contains a "Comments" link, so the summary is empty.
- YouTube descriptions: drop lines containing URLs and known boilerplate (subscribe, social media, affiliate, sponsor lines), then truncate.
- `type` is `video` for YouTube sources, otherwise `article`.
- `published_at`: `pubDate` / `published` / `updated`; falls back to fetch time.
- Deduplication: insert on normalized `url`; on conflict do nothing (first source wins).
- Before insertion, exclude YouTube items whose URL host is `youtube.com` or a subdomain and whose path starts with `/shorts/`. They are not stored or embedded; ordinary watch URLs and other hosts remain eligible.

**Embedding**

- Input: `title + "\n\n" + summary` (title only if no summary).
- `text-embedding-3-small` with `dimensions: 512`; batches of up to 100 items; only rows where `embedding is null`.
- `embedding_model` is stored as `text-embedding-3-small@512`.
- Failed batches stay null and are retried on the next run.

**Secrets**

- `OPENAI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` only in `.env.local` (gitignored) locally and in GitHub Actions secrets for the scheduled run; ingestion is a server-side script.

**Scheduled run**

- GitHub Actions workflow with `schedule` (hourly) and `workflow_dispatch` (manual trigger).
- Concurrency group so two runs never overlap.
- Job timeout (e.g. 15 minutes); the run fails visibly if ingestion throws.

**Cross-lingual check**

- Pick ≥ 10 pairs of the same event from Yle News in English and Finnish Yle feeds, plus random pairs.
- Report cosine similarity for matched vs random pairs; the result is recorded in `docs/ai-log.md` and decides whether the embedding model is kept.

**Early ranking experiment (gate 1)**

- Fixed bilingual sample of ~300 embedded items, saved as a list of item IDs so the experiment is repeatable.
- Two personas, each with ~5 hand-picked liked item IDs (at least one Finnish) stored in a small config file.
- Rank the remaining sample with nearest-liked (λ = 0, no dislikes), average-vector, and newest-first.
- Output the merged, shuffled top 10s as a CSV for blind manual judging; a second step computes precision@10 per method from the judged CSV.
- No database writes; read-only queries with the service role in a local script.

**Language centering (added after the first gate 1 run)**

- The first run showed a language bias: random Finnish–Finnish pairs average cosine 0.232, English–English 0.148, Finnish–English 0.077 (306 items). Nearest-liked therefore pulled unrelated Finnish news from a single Finnish like. See [design.md §1](../design.md#1-content-sources-and-representation).
- Centered vector: `normalize(embedding − mean_embedding[language])`, with per-language means computed from all embedded items at run time and saved with the results, so a run is reproducible.
- The re-run judges only items that were not judged in the first run; existing judgments are reused.

## Acceptance criteria

1. `supabase db reset` applies all migrations cleanly; `sources` and `content_items` exist with RLS enabled.
2. RLS test: an authenticated user can `select` from both tables; an anonymous client cannot read them; an authenticated user cannot insert, update, or delete.
3. Unit tests for URL normalization cover: Yle `?origin=rss`, BBC `?at_medium=RSS&at_campaign=rss`, `utm_*`, fragments, and YouTube `watch?v=` (preserved).
4. Parser tests use saved fixtures from real feeds (Yle RSS, BBC RSS, The Verge Atom, Hacker News RSS, YouTube Atom) and check title, URL, summary, published date, categories, thumbnail, and type.
5. Unit test: YouTube boilerplate removal keeps the descriptive text and drops link/subscribe/affiliate lines.
6. Running `pnpm ingest` twice in a row creates no duplicate items; the second run reports 0 new items for unchanged feeds.
7. A failing feed (mocked 404 or timeout) is recorded in `sources.last_error` while other feeds are still ingested.
8. After a run, every new item has a 512-dimension embedding and `embedding_model` set.
9. `pnpm ingest` prints a per-source summary: fetched, new, skipped (not modified), errors.
10. _Moved to spec 006:_ the cross-lingual check reports results for both raw and language-centered vectors. It passes if at least 9 of 10 matched Finnish–English pairs score above the 95th percentile of random-pair similarities for at least one of them. If both fail, a local multilingual embedding model is compared.
11. The early ranking experiment produces a blind-judging CSV and, after judging, precision@10 for nearest-liked, average-vector, and newest-first per persona; the result and the gate 1 decision are recorded in `docs/ai-log.md`.
12. The GitHub Actions workflow runs hourly and on manual trigger, uses repository secrets only, never overlaps with itself, and a manual run ingests successfully against the cloud project.
13. The gate 1 re-run reports precision@10 per persona for nearest-liked and average-vector on raw and centered vectors (plus newest-first), reusing earlier judgments; the result and the final gate 1 decision (method and whether to center) are recorded in `docs/ai-log.md`.
14. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
15. Ingestion excludes explicit YouTube `/shorts/` URLs before insertion, retains ordinary videos, and does not exclude matching paths on unrelated hosts. Covered by the saved YouTube feed fixture and host-boundary tests.

## Tasks

- [x] 1. Scaffold Next.js + TypeScript with pnpm, Vitest, ESLint; add `.env.example` and `.gitignore`; confirm script names in AGENTS.md.
- [x] 2. Initialize Supabase CLI and link the cloud project; migration enabling pgvector and creating `sources` and `content_items` with RLS.
- [x] 3. Seed migration for `sources` from feeds.md.
- [x] 4. Fetch module (conditional GET, timeout, size limit, concurrency).
- [x] 5. Save feed fixtures; parse and normalize module with unit tests (criteria 3–5).
- [x] 6. Database writes (insert on conflict do nothing, source status updates).
- [x] 7. Embedding module (batching, retry on next run).
- [x] 8. `pnpm ingest` command with per-source summary.
- [x] 9. RLS tests (criterion 2).
- [x] 10. GitHub Actions workflow for hourly ingestion; add repository secrets; verify with a manual run (criterion 12).
- [ ] 11. _Moved to spec 006 (evaluation harness):_ cross-lingual check script for raw and centered vectors; record the result in `docs/ai-log.md`.
- [x] 12. Early ranking experiment scripts (export for blind judging, score judged CSV); record the result and gate 1 decision.
- [x] 13. Gate 1 re-run with language centering: add centered variants to the ranking script, export only unjudged items for blind judging, score, and record the final gate 1 decision (criterion 13).
- [x] 14. Exclude YouTube Shorts during ingestion (criterion 15).

## Decisions

- YouTube Shorts with explicit `/shorts/` URLs are excluded during ingestion; no extra column or duration heuristic. This does not classify Shorts presented as ordinary watch URLs.
- A local multilingual embedding model is compared only if the cross-lingual check fails for both raw and centered vectors (criterion 10).
- Gate 1 is decided on the re-run with centered vectors (task 13), not on the first run alone.
- The cross-lingual check (task 11, criterion 10) moved to spec 006: it needed more Yle Finnish–English pairs than were available when the prototype was finished, and it belongs with the evaluation's cross-lingual retrieval metric ([design.md §4.4](../design.md#44-metrics)).

## Open questions

- None.
