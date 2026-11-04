# 010 — Reject site-wide metadata descriptions

**Status:** Draft (for review)  
**Milestone:** Final (small fix)  
**Depends on:** 005 (description enrichment and backfill)  
**Estimate:** about 3 h

## Goal

Stop accepting a site's generic metadata description, such as Yle's "Uutiset nopeasti ja luotettavasti.", as an item's description. Re-enrich the items that already have one, so they get a real description and embedding.

## Context

- Fallback order and backfill: [spec 005](005-description-enrichment.md); [design.md §1](../design.md#1-content-sources-and-representation), [§2.5](../design.md#25-llm-usage-limited), [§6.2](../design.md#62-content_items-shared)
- Found while drafting [spec 009](009-description-quality-jev.md), which keeps these items in its sample as known poor descriptions.

**Verified facts (4 Nov 2026):**

- In the local provisional snapshot (28 Oct – 2 Nov), 42 of the 43 Yle items with `page_metadata` provenance have the summary `"Uutiset nopeasti ja luotettavasti."`. All 42 are `yle.fi/a/…` articles. Their embeddings were computed from this text.
- An affected page (`https://yle.fi/a/74-20253717`) has this text in `og:description`, `twitter:description`, and `description`. The article paragraphs are in the server-rendered HTML.
- [`extractPageContent`](../../lib/enrich/page.ts#L496) returns the first metadata candidate that [`normalizedDescription`](../../lib/enrich/page.ts#L489) accepts. That check only requires the candidate to be non-empty and not link-only, so the boilerplate wins and Readability never runs.
- Completed items never re-enter enrichment. [`runEnrichmentBackfill`](../../lib/enrich/backfill.ts#L104) selects due `pending` items, exhausted items with `--retry-failed`, and completed items missing embeddings.
- The `content_items_enrichment_state_check` constraint allows `pending` only with a null summary and provenance. The unresolved-embedding check requires `pending` rows to have no embedding. Requeuing an item therefore hides it until enrichment succeeds.

## In scope

- A small list of known site-wide descriptions. A metadata candidate on the list is treated as unusable, so the next candidate is tried, then readable text and the AI summary.
- A `--requeue-site-wide` option for `pnpm enrich:backfill` that requeues completed `page_metadata` items whose summary is on the list, then enriches and embeds them in the same run.
- Unit and local integration tests, and design.md updates.

## Out of scope

- Detecting generic descriptions in general, by repetition or with a model. Spec 009 evaluates that.
- Feed-supplied descriptions. Feeds don't contain this text, and spec 005 keeps feed descriptions as they are.
- Site-level descriptions of single external sites (for example Hacker News links such as "Alpine Linux"). These need a judgement, which belongs to spec 009.
- Recomputing the frozen embedding language means. A few dozen changed items do not justify it, and means stay reusable for new embeddings.

## Design notes

**Rejecting known site-wide text**

- `SITE_WIDE_DESCRIPTIONS` in `lib/enrich/page.ts` starts with one entry: `"Uutiset nopeasti ja luotettavasti."`.
- A candidate matches after the existing normalization, case-folding, and removing one trailing period. Whitespace or case variants are therefore also rejected.
- `normalizedDescription` returns `null` for a match, so `extractPageContent` moves to the next candidate. For Yle all three candidates match, so it returns the Readability article text and enrichment creates an `ai_generated` summary. That uses the existing 20-requests-per-run budget.
- New entries need evidence: one verified page and a count from the data. Each entry also needs a unit test.

**Requeuing existing items**

- `pnpm enrich:backfill --requeue-site-wide` selects completed items with `summary_origin = 'page_metadata'` and a summary exactly equal to a listed entry. Stored summaries are already normalized, so an exact match is enough.
- The option works within the existing `--limit` (at most 20), after due and exhausted items, just as `--retry-failed` requeues exhausted items.
- A new `requeueSiteWideDescriptionItems(ids)` adapter method resets matching rows in one guarded update:
  - `summary`, `summary_origin`, `embedding`, and `embedding_model` → null;
  - `enrichment_status` → `pending`;
  - attempt count → 0;
  - last-attempt time, next-attempt time, and error → null.

  It updates only rows that are still `completed` / `page_metadata` with a listed summary, and returns the number of updated rows.

- Requeued items are enriched and embedded in the same run, so they are hidden only briefly. If enrichment fails, the item follows the spec 005 retry policy and stays hidden until it succeeds, like any other unresolved item. Feedback rows are kept.
- `--dry-run` reports how many items match without writing anything. The result report gets a `requeued` count.
- `--requeue-site-wide` and `--retry-failed` can be combined; both share the limit.

**Production rollout**

- Run against production only on your explicit command:
  1. `pnpm enrich:backfill --env production --requeue-site-wide --dry-run`
  2. Then without `--dry-run`, repeated until the dry run reports 0 matches.
- Hourly ingestion picks up the new rule automatically after the code is merged.
- Spec 006: apply before the final non-provisional export (about 11 Nov) so the evaluation snapshot has real descriptions. After the export, the frozen snapshot is unaffected.
- Spec 009: create its sample from the current provisional snapshot before re-exporting it, so these items stay in the experiment.

## Acceptance criteria

1. Unit tests for `extractPageContent`:
   - a page whose three metadata candidates are all the listed text returns no description and the readable article text;
   - a listed `og:description` followed by a usable `twitter:description` returns the latter;
   - whitespace, case, and trailing-period variants are rejected;
   - other descriptions are unchanged.
2. A coordinator unit test shows that a Yle-like page produces an `ai_generated` summary through the injected summarizer, not `page_metadata`.
3. Backfill unit tests:
   - `--requeue-site-wide` is parsed;
   - `--dry-run` reports the matching count and makes no writes;
   - a real run requeues at most the remaining limit after due and exhausted items, then enriches and embeds those items;
   - the report includes the requeued count.
4. A local integration test seeds a completed `page_metadata` item with the listed summary and an embedding, plus non-matching items: a `feed` item with the same text, a different `page_metadata` summary, and a pending item. `requeueSiteWideDescriptionItems` updates only the matching item and leaves it in a valid `pending` state with no summary or embedding. The item is excluded from `get_feed` until a re-enriched summary and embedding are saved.
5. design.md §1 and §6.2 mention the site-wide description rule; spec 005 itself stays unchanged.
6. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; `pnpm test:integration` passes against local Supabase with 0 skipped.
7. After the production rollout (run by you), a dry run reports 0 matching items. The run's summary shows the requeued items' outcomes by provenance.

## Tasks

- [ ] 1. Add `SITE_WIDE_DESCRIPTIONS` and the rejection in `normalizedDescription`; add unit tests (criteria 1–2).
- [ ] 2. Add `requeueSiteWideDescriptionItems` and the selection to `BackfillDb` and the supabase adapter; add the `--requeue-site-wide` option and report count; add unit and local integration tests (criteria 3–4).
- [ ] 3. Update design.md (criterion 5); run lint, typecheck, unit tests, and local integration tests (criterion 6).
- [ ] 4. Production rollout, run by you: dry run, then real runs until 0 matches (criterion 7).

## Decisions

- Use an exact list of verified site-wide texts instead of a general repetition rule: simplest deterministic fix (KISS). A general rule waits for spec 009's results.
- Requeue through the backfill command, not a data migration. The list stays in one place, the change is unit-testable, it supports `--dry-run`, and it runs against production only when explicitly selected.
- Accept that requeued items are hidden while they are re-enriched, rather than adding a new state that keeps the old summary visible.

## Open questions

- None.
