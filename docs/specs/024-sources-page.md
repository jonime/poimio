# 024 — Sources page with switches and AI descriptions

**Status:** Approved  
**Milestone:** Final (week 6)  
**Depends on:** 022 (hidden sources), 005 (OpenAI request conventions)  
**Estimate:** 6 h

## Goal

Replace the Hidden sources page with a **Sources** page that lists every active source with an on/off switch, so users can see what the feed draws from and choose what they want. Each source shows a short English description generated once by an LLM.

## Context

- Hidden sources, actions, and the card menu shortcut: [spec 022](022-hide-source.md), `app/feedback/actions.ts`, `app/(app)/preferences/hidden-sources`
- Header user menu and route lists: `components/user-menu.tsx`, `proxy.ts`
- Sources table and grants: migration `20261028000000_create_sources_and_content_items.sql`; `anon` column grants (`id`, `name`) in `20261103000000_public_guest_metadata.sql` ([AGENTS.md](../../AGENTS.md) public-preview exception)
- LLM request conventions and response validation: `lib/enrich/coordinator.ts`, `lib/preference-tuning.ts` (completed-status checks, 64 KB response limit), [design.md §2.5](../design.md#25-llm-usage-limited)
- Script environment pattern: `scripts/enrich-backfill.mts`; route inventory test: `app/public-representation.test.ts`

## In scope

- A `/preferences/sources` page listing active sources with a switch (on = shown in the feed, off = hidden), replacing `/preferences/hidden-sources`.
- A server action that sets a source's visibility for the caller.
- A `sources.description` column and a script that generates descriptions with `gpt-6-luna`, reviewed by the user before saving.

## Out of scope

- Adding or suggesting new sources (a possible later addition, together with source discovery).
- Per-source statistics such as item counts.
- Descriptions in Finnish or regenerated automatically during ingestion.
- Changes to `get_feed`, ranking, `hidden_sources`, or the card menu's **Hide source** behaviour.

## Design notes

**Visibility**

- The existing `hidden_sources` table is the state: a switch turned off inserts the caller's row, turned on deletes it. No schema change.
- New server action `setSourceVisible(sourceId, visible)` in `app/feedback/actions.ts`, next to `hideSource` and `showSource`:
  - Verifies the user with `getClaims()` and validates the UUID and boolean at runtime; invalid input or no user throws, as the existing actions do.
  - Writes through the user's own client. Users have no `UPDATE` privilege on `hidden_sources`, so hiding is a plain insert that treats a unique violation (`23505`) as success, or an upsert with `ignoreDuplicates: true`; never an upsert that updates. Showing is a delete that ignores a missing row.
  - Returns `{ ok: true, sourceId, visible }` or `{ ok: false, error: "save_failed" }` without database details; it revalidates `/preferences/sources` only on success and never the home feed, as in spec 022.
  - An unknown source ID fails through the foreign key and returns `save_failed`. An inactive source can be hidden, as with `hide_source_of_item`.
- `hideSource` and `showSource` keep their behaviour and revalidate `/preferences/sources`. The card-menu Undo failure toast says "Show it again from Sources."
- Turning every source off is allowed; the feed then shows its existing empty state.

**Sources page** (`/preferences/sources`)

- Like the other settings pages: `export const instant = true`, the `<h1>Sources</h1>` heading and a short subtitle ("Changes apply on the next feed load or refresh.") in the static shell, data inside `Suspense`. The page verifies the user with `getClaims()` itself and redirects to `/login` without one.
- It reads active sources (`is_active`) with `id`, `name`, `language`, `kind`, `description`, and the caller's `hidden_sources`, through the user's client. If either query fails, the page shows a destructive `Alert` instead of the list, so switches never show a wrong state.
- One row per source, sorted by name case-insensitively (ties by `id`): name, a language badge (`fi`/`en`), a "Videos" badge for `kind = 'youtube'` only, the description when present (nothing when absent), and a `Switch` labelled with the source name.
- Each row's switch is optimistic and disabled while its own request runs (with a ref guard against repeated activation); other rows stay usable. On `{ ok: false }` or a thrown error the switch reverts and the row shows an inline error. Changes persist after reload.
- Hidden sources that are no longer active are not listed.
- shadcn/ui: add `Switch` with `pnpm dlx shadcn@latest add switch` (Base UI already includes it; no new npm dependency); compose with existing `Card`, `Badge`, `Field`, `Alert`, `Empty`.

**Route change**

- `/preferences/hidden-sources` redirects permanently to `/preferences/sources` through `redirects()` in `next.config.ts`, which runs before the proxy. The old route directory, `app/(app)/preferences/hidden-sources.tsx`, and their tests are deleted.
- `proxy.ts` session routes, `lib/supabase/clients.test.ts`, the user menu (label "Sources", a source icon such as `RssIcon` instead of `EyeOffIcon`) and its test, the tune page test, and design.md use the new path, so `app/public-representation.test.ts` stays green.

**Source descriptions**

- Migration: `sources.description text` with `check (description is null or (char_length(btrim(description)) > 0 and char_length(description) <= 300))`, and `sources.description_generated_at timestamptz`. The `authenticated` table grant and select policy cover the new columns; the `anon` column grants stay exactly `id, name`, so signed-out visitors never receive either column.
- Script `scripts/describe-sources.mts`, run manually in two steps:
  - **Environment:** `pnpm sources:describe` runs `node --env-file-if-exists=.env.local scripts/describe-sources.mts`. Production runs use `node --env-file=.env.production.local scripts/describe-sources.mts … --production`. The script prints the target Supabase host and, as in `scripts/enrich-backfill.mts`, refuses a non-local Supabase URL without `--production` and a local URL with it. The agent asks the user before any production run.
  - **Generate:** `--out <file>` reads active sources (without a description, or all with `--all`) and writes a review file with `feed_url`, `name`, and the proposed `description` per source. It never writes to the database. Input per source: `name`, host (from `site_url`, falling back to `feed_url`), `language`, `kind`, and up to 20 most recent item titles by `published_at`, each trimmed to 200 characters. A source with no items is skipped with a warning.
  - **Request:** `gpt-6-luna` via the Responses API with plain `fetch`, `reasoning: {effort: "none"}`, `store: false`, `tools: []`, at most 120 output tokens, 15 s timeout, response body at most 64 KB. Instruction: one or two plain English sentences on what the source covers (a news site or a video channel), based only on the given fields and titles; no praise, ratings, or claims about reliability. Titles are passed as delimited untrusted data, never instructions.
  - **Validation:** reuse the checks in `lib/preference-tuning.ts`: `status === "completed"`, no `error`, completed `output_text` items only. Collapse whitespace, then require 1–300 characters. A failed source is reported, the others continue, and the exit code is non-zero.
  - **Apply:** `--apply <file>` validates the reviewed file and writes exactly those descriptions with `description_generated_at`, matched by `feed_url` (source IDs differ between local and production), with the service-role client. It makes no LLM call. Unknown `feed_url`s are reported and skipped.
- Review: the user reads, and may edit, the generated file for all active sources (about 17) before applying it. The same file is applied locally and, with approval, in production. The file is gitignored. There is no other labeling.
- Cost: one request per source, well under $0.01 for all sources.

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — page and visibility**
   1. Unit tests for `setSourceVisible`: rejects unauthenticated calls, invalid IDs, and non-boolean values; writes through the user's client without an updating upsert; returns the specified results; revalidates `/preferences/sources` only on success and never the home feed.
   2. Integration tests in `lib/hidden-sources.integration.test.ts` (local Supabase): hiding twice and showing twice succeed; an unknown source ID fails without a row; another user's rows are unaffected.
   3. Page and component tests: redirect to `/login` without a user; a failure of either query shows the error alert; only active sources are listed, sorted case-insensitively; the "Videos" badge appears only for YouTube sources and nothing is shown when a description is absent; switches reflect hidden sources; rapid repeated activation sends one request; a pending row does not disable other rows; failures revert with an inline error; the empty state. The page works with keyboard and on phone and desktop widths.
   4. `/preferences/hidden-sources` returns a permanent redirect to `/preferences/sources`; the old route and component are removed; the user menu, `proxy.ts`, revalidation paths, Undo toast text, and their tests use the new path and label; `app/public-representation.test.ts` passes.
2. **Task 2 — descriptions**
   1. `supabase db reset` applies the migration. Integration tests in the existing suites (`lib/guest-feed.integration.test.ts`, run by `pnpm test:integration`): `authenticated` can read both new columns; `anon` gets a permission error for `description` and `description_generated_at`; the check constraint rejects blank and over-300-character values.
   2. Unit tests with mocked `fetch`: the request has the specified model, limits, `store: false`, and `tools: []`; inputs use the host fallback, include `kind`, and cap titles; sources without items are skipped; non-completed, errored, empty, and over-long outputs are rejected and leave nothing to apply; one failure does not stop the others and sets a non-zero exit code; `--out` writes no database rows; `--apply` writes exactly the file's text matched by `feed_url` with no OpenAI call; the environment guard refuses mismatched targets.
   3. The user has reviewed the generated file; it is applied locally and, with the user's approval, in production.
   4. design.md §2.5, §5.1, §6, and §7 describe the script, the columns, and the page; plan.md marks 024 Done and §3 notes the one-time source descriptions; an AI log entry follows AGENTS.md (the agent asks the user to confirm the model first).
3. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.

## Tasks

- [ ] 1. `setSourceVisible`, Sources page with switches, redirect, old route removal, path and copy updates, tests (criterion 1).
- [ ] 2. Description columns, `describe-sources.mts` with `--out` and `--apply`, review and apply, docs (criterion 2).

## Decisions

- The switch reuses `hidden_sources` instead of a new "enabled sources" table, so `get_feed`, the card menu, and existing rows keep working unchanged.
- Descriptions are generated once per source by a manual script, not on page load or during ingestion: sources change rarely and the text should be reviewed before users see it.
- Generation and writing are separate steps, so exactly the reviewed text is saved, and the same text goes to local and production.
- Descriptions are English only for now, matching the UI.
- The input is the source fields and recent titles from the database; fetching feed or site pages would add network risk for little gain.
- Adding sources stays with source discovery: sources are shared by all users and need admin approval and SSRF-safe validation.

## Open questions

- None.
