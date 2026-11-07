# 016 — Hourly ingestion on Vercel

**Status:** In progress\
**Milestone:** Final\
**Depends on:** [001](001-ingestion.md), [004](004-deployment-access.md)

## Goal

Run Poimio's existing feed ingestion hourly on Vercel so short feed windows are less likely to expire between polls. Keep the GitHub Actions workflow available as a manual fallback.

## Context

- [Spec 001](001-ingestion.md) shipped GitHub Actions ingestion with an hourly trigger at minute 17. In the 14 scheduled runs reviewed on 7 November 2026, starts were roughly 4–9 hours apart, and all 14 runs succeeded.
- [Spec 004](004-deployment-access.md) defines the existing CI checks and production promotion process. Vercel applies a static schedule when the deployment becomes current in its environment. [Vercel schedule concepts](https://vercel.com/docs/schedules/concepts)
- Vercel Schedules is in beta and requires team access. Hobby supports hourly schedules with a 15-minute scheduling window and a five-minute function limit with Fluid Compute. [Beta prerequisites](https://vercel.com/docs/schedules/quickstart) · [Schedule limits](https://vercel.com/docs/schedules/limits) · [Function duration](https://vercel.com/docs/functions/configuring-functions/duration)

## In scope

- Declare an hourly production schedule in `vercel.json` with a private Node.js function target.
- Reuse the existing ingestion pipeline and summary logging. Keep the local `pnpm ingest` command.
- Verify production ingestion, switch GitHub to manual dispatch, and document rollback.

## Out of scope

- Changes to feed selection, parsing, enrichment, embedding, or ranking.
- A new queue or deployment pipeline.

## Design notes

- Use `0 * * * *` in UTC. Keep non-production schedules inactive outside isolated tests. Use the existing CI promotion process.
- Confirm the target Supabase project before any database-backed run. Scope the Supabase service-role key and OpenAI key to server-side production use. Keep credentials out of logs and responses.
- Preserve the existing distinction between a source failure, which is recorded while other sources continue, and a thrown ingestion error or failed embedding batch, which marks the run failed.
- Vercel can deliver duplicate or overlapping runs and does not retry failed private function runs. Prevent concurrent scheduled ingestion and make repeat delivery safe. Preserve the existing ability to pick up unfinished work on a later run. [Vercel delivery behavior](https://vercel.com/docs/schedules/concepts#duplicate-runs)

## Acceptance criteria

1. Beta access and Fluid Compute are verified for the Poimio project before introducing a schedule into the production deployment configuration.
2. A Vercel build produces a private function target with no public HTTP endpoint. The production schedule is hourly, and other environments do not ingest into the production database.
3. Local verification covers successful execution, visible failure for a thrown error or failed embedding batch, and safe duplicate or overlapping delivery. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
4. A manual Vercel run and the first automatic hourly run both succeed within the function limit. Vercel execution history shows both outcomes, and source fetch timestamps advance in the intended production Supabase project.
5. GitHub has no automatic ingestion trigger after cutover. The existing workflow file, `workflow_dispatch`, and its credentials remain available. The documented fallback pauses Vercel and lets in-flight work finish before GitHub ingestion starts.

## Tasks

- [x] 1. Verify beta access, Fluid Compute, and the production environment target. Confirm the private function integration and get approval before adding any dependency.
- [x] 2. Add the private ingestion target and static schedule. Verify the build, invocation behavior, and checks locally.
- [x] 3. Scope the ingestion keys to Production in Vercel and apply the lease migration to the verified production Supabase project. Pause GitHub ingestion and wait for any run in progress to finish before verifying the manual and automatic Vercel runs. If verification fails, pause the Vercel schedule, let in-flight work finish, and re-enable the original GitHub workflow.
- [ ] 4. After verification, remove the GitHub cron trigger and re-enable the workflow once the manual-only definition is on the default branch. Record the run evidence and update [design.md](../design.md#5-technology-stack) with the active scheduler and fallback steps. To restore automatic GitHub ingestion, pause Vercel, let in-flight work finish, and restore the previous cron trigger.

## Verification

- The Vercel CLI listed schedules for Poimio, Fluid Compute is enabled, and Vercel's production Supabase URL matches the repository's production environment. The Next.js builder supports function triggers, and the project owner approved `@vercel/schedules`.
- The Vercel build emitted a 300-second Node.js function with only the `schedule/v1beta` trigger, no public route to the function, and the expected hourly schedule. Lint, typecheck, the production build, 389 unit tests, and 62 local Supabase integration tests passed. The integration run had 0 skipped tests.
- At preflight, both ingestion keys also targeted Preview. The handler checks for the Production environment before it uses either key.
- In production, the lease migration was present and both ingestion keys were restricted to Production. The first manual run failed when Vercel's Node.js runtime loaded `jsdom`. Set `NODE_OPTIONS=--experimental-require-module` in the Production environment and rebuild through CI to apply the setting. [Vercel Node.js configuration](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration#experimental-nodejs-require-of-es-module)
- The [CI redeploy](https://github.com/jonime/poimio/actions/runs/42383579816/attempts/2) succeeded. Manual run `schx_7GTMEJM09032PTBFQ4XA5SSXQW` on 7 November 2026 at 16:58 EET succeeded and advanced fetch timestamps for 17 active sources.
- The first automatic run, `schx_4W699ZBEVBGVADSY8EZV6C7WMY`, succeeded on 7 November 2026 at 17:06 EET and advanced fetch timestamps for 17 active sources. GitHub ingestion was paused during both successful runs.
