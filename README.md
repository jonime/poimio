# Poimio

Poimio is an AI-powered personal content discovery app. It collects news, articles, and videos from Finnish and English RSS/Atom/YouTube feeds and learns what each user is interested in from simple feedback (_Like_, _Not interested_, clicks). The feed is a list of links; clicking an item opens the original site.

> **Status:** Planning complete. Implementation starts with [spec 001](docs/specs/001-ingestion.md).  
> Solo project for an AI course (7 weeks, 135 h): plan due 8 Nov, prototype with demo video due 22 Nov, final version due 13 Dec 2026.

## How it uses AI

- **Multilingual embeddings** represent every item, so interests transfer between Finnish and English content.
- **Recommender:** each item is scored by its similarity to the closest item the user liked, minus similarity to items marked _Not interested_, combined with recency, diversity, and exploration. Every recommendation is explained ("Similar to _X_, which you liked").
- **LLM tasks:** readable interest summaries, source discovery with web search (stretch goal), and relevance labels for evaluation. The LLM does not rank items.
- **Evaluation:** replay tests with simulated users against newest-first, random, and average-vector baselines.

## Tech stack

Next.js (App Router, TypeScript) on Vercel · Supabase Postgres + pgvector · Supabase Auth (Google) with Row Level Security · OpenAI embeddings and LLM · GitHub Actions for scheduled ingestion · Vitest

## Documentation

| Document                         | Contents                                                    |
| -------------------------------- | ----------------------------------------------------------- |
| [docs/plan.md](docs/plan.md)     | Goals, deliverables, scope, schedule, risks, decisions      |
| [docs/design.md](docs/design.md) | Architecture, recommender, evaluation, security, data model |
| [docs/feeds.md](docs/feeds.md)   | Feed catalog                                                |
| [docs/specs/](docs/specs/)       | Feature specs (spec-driven development)                     |
| [docs/ai-log.md](docs/ai-log.md) | Log of AI-assisted development work                         |
| [AGENTS.md](AGENTS.md)           | Instructions for AI coding agents                           |

## Getting started

Copy `.env.example` to `.env.local` and set the local Supabase URL, anon key, service-role key, and OpenAI key as needed. Keep the service-role and OpenAI keys server-side; never expose them through `NEXT_PUBLIC_` variables.

For cloud work, keep production values in the separate, gitignored root file `.env.production.local`. The `pnpm` scripts currently load `.env.local`, so they do not switch to production automatically. To deliberately run a Node script with production credentials, pass the file explicitly, for example:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
	--experimental-strip-types \
	--env-file=.env.production.local scripts/ingest.mts
```

That ingestion command writes to the selected database. Confirm the target project before running it; use production for read-only checks unless a production write is explicitly intended. Never print or commit either environment file.

## Manual relevance judging

Label an exported agreement CSV interactively, without any API or database access:

```sh
pnpm eval:judge evaluation/agreement/provisional/selection.csv
```

Each record shows its persona, title, and summary. Enter `1`/`y` for relevant,
`0`/`n` for not relevant, `s` to skip, or `q` to quit, followed by Enter.
Each answer is saved immediately; rerunning the command skips existing labels
and resumes blank cells. Only the `relevant` field changes: quoting, line endings,
and all other CSV content are preserved. The CSV must contain `persona_id`,
`persona_description`, `title`, `summary`, and `relevant` columns.

## Database integration tests

Start the local Supabase stack and apply migrations before running the database-backed tests:

```sh
supabase start
supabase db reset
pnpm test:integration
```

`supabase db reset` deletes local database data and auth users before reapplying migrations. The integration command does not reset the database; it verifies that the local Supabase API and, when present, `.env.local` target this project's local ports, obtains test keys from the local CLI process without displaying them, and fails if the tests are skipped. It never targets a linked or hosted project. The ordinary `pnpm test` command remains hermetic and skips the database-backed tests.

CI starts only PostgreSQL, Auth, PostgREST, and Kong. The integration job excludes unused containers and disables Storage and Realtime through environment overrides so their one-shot database initialization jobs are also skipped. It disables local SMTP and Google OAuth because tests create confirmed email/password users through the local Auth admin API. CI opts into Supabase CLI slim images for catalog-pinned services; Kong and one-shot migration images may remain upstream images. Supabase starts in the background while Node and pnpm are configured and dependencies are installed; CI waits for startup to finish before running tests. Fresh startup applies all migrations, including the source seed migration; no additional reset is needed. The full local development stack is unchanged.

## Google sign-in setup

This configures OAuth for spec 002's Google login page and application callback route. The app runs locally at `http://localhost:3001`.

