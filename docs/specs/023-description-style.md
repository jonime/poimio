# 023 — Better AI-generated description style

**Status:** Approved  
**Milestone:** Final (week 6)  
**Depends on:** 005 (description enrichment)  
**Estimate:** 5 h

## Goal

Make AI-generated descriptions state the item's subject or main point directly, instead of narrating the source ("The author describes…", "Artikkelissa käsitellään…"). Prefer "Pi is a minimalist, customizable coding harness" to "The author describes switching to Pi". Keep attribution where it separates claims or opinions from facts, and keep accuracy and the item's language.

## Context

- Current prompt and limits: `SUMMARY_INSTRUCTIONS` in `lib/enrich/coordinator.ts` ([spec 005](005-description-enrichment.md), [design.md §2.5](../design.md#25-llm-usage-limited))
- Embedding input is title plus summary (`lib/embeddings.ts`), so descriptions affect ranking of new items.
- Page fetching and extraction: `lib/enrich/page.ts` (SSRF-safe fetch, Readability)
- Request from the roadmap: [plan.md §7.1](../plan.md) ("AI-generated description style")

## In scope

- A candidate summary instruction, compared with the current one on 24 items (12 Finnish, 12 English) with an automated narration diagnostic and a short blind review.
- Switching production to the candidate only after the user approves the result.

## Out of scope

- Regenerating or re-embedding existing descriptions (see Decisions).
- Changes to the model, output token limit, request budget, retries, length limit, provenance values, or production's metadata-first enrichment order.
- Feed and page-metadata descriptions (only `ai_generated` text changes).
- The frozen evaluation snapshot, labels, and results.
- Jev, an LLM judge, new dependencies, or an interactive review app.

## Design notes

**Candidate instruction** (all existing safety rules stay)

- State the subject or main point directly, as a news-style description; aim for one or two concise sentences, but never drop a needed qualifier to get there.
- Avoid narrating the format: no "The article discusses…", "This post explains…", "The text describes…", "They report…" (without a named actor), "Artikkelissa käsitellään…", "Tekstissä kerrotaan…".
- Attribution takes precedence over that rule. Keep who claims what, uncertainty, negation, and the scope of personal experience, naming the actor when the text does ("The company says…", "The author argues…" for an opinion piece, "Yhtiön mukaan…", "Tutkijat kertovat…"). A personal account stays a personal account, not a general product claim.
- Unchanged: only facts in the text, same language without translating, untrusted input, plain text only, empty output when the text is insufficient. Model `gpt-6-luna`, 200 output tokens, 15 s timeout, 1,000-character limit, `tools: []`, `store: false`.
- Task 1 adds the candidate as a separate constant; the active `SUMMARY_INSTRUCTIONS` stays unchanged until task 2.

**Sample** (read-only, no database)

- Pool: the frozen evaluation snapshot `evaluation/snapshot/items.jsonl`, articles with `summary_origin = 'ai_generated'` (120 Finnish, 122 English from 4 sources at the time of writing). The file is only read.
- Draw: sort the pool by ID, then take 12 per language with a fixed seed using `seededShuffle` (`lib/evaluation-agreement.ts`), round-robin over sources within each language so every source with eligible items is represented.
- `evaluation/description-style/sample.json` stores the seed, the snapshot manifest hash, pool counts per language and source, and the 24 IDs with source and language. It is committed before the first run. Items are never replaced after outputs have been seen.

**Comparison** (`pnpm eval:description-style`)

- Environment: needs only the OpenAI key from the environment; it reads no database and writes none. It refuses to run when `CI` is set.
- Extraction: a small shared helper in `lib/enrich/page.ts` fetches the item URL with the existing SSRF-safe fetch and always returns Readability article text, without the metadata short-circuit. Production enrichment keeps calling the existing function unchanged. An item is eligible when the extracted text is non-empty and not just the title; otherwise it is an extraction failure.
- Each eligible page is extracted once, and the same text is sent with the current and the candidate instruction. Both requests are identical except for `instructions` (a unit test checks this).
- Failure categories, all reported per item: extraction failure, HTTP or timeout error, refusal or empty output (per instruction). Empty output and errors are never counted as narration-free successes. A pair is complete when both outputs are non-empty.
- Per run, the result records the run ID, timestamp, model, hashes of both instructions, and per item the final URL, extraction timestamp, input text digest, and statuses. A second run (after a revision) is a new result file; changed input digests are flagged.
- Reuse: `seededShuffle`, hashing, and the CSV and configured-review helpers (`lib/manual-judging.ts`). Only pair presentation and the metrics are new.

**Narration diagnostic**

- A committed list of anchored, case-insensitive regular expressions with normalization rules (trim, collapse whitespace) in `evaluation/description-style/narration-patterns.json`, matched against the first sentence. English examples: `^(the|this|an?) (article|post|piece|text|story|video|essay)\b`, `^they (report|describe|discuss|explain)\b`. Finnish examples: `^(artikkeli|kirjoitus|teksti|video)(ssa|ssä|lla|llä)?\b`.
- Unit tests include matches and non-matches in both languages, including "Yhtiön mukaan…", "Yle kertoo…", "Tutkijat kertovat…", and "The company says…" (non-matches).
- It is a limited diagnostic; the reviewer flags narration in later sentences.

**Blind review** (24 pairs at most; no labeling beyond this)

- `review.csv` lists, per complete pair, the title, language, item URL, and the two descriptions as A and B in a per-item random order; `key.json` holds the mapping.
- Per pair the user records: preference (A, B, or tie); whether either output states something unsupported (the user opens the URL only where the two descriptions differ in substance); wrong language; later-sentence narration.
- After the review the script reveals the key and writes the summary.

**Targets** (overall and per language)

- At least 20 complete reviewed pairs, at least 10 per language; otherwise the result is inconclusive.
- Narration openings: candidate at most 1, and fewer than the current instruction.
- Preference: (wins + ties) / complete pairs at least 0.80, and wins > losses.
- No pair where the candidate states something the user found unsupported, and no wrong-language candidate output. With 24 items, zero observed errors is a small-sample observation, not proof of accuracy.
- If a target is missed, stop and discuss. At most one revision of the candidate, reported as a second run; both result files are kept.

**Artifacts**

- Committed: `sample.json`, `narration-patterns.json`, and a summary with IDs, statuses, digests, counts, and decisions.
- Gitignored: `review.csv`, `key.json`, and any file containing generated or extracted text. Extracted article text is never written to disk. Quoted examples in docs are chosen by the user.

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — candidate and tooling** (production behaviour unchanged)
   1. Unit tests: the active instruction and production enrichment are unchanged; the candidate contains the direct-subject, format-narration, and attribution-precedence rules; old and candidate requests are identical except for `instructions` (model, token limit, timeout, `tools: []`, `store: false`).
   2. Unit tests: the extraction helper delegates to the SSRF-safe fetch, ignores metadata, rejects empty and title-only text, and production enrichment does not call it.
   3. Unit tests: the sample draw is deterministic for a fixed seed and covers sources round-robin; the script reads no database and refuses to run in CI; failure categories are counted and empty outputs are not successes; A/B order is per-item random with the key stored separately; the narration patterns match and do not match the listed cases; the targets are computed as specified, including the inconclusive case and wins > losses.
   4. `.gitignore` covers the review, key, and text-bearing outputs.
2. **Task 2 — run, review, and decision**
   1. `sample.json` and `narration-patterns.json` are committed before the first run; the comparison runs once, or twice after one revision.
   2. The user's review is recorded; the targets hold, or the user has decided how to proceed.
   3. Only after the user approves, the candidate becomes `SUMMARY_INSTRUCTIONS`; otherwise production stays unchanged.
   4. design.md §2.5 records the style rule, the activation decision, and the result; `docs/ai-log.md` gets an entry following AGENTS.md (the agent asks the user to confirm the model first); plan.md updates the 023 status.
3. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.

## Tasks

- [ ] 1. Candidate instruction, extraction helper, `pnpm eval:description-style` with sample draw, narration diagnostic, blind review files, and metrics; unit tests (criterion 1).
- [ ] 2. Commit sample and patterns, run, user review, activation decision, docs (criterion 2).

## Decisions

- No regeneration of existing descriptions. Old AI-generated descriptions leave the normal feed candidates within 7 days (articles) or 30 days (videos). The Liked page and the embeddings of existing likes keep the old style by design; regenerating would require re-fetching pages and re-embedding for little benefit.
- The comparison measures description quality, not ranking; the frozen evaluation snapshot is only read, so the frozen test-window result is unaffected.
- The sample comes from the frozen snapshot, which already lists every AI-described article, so no database read is needed; production is not read at all.
- The narration check is deterministic and limited to openings; the blind review covers the rest. No LLM judge, so there is nothing new to validate.
- The candidate goes live only after review, so an unapproved instruction never reaches production.
- Cost: about 48 requests per run, well under $0.10 at current `gpt-6-luna` rates.

## Open questions

- None.
