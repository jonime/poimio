# 019 — Bound ingestion and embedding work

- **Status:** Done
- **Milestone:** Final
- **Depends on:** [001 — Ingestion](001-ingestion.md)

## Goal

Address alert #10 by limiting the number of items each source can submit and the number of pending items each run can attempt to embed.

## Design

- Accept up to 200 eligible entries per source response. Count duplicate URLs before database deduplication and exclude YouTube Shorts and unusable HTTP(S) URLs. Above 200, reject the source before item writes and record a parse error with the count and limit. Keep the previous successful timestamp and clear both validators so a smaller response can recover.
- Continue with the other sources, enrichment, thumbnails, and pending embeddings. Preserve the existing source error handling and fetch, enrichment, and thumbnail budgets. The insertion bound is 200 times the number of active sources.
- Select at most 200 eligible pending embeddings in one query, ordered by creation timestamp and ID. Apply recovery ID filtering before the SQL limit. A smaller nonnegative integer limit reduces the budget. Invalid limits fail explicitly, and a zero limit or an empty ID selection performs no work.
- Keep the blank-summary check and leave any slots it removes unused. Use batches of up to 100 items. Failed batches consume the selected budget and remain pending, as do rows beyond the limit. Preserve existing recovery and backfill limits, result types, and embedding model metadata.
- Oldest-first ordering does not guarantee equal throughput per source. A source can still supply 200 fresh entries every hour, and the limits do not guarantee completion within the function deadline.

## Out of scope

- Dependencies, migrations, retention, source balancing, and embedding text limits (alert #9).

## Tasks and acceptance criteria

- [x] 1. Bound feed insertion. Verify that exactly 200 eligible entries are accepted after exclusions, 201 entries including repeated URLs reject the entire source, another source succeeds, and later stages still run. Verify that the error clears validators, preserves the previous success timestamp, and that a smaller response recovers.
- [x] 2. Bound embedding work. Verify that 201 pending items are split across runs (100 + 100, then 1), failures stay retryable within the budget, limits validate and clamp, and zero, empty, and blank-summary cases behave as specified. Cover the bounded database query, recovery filtering, and deterministic ties against local Supabase.

Before checking off each task, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:integration`. Confirm that the integration target is local Supabase and that the integration suite reports zero skipped tests.

## Post-deployment verification

Inspect normal ingestion logs for rejected legitimate feeds and embedding progress. Recheck alert #10 and leave dismissal for human review.
