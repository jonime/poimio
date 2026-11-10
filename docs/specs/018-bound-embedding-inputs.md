# 018 — Bound embedding inputs

- **Status:** Done
- **Milestone:** Final
- **Depends on:** [001 — Ingestion](001-ingestion.md)

## Goal

Prevent an oversized feed title from repeatedly failing its embedding batch, including when the item is already stored and pending. This addresses alert #9.

## Design notes

- At the shared request boundary in `lib/embeddings.ts`, trim the summary as before, cap the title at 512 UTF-8 bytes and the summary at 2,400 UTF-8 bytes, and join them with `"\n\n"`. Each cap keeps the longest prefix that fits at a Unicode code point boundary. Stored titles and summaries retain their full text.
- Each input can use up to 2,914 bytes and a batch of 100 can use up to 291,400 bytes. Using UTF-8 bytes as a conservative upper bound on tokens keeps both below the respective limits of 8,192 and 300,000 tokens. [OpenAI embeddings API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
- Preserve eligibility checks, batch order, retries, model version, and return types in both ingestion and embedding recovery. Use existing runtime APIs and leave the database schema as is.

## Out of scope

- Storage limits, ingestion budgets (alert #10), future dates (alert #8), and re-embedding completed items.

## Acceptance criteria

1. Ordinary Finnish and English inputs retain their existing request text.
2. Oversized titles and trimmed summaries are capped independently, so a huge title leaves room for the summary.
3. Exact byte boundaries, accented characters, CJK text, and emoji are handled without splitting a code point or adding an ellipsis.
4. A full batch of 100 oversized inputs stays within the 291,400-byte aggregate budget.
5. A previously stored oversized pending item embeds alongside normal neighbors. A second run skips the successfully embedded items.
6. Existing missing-summary, recovery-selection, ordering, and transient-failure tests pass.
7. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass. The regression tests use mocked embedding requests and an in-memory database fake.

## Tasks

- [x] 1. Bound the shared embedding request inputs, add the regression tests, and run the required checks.

## Post-deployment verification

Check the next normal ingestion run for embedding batch failures and recheck alert #9. Leave dismissal for human review.
