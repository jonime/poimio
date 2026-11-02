# 004 — Deployment and access control

**Status:** Done
**Milestone:** Prototype (week 4, after the video)  
**Depends on:** 001–003  
**Estimate:** 10 h

**Access update (30 Oct 2026):** The user approved removing invite-only access.
The original implementation below is historical; the amendment at the end of
this spec supersedes its allowlist requirements. Authentication and owner-only
RLS remain mandatory.

## Goal

Make the application available on the internet (Vercel + hosted Supabase) for invited users only, with automated tests — including the security integration tests — gating every production deployment.

## Context

- Stack and free-tier notes: [design.md §5](../design.md#5-technology-stack)
- Security rules: [design.md §5.1](../design.md#51-data-access-and-security) and [AGENTS.md](../../AGENTS.md)
- Existing auth: `proxy.ts`, `app/login/`, `lib/supabase/`, `lib/supabase/local-password-login.ts`
- Existing workflows: `.github/workflows/ingest.yml`, `codeql.yml`
- Plan gate: deployment only after RLS tests pass ([plan.md §4.1](../plan.md#41-prototype-proof-of-concept-due-22-nov))

## In scope

- Allowlist table, `is_allowed()` check, and updated RLS policies so non-invited users can read or write nothing.
- Admin script to add, remove, and list allowed emails.
- _No access_ page for signed-in users who are not on the allowlist.
- CI workflow: lint, typecheck, unit tests, build, and database integration tests on local Supabase in GitHub Actions.
- Production build on Vercel triggered from GitHub Actions in parallel with CI on `main`; promotion only after CI passes.
- Hosted Supabase Auth configuration (Google only, redirect URLs) and a documented checklist.
- Basic security response headers.

## Out of scope

- Per-user LLM usage limits: moved to spec 007, together with the first LLM-triggering user action (interest summary).
- Preview deployments (disabled).
- Content Security Policy (possible later hardening).
- Custom domain (the default `*.vercel.app` domain is used).
- Account deletion UI.

## Design notes

**Allowlist**

- Shared table `public.allowed_users (email text primary key, note text, added_at timestamptz not null default now())`. Emails are stored lowercased; a check constraint enforces `email = lower(email)`.
- RLS: an authenticated user can `select` only their own row (`email = lower((select auth.jwt()) ->> 'email')`); no write grants for `anon` or `authenticated`. Writes only with the service role.
- `public.is_allowed()` — `stable`, `SECURITY INVOKER`, `set search_path = ''`: returns whether the caller's own row exists. Execute granted to `authenticated` only.
- **Enforcement is in the database.** A new migration drops and recreates the existing policies so that every `authenticated` policy also requires `(select public.is_allowed())`:
  - `sources`, `content_items`, `embedding_language_means`: `select`.
  - `feedback`: `select`, `insert`, `update`, `delete`.
- `get_feed` and `set_feedback` raise a clear error when the caller is not allowed (in addition to RLS returning no rows).
- Removing an email revokes access on the next request; existing sessions cannot read or write anything.
- The `(select ...)` wrapper lets Postgres evaluate the check once per query instead of once per row.

**Admin script**

- `pnpm allowlist add <email> [--note text]`, `pnpm allowlist remove <email>`, `pnpm allowlist list`, using the service role.
- Validates and lowercases emails; prints the target Supabase host (never keys) before writing.
- Uses `.env.local` by default; production requires `--env-file=.env.production.local` (see AGENTS.md).

**No access page**

- After verifying the user with `getClaims()`, app pages call `is_allowed()`. A signed-in user who is not allowed is redirected to `/no-access`, which explains that access is invite-only and offers sign-out.
- This is user experience only; authorization stays in the database and server actions.

**Hosted Supabase Auth**

- Google is the only enabled provider; the email provider (and therefore email/password sign-up through the public API) is **disabled** on the hosted project.
- Site URL: the production Vercel URL. Redirect URLs: the production callback and `http://localhost:3001/auth/callback`.
- The local password login stays limited to development against a localhost Supabase URL (`isLocalPasswordLoginEnabled`).
- Google OAuth consent screen stays in Testing mode; the Google test-user list and the allowlist are kept in sync manually.

**CI and deployment**

- `.github/workflows/ci.yml` on push and pull request:
  - Skip the workflow when all changed paths match `docs/**`, `**/*.md`, `.agents/**`, `.github/instructions/**`, `.github/prompts/**`, `.github/agents/**`, or `skills-lock.json`. Workflow files and unknown paths still trigger CI. Before enabling required checks, replace trigger-level filtering with job-level filtering so skipped workflows do not leave required checks pending.
  - **checks** job: `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`; also `build` except on pushes to `main`, where the Vercel build is the build check.
  - **integration** job: Supabase CLI, `supabase start` with unused containers excluded, `pnpm test:integration` (fails if any test is skipped). Keep PostgreSQL, Auth, PostgREST, and Kong. Disable Storage and Realtime through CI-only environment overrides as well as excluding their containers, because `-x` alone does not skip their one-shot database initialization jobs. Disable local SMTP and Google OAuth; tests use confirmed email/password users. Suppress startup stdout so local API keys are not printed. The fresh GitHub-hosted runner has no existing database; start already applies migrations and seeds, so no reset is needed.
  - **vercel-build** job (only on pushes to `main`, parallel with checks and integration): `vercel deploy --prod --skip-domain --yes` builds remotely with production settings without assigning production domains; exports the exact deployment URL.
  - **deploy** job (only on pushes to `main`, needs all three): resolves the exact deployment URL through Vercel's API, verifies the project ID, production target, and ready state, then requests promotion through `POST /v10/projects/{projectId}/promote/{deploymentId}` with the explicit team ID. This avoids the CLI's failing user lookup and does not rebuild. HTTP or validation failures fail the job; a successful response confirms the promotion request, which Vercel may process asynchronously. Both Vercel jobs use `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` repository secrets.
  - Workflow concurrency cancels older runs for the same ref; immediately before promotion, the deploy job also checks that its commit is still the head of `main` and skips stale commits. An ignored-only push during a deployment can also prevent promotion, leaving the previous production version live until the next code deployment.
- Vercel's own Git deployments are disabled (`vercel.json`: `git.deploymentEnabled: false`), so the production domain changes only after CI passes. Staged production builds have unique deployment URLs; deployment protection should restrict access to these URLs.
- Workflow permissions are `contents: read`; third-party actions use pinned major versions as in the existing workflows.

**Migrations**

- Migrations reach the hosted project through the **Supabase GitHub integration** on pushes to `main`, independently of CI. They can therefore be applied before (or without) the app deploy.
- Consequences: run `supabase db reset` and `pnpm test:integration` locally before pushing a migration, and keep migrations backward compatible with the currently deployed app (add first, remove in a later migration).

**Vercel environment**

- Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are configured on Vercel. The deployed app never uses the service-role key or the OpenAI key, so neither is stored on Vercel.

**Security headers** (in `next.config.ts`)

- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` disabling camera, microphone, and geolocation. Vercel adds HSTS.

## Acceptance criteria

Each criterion belongs to one task.

1. **Task 1 — allowlist migration**
   1. `supabase db reset` applies the migration cleanly; `allowed_users` has RLS, the lowercase check, and no write grants for `anon` or `authenticated`; `is_allowed()` is executable by `authenticated` only.
   2. All existing shared-table and `feedback` policies include the allowlist check.
2. **Task 2 — allowlist integration tests**
   1. Existing integration tests add their test users to the allowlist and still pass.
   2. An authenticated user who is not allowed gets no rows from `sources`, `content_items`, `embedding_language_means`, and `feedback`, cannot insert feedback, and gets an error from `get_feed` and `set_feedback`.
   3. Removing a user from the allowlist revokes access immediately; a user can read only their own `allowed_users` row; anonymous clients get nothing.
   4. `pnpm test:integration` passes with 0 skipped.
3. **Task 3 — admin script**
   1. `pnpm allowlist add|remove|list` works against local Supabase, lowercases and validates emails, rejects invalid ones, and prints the target host without keys. Unit tests cover argument parsing and validation.
4. **Task 4 — no access page**
   1. A signed-in user who is not allowed is redirected to `/no-access` and can sign out; an allowed user never sees it. Unit tests cover the redirect decision.
5. **Task 5 — CI workflow**
   1. On a push, the checks and integration jobs run and pass; the integration job fails if any integration test is skipped.
6. **Task 6 — hosted Supabase and Vercel setup**
   1. Hosted Auth has Google enabled, the email provider disabled, and the Site URL and redirect URLs set; a direct email sign-up request to the hosted project's Auth API is rejected.
   2. The Supabase GitHub integration has applied all migrations up to this spec to the hosted project (checked in the dashboard's migration history).
   3. Vercel has only the two public environment variables, and its Git deployments are disabled.
7. **Task 7 — production deployment**
   1. A push to `main` builds remotely on Vercel in parallel with CI and promotes that exact build only after checks, integration, and the Vercel build pass; a failing check blocks promotion. Superseded runs are canceled and stale commits are skipped before promotion.
   2. On the production URL, an allowlisted Google account signs in and sees the personalized feed; feedback works; production responses include the security headers; the local password login form is not shown.
8. **Task 8 — documentation**
   1. README has a deployment section: allowlist commands, hosted Auth checklist, Vercel and GitHub secrets (names only), migration flow through the Supabase GitHub integration, and how to roll back. design.md §5.1 and §6 describe the allowlist.
9. **Every task:** `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; tasks touching the database also pass `pnpm test:integration` with 0 skipped.
10. **Task 9 — non-code CI filtering:** push and pull request triggers use the same non-code exclusions; mixed code and documentation changes, workflow changes, and unknown paths still run CI. The workflow passes `actionlint`; deployment logic stays unchanged.
11. **Task 10 — minimal CI Supabase stack:** only PostgreSQL, Auth, PostgREST, and Kong run; unused Storage and Realtime initialization jobs are disabled. The workflow passes `actionlint`, all four integration suites pass with 0 skipped against a fresh minimal local stack, and local development configuration and deployment gates stay unchanged. Compare startup and integration job durations with the full-stack baseline after CI runs; do not assume a speedup before measuring it.
12. **Task 11 — overlap CI database startup:** start the minimal Supabase stack as a tracked background step in the integration job while Node/pnpm setup and dependency installation run, then wait for startup before running tests. The startup wait propagates failures, and the GitHub Actions run passes with 0 skipped. `actionlint` checks all supported syntax; ignore only its two parser diagnostics for GitHub's documented `background` and `wait` fields until actionlint supports them. Record the measured integration-job time against the prior run and note run-to-run variability.

## Tasks

- [x] 1. Migration: `allowed_users`, `is_allowed()`, recreated policies with the allowlist check, explicit checks in `get_feed` and `set_feedback` (criterion 1).
- [x] 2. Integration tests for allowlist enforcement; update existing tests to allowlist their users (criterion 2).
- [x] 3. `pnpm allowlist` admin script with unit tests (criterion 3).
- [x] 4. `/no-access` page and redirect (criterion 4).
- [x] 5. `ci.yml` with checks and integration jobs (criterion 5).
- [x] 6. Hosted Supabase Auth configuration, verify migrations applied by the GitHub integration, Vercel project and secrets (criterion 6).
- [x] 7. Deploy job, `vercel.json`, security headers; verify production end to end (criterion 7).
- [x] 8. README deployment section; update design.md §5.1 and §6 (criterion 8).
- [x] 9. Skip non-code-only CI runs using trigger path exclusions (criterion 10).
- [x] 10. Reduce CI Supabase to the services required by the existing integration tests (criterion 11).
- [x] 11. Overlap minimal Supabase startup with Node/pnpm setup and dependency installation (criterion 12).

Task 10 validation: `actionlint`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` passed (204 unit tests; two existing image lint warnings). All four integration suites passed on a fresh disposable minimal Supabase stack (32 tests, 0 skipped); exactly PostgreSQL, Auth, PostgREST, and Kong were running. The disposable project used separate API/database ports, so the suites ran directly through Vitest rather than through the repository runner's fixed-port guard. Existing development stacks were left running. GitHub Actions timing comparison remains pending.

Task 11 validation: `actionlint` 1.7.12 passed with only its two `background`/`wait` parser diagnostics ignored. Lint, typecheck, and 290 unit tests passed; the corrected GitHub Actions run 41426891409 passed with 43 integration tests and 0 skipped. The first push failed before jobs were created because the background step had accidentally been placed in `checks` while `integration` referenced its step ID; moving startup into the integration job fixed it. The integration job took 68s, compared with 77s in run 41424125769 (9s lower in this single-run comparison). Supabase startup itself took 47s versus 44s, so this is not evidence that startup became faster; the total-time difference is subject to runner variability.

## Decisions

- Access is enforced in the database (RLS + `is_allowed()`), not only in the app; the _No access_ page is user experience.
- The allowlist is keyed by lowercased email from the verified JWT.
- Vercel stores no secret keys; the deployed app uses only the public Supabase URL and anon key.
- Production builds run remotely on Vercel in parallel with CI, triggered by GitHub Actions; production domains are promoted only after CI passes. Vercel Git deployments and previews are disabled.
- Per-user LLM limits move to spec 007, where the first LLM-triggering user action is built.
- Migrations are applied by the Supabase GitHub integration, not by the deploy job; migrations stay backward compatible with the deployed app.
- The default `*.vercel.app` domain is used.

## Open questions

- None.

## Amendment: remove invite-only access (30 Oct 2026)

The user approved removing the application allowlist. The original implementation
above is historical; the following requirements supersede its invite-only rules.
Google authentication remains required, shared tables remain read-only for
authenticated users, and feedback remains owner-only under RLS. No request-time
AI calls are introduced.

### Acceptance criteria

- A new migration removes email-based checks from shared-table and feedback
  policies and from `get_feed` and `set_feedback`, without changing ranking.
- Remove `allowed_users`. Keep `is_allowed()` temporarily as an authenticated
  identity check so the previously deployed app works when migrations land first.
- All verified users can enter the app without an access-check RPC. Remove the
  no-access page and allowlist CLI, command, and tests.
- Integration users require no provisioning beyond authentication. Tests prove
  shared reads and feed/feedback RPCs work, anonymous access remains denied, and
  two-user feedback isolation is preserved.
- Documentation explains open Google sign-in and the external OAuth publishing
  step. No production settings or data are changed as part of local verification.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and local
  `pnpm test:integration` pass with 0 skipped integration tests.

### Tasks

- [x] 10. Remove database allowlist enforcement in a rollout-compatible migration
      and update security integration tests.
- [x] 11. Remove application allowlist checks, no-access UI, and CLI; update docs
      and run the required validation gates.

## Amendment: public privacy policy (31 Oct 2026)

Approved by the user. Google sign-in remains the production login method.

### Acceptance criteria

- `/privacy` is accessible without authentication, with a descriptive page title,
  the existing Poimio branding, and a return link to sign in.
- The policy names Joni Mertoniemi as operator and uses `privacy@poimio.cc` for
  privacy and deletion requests. Account and feedback data are retained until
  deletion is requested; no automatic expiry or deletion UI is promised.
- Describe current account and feedback processing, recommendation purposes,
  legal bases, providers, external thumbnails and links, necessary cookies,
  retention, privacy rights, and international processing without presenting
  planned AI features as implemented.
- The login page links to the policy. Only the exact `/privacy` pathname is made
  public; neighbouring paths and existing authenticated routes remain protected.
- Existing auth tests cover anonymous policy access, protected neighbouring
  routes, the login link, and policy rendering without user-data queries.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass. No production settings,
  database changes, new dependencies, or login-method changes are included.

### Tasks

- [x] 12. Add the public privacy page and login link, update proxy access and
      existing auth tests, and run the validation gates.

Task 12 validation: lint, typecheck, and all 212 unit tests passed; 30 database
integration tests were skipped by the normal test command and were not needed
for this database-free change. All 87 focused auth/proxy tests passed. Browser
checks at 1280px and 375px confirmed the page title, loaded branding, no horizontal
overflow, and working login/privacy navigation. Policy wording remains subject
to human review before publication; Google OAuth configuration was not changed.
