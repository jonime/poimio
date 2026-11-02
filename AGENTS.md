# Agent Instructions

Poimio is a personal content discovery app: it ingests Finnish and English RSS/Atom/YouTube feeds, embeds items, and recommends links per user based on feedback. Solo course project (7 weeks, 135 h; final deadline 13 Dec 2026).

## Documents

- [docs/plan.md](docs/plan.md) — scope, deliverables, schedule, decisions
- [docs/design.md](docs/design.md) — architecture, recommender, security rules, data model
- [docs/specs/](docs/specs/) — feature specs; **read the relevant spec before implementing**
- [docs/ai-log.md](docs/ai-log.md) — log of significant AI-assisted work

## Workflow (spec-driven)

1. Work on one spec at a time, one task at a time, in the order of its task list.
2. Implement only what the spec asks for. If something is unclear or missing, stop and ask instead of guessing; propose spec changes explicitly.
3. Each task is done when its acceptance criteria pass and `lint`, `typecheck`, and `test` pass.
4. Tick off the task in the spec. The human reviews the diff and commits.
5. Significant AI-assisted steps get a short entry in `docs/ai-log.md`. Very small bug fixes and minor tweaks (for example, copy edits, small styling adjustments, or narrowly scoped fixes) do not need an entry; do not ask for a model confirmation for those changes. Before each edit to `docs/ai-log.md`, ask the user to confirm the exact model for that entry. Never infer or reuse a model from earlier messages or existing log entries, including when the model selector is set to Auto. If the user has not confirmed the model for this entry, do not edit the AI log.

## Stack

- Next.js (App Router) + TypeScript, deployed on Vercel
- Supabase Postgres + pgvector; SQL migrations via Supabase CLI; supabase-js / `@supabase/ssr`; no ORM
- Supabase Auth (Google)
- OpenAI: `text-embedding-3-small` (512 dimensions); small GPT model for LLM tasks
- Scheduled jobs: TypeScript scripts run by GitHub Actions
- Tests: Vitest
- UI: shadcn/ui (Base UI, `base-nova` style, lucide icons) + Tailwind CSS v4

## UI (shadcn/ui)

- Before UI work, follow the project skill [.agents/skills/shadcn/SKILL.md](.agents/skills/shadcn/SKILL.md) and its `rules/` files. The shadcn MCP server is configured in `.vscode/mcp.json`.
- Run the CLI with `pnpm dlx shadcn@latest` (`info`, `docs <component>`, `search`, `add <component>`). Check `components/ui/` before adding; fetch the `docs` URLs before using a component you have not used here.
- Components live in `components/ui/` as owned source; theme tokens live only in `app/globals.css`. Use semantic tokens (`bg-primary`, `text-muted-foreground`), never raw palette colors or manual `dark:` overrides.
- Compose existing components (`Card`, `Badge`, `Alert`, `Empty`, `Field`, `ToggleGroup`, `Skeleton`, `Separator`) before writing custom markup. Use `flex`/`gap-*`, not `space-*`.
- This project uses Base UI: custom triggers use the `render` prop, not `asChild`. Toasts use the Base UI `toast` component.
- Never use `--overwrite` on existing components without asking; preview with `--dry-run`/`--diff`.

## Security rules (non-negotiable)

- Every table has RLS enabled. Shared tables: `select` for `authenticated` only, no write policies. Per-user tables: owner-only (`user_id = (select auth.uid())`).
- Every per-user table ships with automated two-user tests (user A cannot read or modify user B's rows) in the same spec that creates it.
- Security integration tests must actually run: a spec that adds them is done only when `pnpm test:integration` passes against local Supabase with 0 skipped.
- Authorization uses verified identity (`supabase.auth.getClaims()` or `getUser()`), never `getSession()` alone. Every server action and route handler checks the user itself; request-level redirects are not authorization.
- Database functions read the user from `auth.uid()`; they never take a `user_id` parameter and run as `SECURITY INVOKER`. Views use `security_invoker = true`.
- The service-role key and OpenAI key are used only in server-side code and scripts; never in client components or `NEXT_PUBLIC_` variables. Never commit secrets; `.env*` files (except `.env.example`) are gitignored.
- Fetching external URLs: http/https only, timeouts, response size limits; block private/internal addresses when the URL comes from users or an LLM.

## Supabase environment selection

- `.env.local` is the default for local development and is loaded by the current `pnpm` scripts. Do not assume it points to the cloud project.
- Keep cloud credentials separately in the ignored root `.env.production.local`; never copy them into `.env.local` or commit either file.
- For a script that should use production, pass `--env-file=.env.production.local` explicitly to Node. Existing package scripts that specify `.env.local` will continue to use local credentials.
- Before database-backed work, confirm which project the selected environment targets. Prefer local Supabase for writes and tests; use production only when explicitly requested and keep analysis read-only unless the user authorizes a write.
- Never print credentials. The Supabase service-role key is server-side only and must not use a `NEXT_PUBLIC_` variable.

## Conventions

- Never edit an applied migration; add a new one.
- Ask before adding a new dependency.
- Keep LLM calls out of request-time ranking.
- Commands: `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Ingestion command: `pnpm ingest` (to be implemented in spec 001, task 8).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