### Google Cloud

1. Select or create a project in [Google Cloud Console](https://console.cloud.google.com/), then open **Google Auth Platform**.
2. Configure **Branding** with the app name and support/developer email. In **Audience**, choose **External**, keep the publishing status **Testing**, and add each permitted Google account under **Test users**. Do not publish the consent screen during the course.
3. In **Data Access**, configure only `openid`, `userinfo.email`, and `userinfo.profile`; no additional Google API scopes are needed.
4. In **Clients**, create an OAuth client of type **Web application**. Add `http://localhost:3001` and `http://127.0.0.1:3001` as **Authorized JavaScript origins**.
5. Add `http://127.0.0.1:55321/auth/v1/callback` as an **Authorized redirect URI**. This repository uses Supabase API port **55321**, not the CLI default 54321. For hosted Supabase, also add the exact callback URL shown by that project's Google provider settings, usually `https://<project-ref>.supabase.co/auth/v1/callback`.
6. Store the client ID and secret privately as described below. Never paste the secret into chat, tracked files, or a `NEXT_PUBLIC_` variable. Separate OAuth clients for local and hosted Supabase can be used to keep credentials separate.

### Local Supabase

The Supabase CLI reads `env(...)` references in [supabase/config.toml](supabase/config.toml) from shell variables or a root `.env` file. It does **not** load Next.js's `.env.local`. Create the gitignored root `.env` with just the OAuth values from your local-development Google web client:

```dotenv
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET=your-client-secret
```

Do not copy production Supabase credentials into this file or `.env.local`. Keep the app's local Supabase URL and keys in `.env.local`; the URL is `http://127.0.0.1:55321`. The variable names are also listed in [.env.example](.env.example). Email/password authentication stays enabled for local automated tests and the local-development sign-in form described below.

With Docker running, apply the auth configuration by starting (or restarting) the local stack:

```sh
supabase stop
supabase start
pnpm dev
```

Stopping without `--no-backup` preserves local data; do not use `supabase db reset` just to change OAuth configuration. CLI startup/status output can contain local keys, so do not paste it into chat or logs. If OAuth credentials are missing, configure them before starting the stack. For database-only automated testing without Google, temporarily supply non-secret placeholder values through the shell; these do not enable real Google sign-in.

Open the app at `http://localhost:3001` and use the same hostname throughout each sign-in attempt; mixing `localhost` and `127.0.0.1` loses the app's PKCE verifier cookie. The configured app callback allowlist covers both hostnames, without wildcards. If you change the app port, update both the Supabase redirect allowlist and the Google client origins.

There are two distinct callbacks:

| Redirect                         | URL                                                                     |
| -------------------------------- | ----------------------------------------------------------------------- |
| Google to local Supabase Auth    | `http://127.0.0.1:55321/auth/v1/callback`                               |
| Supabase Auth to the Next.js app | `http://localhost:3001/auth/callback` (or the matching `127.0.0.1` URL) |

Google's authorized redirect URI must be the **Supabase** callback, not the Next.js `/auth/callback`. Leave **Skip nonce check** disabled for the web OAuth flow.

### Hosted Supabase

Local CLI configuration does not configure the hosted project. Perform these steps manually in the intended [Supabase Dashboard](https://supabase.com/dashboard); do not run a remote config push as part of local setup.

1. Confirm the project reference, then open **Authentication > Sign In / Providers > Google**. Enable Google and enter the web client ID and secret for that environment. Keep nonce checking enabled and email required.
2. Copy the provider's displayed callback URL into the matching Google Cloud web client's **Authorized redirect URIs**. It is the hosted Supabase callback, not the local one.
3. For testing the local app against hosted Auth, set **Authentication > URL Configuration > Site URL** to `http://localhost:3001` and add the exact app redirect URLs `http://localhost:3001/auth/callback` and `http://127.0.0.1:3001/auth/callback`. Keep the Google consent screen in **Testing** with explicitly listed test users.
4. Keep hosted app credentials in the ignored `.env.production.local`, separate from local credentials. The normal `pnpm dev` flow uses `.env.local`; do not swap its contents to test hosted Auth. Vercel deployment, selecting the hosted app environment, and production app redirect URLs are deferred to spec 004.

To verify the setup, visit `/` without a session and check that it redirects to `/login`. A listed Google test user should be able to sign in, return to `/`, see their email, and sign out back to `/login`. A Google `redirect_uri_mismatch` error means its registered Supabase callback does not exactly match; a missing PKCE verifier usually means the app hostname changed or its cookie was lost.

References: [Supabase Google Auth](https://supabase.com/docs/guides/auth/social-login/auth-google), [local config and secrets](https://supabase.com/docs/guides/local-development/managing-config), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).

## Local email/password sign-in

For integrated browsers that cannot complete Google OAuth, use a local Supabase account instead:

1. Start local Supabase and confirm `.env.local` uses `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321` with the matching local anon key. Do not use hosted credentials.
2. Open local Supabase Studio at `http://127.0.0.1:55323`. Under **Authentication > Users**, choose **Add user > Create new user**, enter a development-only email and password, and enable **Auto Confirm User**. Do not reuse a real account's password.
3. Run `pnpm dev` and open `http://localhost:3001/login`. Enter those credentials under **Local sign-in**. No email delivery or Google OAuth is required; the normal Supabase cookie session and RLS still apply.

The form and its server action are enabled only when `NODE_ENV=development` and the configured Supabase URL uses HTTP/HTTPS with an exact loopback hostname (`localhost`, `127.0.0.1`, or `[::1]`). Production builds and development against hosted Supabase keep Google-only sign-in. There is no signup UI or auth bypass, and no new environment variables are required. Resetting the local database removes this account, so recreate it in Studio after a reset.

## Deployment

### Application access

Any user who signs in with Google can use the feed; no invitation or email provisioning is required. Authentication remains mandatory. Shared content is read-only for authenticated users, and feedback remains private to its owner through database RLS. Browsing and feedback do not trigger OpenAI calls; ingestion AI work is shared across users. Per-user usage limits must ship with the first user-triggered AI feature.

The removal migration drops `allowed_users` and removes its policy and RPC checks. It temporarily retains `is_allowed()` as an authenticated identity check so the previously deployed app continues working when migrations arrive before the new app. The new app does not call it. Remove this compatibility function only in a later migration after the new app is deployed.

### Hosted Supabase Auth

In the hosted Supabase Dashboard, verify the project before changing settings:

- Enable Google as the only sign-in provider; disable Email, including public email/password sign-up.
- Set the Site URL to the production Vercel URL.
- Allow the production app callback and `http://localhost:3001/auth/callback` as redirect URLs.
- For open Google sign-in, publish the Google OAuth app with an External audience to Production in Google Auth Platform. Testing mode still limits sign-in to Google's configured test users, even though the application no longer has an allowlist. Complete any Google verification requirements shown for the configured scopes.
- Confirm the Supabase GitHub integration targets this repository and `main`, and that its migration history includes the latest committed migrations.
- Verify a direct email sign-up request to the hosted Auth API is rejected.

### Vercel and GitHub Actions

Configure only these public variables in the Vercel production environment:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Do not configure `SUPABASE_SERVICE_ROLE_KEY` or `OPENAI_API_KEY` in Vercel. Disable Vercel Git deployments and preview deployments. On pushes to `main`, GitHub Actions starts a remote Vercel production build in parallel with checks and database integration tests, using `--skip-domain` to keep the current production domain unchanged. Only after all three jobs pass does Actions promote that exact deployment, without rebuilding. Other pushes and pull requests keep the local CI build. Superseded workflow runs are canceled, and promotion skips commits that are no longer the head of `main`. Enable deployment protection for staged deployment URLs, which exist before promotion and use production settings.

Add these repository secrets in GitHub Actions; names only are shown here:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `NEXT_PUBLIC_SUPABASE_URL` (scheduled ingestion)
- `SUPABASE_SERVICE_ROLE_KEY` (scheduled ingestion)
- `OPENAI_API_KEY` (scheduled ingestion)

### Migrations and rollback

The Supabase GitHub integration applies migrations on pushes to `main`, independently of the application deployment. Before pushing a migration, run `supabase db reset` and `pnpm test:integration` locally; integration tests must pass with zero skipped. Keep migrations backward-compatible with the deployed application. Never edit an applied migration.

To roll back application behavior, revert the responsible commit and push to `main`; the normal CI gates must pass before Actions deploys the reverted application. Treat database changes as forward-only: correct an applied migration with a new migration rather than trying to reverse or edit migration history. Confirm the application and database remain compatible before deploying either side.
