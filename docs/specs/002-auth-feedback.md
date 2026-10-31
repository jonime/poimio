# 002 — Google login and feedback storage

**Status:** Done
**Milestone:** Prototype (week 2)  
**Depends on:** 001 (tables `sources`, `content_items`)  
**Estimate:** 8 h

## Goal

Let users sign in with Google and store their per-item feedback (_Like_, _Not interested_, _Seen_) so that only they can read or change it. This is the security foundation for every later per-user feature.

## Context

- Interaction model and actions: [design.md §7](../design.md#7-user-interaction)
- Feedback table: [design.md §6.3](../design.md#63-feedback-per-user)
- Security rules: [design.md §5.1](../design.md#51-data-access-and-security) and [AGENTS.md](../../AGENTS.md)
- Existing RLS test pattern: `lib/rls.integration.test.ts`

## In scope

- `@supabase/ssr` setup: server and browser clients, session refresh on every request, auth callback route, sign-out.
- Login page with a "Sign in with Google" button; app routes redirect to it when there is no session. Local development also offers email/password sign-in against loopback Supabase only.
- Supabase Auth Google provider for local development (`supabase/config.toml`, secrets via `env(...)`) and documented manual steps for the cloud project and Google Cloud OAuth client.
- Migration: `feedback` table with RLS, grants, `updated_at` trigger, and `set_feedback` RPC function.
- Server-side feedback actions: set (insert or replace, via the RPC) and clear (undo), using the signed-in user's session.
- Minimal signed-in page showing the user's email and a sign-out button (placeholder until spec 003).
- Two-user RLS integration tests, schema assertions, and unit tests for input validation and authentication.
- `pnpm test:integration` script that runs the integration tests against local Supabase and fails instead of skipping when the environment is missing.

## Out of scope

- Feed UI, buttons, gestures, undo toast (spec 003).
- Allowlist and per-user usage limits (spec 004).
- Vercel deployment and production redirect URLs (spec 004).
- Click events (spec 007).

## Design notes

**Authentication**

- Follow the installed Next.js version's docs (`node_modules/next/dist/docs/`) for request interception and route handlers; this Next.js version may differ from older `middleware.ts` conventions.
- OAuth callback exchanges the code for a session and redirects to `/`; the `next` redirect target, if supported, must be a same-origin relative path (no open redirect).
- **Verified identity:** authorization decisions use `supabase.auth.getClaims()` (or `getUser()`), never `getSession()` alone, because cookie-derived session data is not verified.
- Request interception (redirect to login) is a convenience only. Every server action and route handler verifies the user itself.
- Google OAuth consent screen stays in Testing mode; only listed test users can sign in.
- Automated tests do not use Google. They create email/password users with the service-role admin API on local Supabase, as `lib/rls.integration.test.ts` already does.

**Feedback table** (see design.md §6.3)

- Primary key `(user_id, item_id)`: one row per user and item; latest action wins.
- `user_id` defaults to `auth.uid()`; FK to `auth.users` with `on delete cascade`.
- `item_id` FK to `content_items` with `on delete restrict`, so future pruning cannot silently remove items that users have rated.
- `kind` (`like`, `not_interested`, `seen`) and `via` (`button`, `swipe`) are `not null` with check constraints (a check alone allows `NULL`).
- `created_at` and `updated_at` are `timestamptz not null default now()`; a trigger sets `updated_at` on update.

**RLS and grants**

- `revoke all` from `anon` and `authenticated`, then grant `select`, `insert`, `delete` and column-level `update (kind, via)` to `authenticated`. Users can change the action on a row but never its `user_id` or `item_id`.
- Four owner-only policies using `(select auth.uid()) = user_id`; `insert` and `update` also use `with check`.

**Write path: `set_feedback` RPC**

- supabase-js `upsert` writes every supplied column (including `item_id`) on conflict, which the column-level `update` grant rejects. Writes therefore go through a database function instead.
- `public.set_feedback(p_item_id uuid, p_kind text, p_via text)`, `SECURITY INVOKER`, no `user_id` parameter:
  - raises an error if `auth.uid()` is null;
  - `insert ... values ((select auth.uid()), p_item_id, p_kind, p_via) on conflict (user_id, item_id) do update set kind = excluded.kind, via = excluded.via`.
- `execute` is revoked from `public` and `anon` and granted to `authenticated` only. RLS and constraints still apply inside the function.
- Undo uses a plain owner-only `delete` on the table; no function needed.

**Server actions**

- `setFeedback(itemId, kind, via)`: verifies the user with `getClaims()`, validates `itemId` as a UUID and `kind` / `via` against the allowed values, then calls `set_feedback`.
- `clearFeedback(itemId)`: verifies the user, validates, and deletes the user's row (undo).
- Both use the request's Supabase session client, never the service role.
- Exposed as Next.js server actions so spec 003 can call them from the UI.

## Acceptance criteria

1. Visiting `/` without a session redirects to the login page; after Google sign-in on local Supabase the user lands on `/` and sees their email; sign-out returns to the login page.
2. `supabase db reset` applies the new migration cleanly. Database assertions verify that `feedback` has RLS enabled, `kind`, `via`, `created_at`, and `updated_at` are `not null`, the timestamps default to `now()`, and inserting `NULL` or an unknown value for `kind` or `via` fails.
3. Two-user RLS tests (users A and B):
   1. A can insert (via `set_feedback`), read, update, and delete A's own rows.
   2. A cannot read, update, or delete B's rows (reads return nothing; writes affect 0 rows or fail).
   3. A cannot insert a row with `user_id` set to B.
   4. A cannot change `user_id` or `item_id` of an existing row.
   5. An anonymous client cannot read or write `feedback` or execute `set_feedback`.
4. Deleting a content item that has feedback fails; deleting a user removes their feedback.
5. Unit tests: `setFeedback` / `clearFeedback` reject invalid UUIDs, unknown `kind` or `via`, missing sessions, and sessions whose claims fail verification, all without calling the database. Actions authorize independently of the page redirect.
6. Calling `set_feedback` twice for the same item leaves one row with the latest `kind` and `via` and a newer `updated_at`; clearing removes it.
7. No service-role key or OpenAI key is imported into any client component or `NEXT_PUBLIC_` variable; no authorization decision relies on `getSession()` alone.
8. After `supabase db reset`, `pnpm test:integration` passes against local Supabase with every integration test executed (0 skipped).
9. `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
10. In development with a loopback Supabase URL (`localhost`, `127.0.0.1`, or `[::1]`, HTTP/HTTPS), the login page also offers email/password sign-in for an existing local user. Successful sign-in establishes the normal cookie session, independently verifies claims, and redirects to `/`; sign-out returns to `/login`. Invalid credentials and connection failures show a generic error. Both the form and its server action are disabled outside development or against non-loopback, missing, or invalid Supabase URLs. No signup UI, auth bypass, service-role use, or hosted-provider changes are added. README documents creating a confirmed local account in Studio.

## Tasks

- [x] 1. Add `@supabase/ssr`; create server/browser client helpers and session refresh following the installed Next.js docs.
- [x] 2. Configure the Google provider for local Supabase; document cloud and Google Cloud setup steps in README (no secrets).
- [x] 3. Login page, auth callback route, sign-out, redirect for unauthenticated requests, and the minimal signed-in placeholder page (criterion 1).
- [x] 4. Migration: `feedback` table, constraints, defaults, trigger, grants, RLS policies, `set_feedback` function (criteria 2 and 4).
- [x] 5. `pnpm test:integration` script (fails if the environment is missing); schema assertions and two-user RLS integration tests (criteria 2, 3, 4, 6, 8).
- [x] 6. `setFeedback` / `clearFeedback` server actions with verified identity, input validation, and unit tests (criterion 5).
- [x] 7. Verify criterion 7; update design.md §6.3 if the implementation differs.
- [x] 8. Add local-only email/password login, tests for the UI and server-side environment restrictions, and local account setup documentation (criteria 9 and 10; scope change approved 30 Oct 2026).
- [x] 9. Add a GitHub link to `https://github.com/jonime/poimio` alongside the privacy policy in the login page footer, matching its styling; `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass (requested 31 Oct 2026).

## Decisions

- Google is the only production/hosted sign-in method in the UI. Email/password sign-in is also available for local development with loopback Supabase, using real Supabase authentication and existing RLS; local users are created in Studio, not through a signup UI (scope change approved 30 Oct 2026).
- Undo deletes the row rather than storing history; the current state is all the recommender needs.
- `item_id` uses `on delete restrict` to protect rated items from future pruning.
- Feedback is written through the `set_feedback` RPC rather than a client-side upsert, so the column-level `update` grant can stay strict.
- Security tests must actually run: `pnpm test:integration` is part of the done criteria, and the existing shared-table RLS tests run in it too.

## Open questions

- None.
