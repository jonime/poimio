# 005 — Description enrichment

**Status:** Done  
**Milestone:** Prototype  
**Depends on:** 001 (feed ingestion and embeddings), 003 (feed and liked-item views)  
**Estimate:** 10 h

## Goal

Ensure every item shown to a user has a useful description. Enrich items that lack one, including already-ingested items, and keep unresolved items stored but hidden until enrichment succeeds.

## Context

- Content normalization and embedding input: [design.md §1](../design.md#1-content-sources-and-representation)
- LLM responsibilities and safeguards: [design.md §2.5](../design.md#25-llm-usage-limited)
- Shared item data: [design.md §6.2](../design.md#62-content_items-shared)
- User-visible item lists: [design.md §7](../design.md#7-user-interaction)
- Existing ingestion behavior and original scope: [spec 001](001-ingestion.md)
- Feed and liked-item views: [spec 003](003-feed-ui.md)

## In scope

- A three-step fallback for missing or link-only feed descriptions: page metadata, then an AI summary of extracted article text.
- Persisting description provenance and enrichment/retry state.
- Enrichment of new items and database-backed retries of due unresolved items during ingestion, before embedding.
- A resumable command to backfill existing items and regenerate embeddings when descriptions change.
- Hiding items without a completed description from all user-facing item lists and excluding them from ranking.
- SSRF-safe, bounded fetching and bounded LLM usage.

## Out of scope

- Crawling links that do not come from an ingested feed item.
- Fetching content behind authentication, paywalls, or client-side-only rendering.
- Video transcripts, full-text retention, or replacing a description already supplied by a feed.
- Source discovery or per-user, request-time LLM calls.

## Design notes

**Fallback order**

1. Keep a usable RSS `description`, Atom `summary`, or existing YouTube description as `feed` provenance. A link-only description such as Hacker News's “Comments” is treated as missing.
2. Fetch the item's canonical URL and select the first usable metadata description in this order: `og:description`, Twitter description, standard HTML meta description. Normalize candidates to plain text by decoding entities, removing markup, collapsing whitespace, trimming, and applying the existing summary-length limit. A candidate is usable only if the result is non-empty and the original candidate is not link-only. Skip unusable candidates, including empty or whitespace-only values, and continue through the precedence order. Store the selected description as `page_metadata` provenance.
3. If no usable metadata description remains, extract the readable article text and ask the selected small LLM for a concise, factual description in the item's language. Store it as `ai_generated` provenance. The model receives text only, has no tools or URL access, and must not invent facts; untrusted page text is treated as content, not instructions.

If the page cannot be fetched, has no usable metadata or readable text, or summarization fails after retries, leave the description unresolved. Never synthesize a description from the title alone. Do not retain the fetched full page or article text.

**Data and processing state**

- Add `summary_origin` (`feed`, `page_metadata`, `ai_generated`; null while unresolved) and explicit enrichment status, attempt count, last-attempt time, next-attempt time, and a bounded error detail to `content_items`.
- Existing non-empty summaries are classified as `feed`; existing empty summaries start pending. Use database constraints for allowed values and valid state combinations.
- New items are enriched before embedding. Items without a non-empty summary are not embedded and cannot be ranking candidates or signals. Recompute the embedding from `title + "\n\n" + summary` when an enrichment changes the summary; save the changed summary and clear its stale embedding/model together before requesting a replacement embedding.
- Description completion and embedding completion are separate: if embedding fails or the run stops after saving a completed description, preserve that description, provenance, and completed enrichment status. A later ingestion or backfill run retries only the missing embedding, without fetching the page or calling the summarization model again.
- Only items with a completed, non-empty summary may appear in the discovery feed, liked-item list, or any other user-facing item list. Unresolved or exhausted items remain in storage and can re-enter after a successful retry.
- The UI displays a discreet “AI summary” indicator only for `ai_generated`; feed and page-metadata descriptions do not need provenance labels.
- Retry transient failures with bounded backoff and a configured maximum. Exhausted items are not retried on every hourly ingestion run; the backfill command has an explicit option to retry them.
- Every ingestion run selects eligible pending and retryable items from storage whose next-attempt time is unset or due, within the configured per-run budget. This selection is independent of new insertions and feed fetch outcomes: retries still run after `304 Not Modified`, duplicate-only feeds, or feed errors, and for stored items that have left the feed window. Completed descriptions and exhausted items are excluded from enrichment selection.

**Safe page fetching**

- Permit only `http` and `https`. Apply the URL-fetch security rules in [AGENTS.md](../../AGENTS.md): block loopback, private, link-local, and other internal/reserved destinations; validate DNS results and every redirect target; do not forward credentials or feed validators.
- Bind each connection to validated public addresses, without an unchecked second DNS resolution between validation and connection. Preserve the URL hostname for HTTP Host and HTTPS certificate verification/SNI, and apply the same connection-bound validation at every redirect hop. A preflight DNS lookup followed by an independently resolving `fetch()` is not sufficient.
- Enforce a short whole-request timeout, a small response-size cap, redirect limit, supported HTML content types, and bounded concurrency. Do not execute JavaScript.
- Page fetch and extraction failures are isolated per item and must not stop ingestion or backfill. Avoid logging page bodies, secrets, or unbounded remote error text.

**Backfill command**

- Add `pnpm enrich:backfill`, using `.env.local` by default. It selects eligible unresolved items using the same due-time and retry rules as ingestion, plus items with completed, non-empty descriptions but missing embeddings. It applies the same enrichment and embedding logic as ingestion and is safe to resume; completed descriptions need only embedding recovery, not another enrichment attempt.
- Support `--dry-run`, `--limit`, and `--retry-failed`; report counts by outcome and provenance without printing credentials or fetched page text. Production credentials require an explicit environment selection, consistent with [AGENTS.md](../../AGENTS.md).
- Preserve existing ranking experiment files and results. Any later evaluation snapshot must freeze the item text and embeddings it evaluates so a subsequent enrichment run cannot silently change its inputs.

**Dependency and model choices**

- Select and record the summarization model, prompt constraints, and per-run item/token budget before enabling AI summaries in scheduled ingestion. Do not add a package without approval; evaluate a maintained HTML readability extractor and request approval if a new dependency is needed.
- Keep HTML parsing and extraction deterministic; metadata extraction must not call the LLM.

## Acceptance criteria

Each criterion is verified by a test, command, or observable result.

1. The migration applies cleanly. Existing non-empty summaries have `feed` provenance and completed status; empty summaries are pending with no provenance. Invalid provenance/status combinations are rejected.
2. Unit tests cover usable feed descriptions, link-only descriptions, metadata normalization and precedence (`og:description`, Twitter, standard meta), readable-text AI fallback, language-preserving output, empty/unreadable pages, and failure without title-only generation. Empty, whitespace-only, and link-only metadata candidates do not block lower-precedence usable metadata; AI fallback runs when all metadata candidates are unusable.
3. Fetch tests prove that non-HTTP(S) URLs, private/internal IPv4 and IPv6 destinations, unsafe DNS results, and redirects to unsafe destinations are blocked before a request is made. A DNS-rebinding test changes a hostname's answer from public to private between validation and connection and verifies that the connection uses only validated public addresses or fails closed; repeat this check for redirect targets. Timeout, response-size, content-type, and redirect limits are enforced.
4. A failed page fetch or LLM call for one item does not stop other items in the same ingestion/backfill run. Retry state uses bounded backoff, and exhausted items are not retried by every scheduled ingestion run. Tests prove that due stored items are retried after `304 Not Modified`, duplicate-only feeds, and feed errors, including items no longer in the feed window; items whose next-attempt time is in the future are skipped.
5. Ingestion stores the selected summary provenance, creates embeddings only after a non-empty summary exists, and regenerates an embedding after an enriched summary changes. The changed summary and invalidation of the old embedding/model are saved together. Re-running ingestion does not duplicate work or items; completed descriptions with missing embeddings are retried without another page fetch or summarization call.
6. Ranking and every user-facing item list exclude unresolved items, including unresolved items with an old title-only embedding or existing feedback. A successfully enriched item becomes eligible after its embedding is saved.
7. Only AI-generated summaries display the “AI summary” indicator; feed and page-metadata descriptions do not.
8. `pnpm enrich:backfill --dry-run` performs no database writes. A limited run can be interrupted and resumed without duplicating successful work; tests interrupt after a completed description is saved but before its embedding is saved, and simulate an embedding API failure. In both cases the next backfill run selects the item, preserves the description/provenance, and saves only the missing embedding without fetching or summarizing again. `--retry-failed` explicitly requeues exhausted items. The report includes processed, skipped, succeeded, unresolved, and failed counts.
9. Existing ranking experiment exports and result files are unchanged. Any evaluation snapshot created after this spec freezes evaluated text and embeddings.
10. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; `pnpm test:integration` passes against local Supabase with 0 skipped.

## Tasks

- [x] 1. Decide and record the LLM model, prompt/output contract, per-run cost limits, retry policy, and whether a readability dependency is needed; get approval before adding a dependency.
- [x] 2. Add the migration, backfill existing provenance/status, and update design.md §6.2.
- [x] 3. Implement safe bounded page fetching with connection-bound DNS validation, metadata normalization and usable-candidate precedence, readable-text extraction, and focused unit/security tests.
- [x] 4. Implement the staged enrichment coordinator and AI summary request with per-item failure isolation, retry state, and tests.
- [x] 5. Integrate enrichment before embeddings in ingestion, including due-item selection independent of feed outcomes and recovery of completed-but-unembedded items; prevent unresolved items from embedding and ranking; add integration coverage.
- [x] 6. Update all user-facing item lists to hide unresolved items and show the AI-summary indicator; add focused UI tests.
- [x] 7. Implement `pnpm enrich:backfill` with dry-run, limit, resumability including embedding-only recovery, and explicit retry of exhausted items; test it against local Supabase.
- [x] 8. Update design.md §1, §2.5, §6.2, and the relevant security notes; verify existing ranking artifacts remain unchanged.
- [x] 9. Run lint, typecheck, unit tests, and local Supabase integration tests with 0 skipped.

## Decisions

- Description summaries use `gpt-6-luna` with the Responses API, no tools or URL access, at most 20 requests per ingestion run (including retries), 24,000 extracted characters per item, and 200 output tokens per request. The prompt requires concise, factual output in the item's Finnish or English language, treats article text as untrusted content, and forbids unsupported facts; the result must fit the 1,000-character summary limit. At an estimated 6,000 input tokens per request, a full run costs about $0.014 at current standard pricing; this is an estimate, not a hard dollar cap.
- Retry at most three times total, due after 1 hour and 6 hours; exhausted items need an explicit backfill retry. `@mozilla/readability` and `jsdom` are approved for deterministic readable-text extraction.
- Items without a successfully resolved description are hidden from all user-facing item lists; they are not deleted.
- Description provenance is stored, not just a generated/not-generated boolean, so feed, page metadata, and AI summaries can be distinguished.
- Enrichment is shared ingestion work, not a user-triggered or request-time LLM feature.
- Only feed descriptions, page metadata, and summaries generated from extracted article text are valid description sources; titles alone are insufficient.

## Open questions

- None for task 1. The model, budget, retry policy, and readability dependencies are selected and approved.
