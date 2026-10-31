# Technical Design

Companion to [plan.md](plan.md). Describes _how_ the application works; the plan describes _what_ is delivered and _when_.

## 1. Content sources and representation

The full catalog of candidate feeds is in [feeds.md](feeds.md) (all verified on 27 Oct 2026 except Reddit, which returns HTTP 429). The initial active set is chosen for topic diversity, Finnish + English coverage, and usable descriptions:

| Topic                     | Sources                                                                      | Language |
| ------------------------- | ---------------------------------------------------------------------------- | -------- |
| Finnish news              | Yle Latest, Yle Technology and Economy, Yle Science, Yle Culture, Yle Sports | fi       |
| Finnish news in English   | Yle News in English                                                          | en       |
| World news                | BBC World                                                                    | en       |
| Technology and AI         | Ars Technica, The Verge, TechCrunch, Hacker News                             | en       |
| Security                  | BleepingComputer                                                             | en       |
| Science and space         | New Scientist, NASA News Releases                                            | en       |
| Videos (cars, technology) | Engineering Explained, carwow, Technology Connections (YouTube)              | en       |

Not used initially:

- **Subsets or aggregators that duplicate other feeds:** Yle Main Headlines and Most Read, TechCrunch AI, Techmeme.
- **Paywalled, tabloid, or very high volume:** Helsingin Sanomat, Ilta-Sanomat, Iltalehti, Phys.org, ScienceDaily.
- **Regional or niche:** regional newspapers, SAK, AWS Blog, Finland Today.
- **No usable text:** Nature (empty descriptions), xkcd (image only).
- **Blocked:** Reddit (HTTP 429; requires its API).

The rest of the catalog is stored as inactive sources and can be activated later. Source discovery evaluates these catalog sources before using web search, which is cheaper and safer.

Notes:

- Hacker News items have only a title; Yle items sometimes lack a description. YouTube descriptions contain a lot of boilerplate that is removed before embedding.
- Yle News in English and Finnish Yle feeds often cover the same events, which gives natural test pairs for the week 1 cross-lingual embedding check.
- Feed windows are small (e.g. Yle Latest shows only the 20 newest items, all within a few hours), so ingestion runs **hourly** to avoid missing items.
- The same Yle article can appear in several Yle feeds; it is stored once (unique normalized URL).
- Volume is uneven (Yle publishes far more than the others), so the cold-start feed and exploration slots balance by source.
- URLs are normalized by removing tracking parameters (e.g. `?origin=rss`, `?at_medium=RSS&at_campaign=rss`) and deduplicated on the normalized URL. The same story from several sources (e.g. Verge + TechCrunch + Hacker News) is handled by diversity re-ranking, not deduplication.
- Feed category tags (Yle, Verge, TechCrunch) are stored for diversity measurement and evaluation, not used for ranking.
- Only title, short description, thumbnail, and link are shown; Yle and BBC RSS terms of use are reviewed in week 1.

Representation:

- Each item has a type: _article_ or _video_. Videos come from YouTube channel feeds; only metadata is used (no transcripts). Boilerplate in video descriptions (links, sponsor and subscribe text) is removed before embedding.
- Every item shown to users must have a completed, non-empty summary. Its provenance is `feed`, `page_metadata`, or `ai_generated`; unresolved items remain stored but are hidden.
- Embeddings use exactly `title + "\n\n" + summary`, and are created only after the summary is complete. Enrichment updates the summary and clears any stale vector/model in the same database update. Unresolved items cannot retain embeddings and therefore cannot be candidates or ranking signals.
- The embedding model must be **multilingual (Finnish + English)** so that interests transfer across languages.
- The embedding model name is stored with each vector, so embeddings can be regenerated if the model changes.
- **Language bias:** with `text-embedding-3-small`, texts in the same language are similar just because of the language (random-pair cosine: Finnish–Finnish 0.232, English–English 0.148, Finnish–English 0.077 on 306 items). This favors same-language matches and hurts both nearest-liked scoring and cross-lingual recommendations.
- **Language centering (decided):** subtract the language's mean embedding before comparing. In a first test, random-pair similarity dropped to about 0 for all language pairs and neighbours of a Finnish energy article became topical (including English ones). In the gate 1 re-run ([spec 001](specs/001-ingestion.md), task 13), nearest-liked on centered vectors reached precision@10 1.00 (raw 0.65, centered average-vector 0.95, newest-first 0.30), so ranking uses centered vectors. Means are computed from the corpus and frozen per embedding model ([spec 003](specs/003-feed-ui.md)).

## 2. Recommendation

The core recommender is embedding-based. An LLM is used only for tasks that embeddings cannot handle well.

### 2.1 Interest scoring: nearest liked item

A candidate item is scored by its similarity to the _closest_ item the user has reacted to, not to an averaged profile:

$$
\text{interest}(c) = \max_{p \in P} w_p \cdot \text{sim}(c, p) \;-\; \lambda \cdot \max_{n \in N} \text{sim}(c, n)
$$

- $P$ = positive interactions. Likes have weight 1.0; clicks have a lower weight (e.g. 0.3) because they are a weak signal.
- $N$ = items marked _Not interested_. $\lambda$ controls the strength of the penalty.
- Skipped or ignored items are not used as negative feedback.
- Items marked _Seen_ are hidden from the feed but are neutral: they are neither positive nor negative signals ([§7](#7-user-interaction)).
- Signal precedence per item: explicit feedback overrides clicks. If an item is liked or marked _Not interested_, only that signal counts (the latest explicit action wins). Clicks count only for items without explicit feedback.
- Click tracking is optional (see the cut order in [plan.md §9](plan.md#9-decision-gates-and-cut-order)); the recommender works with explicit feedback alone.

Prototype implementation (spec 003): only explicit likes and _Not interested_ feedback are scoring signals. Each set contains at most the 200 most recently updated eligible items of the caller; likes have weight 1 and the dislike penalty is $\lambda = 0.5$. Similarity uses language-centered embeddings of `text-embedding-3-small@512` only. An eligible item has an embedding and a matching `(embedding_model, language)` mean row. Zero-length centered vectors have similarity 0. Newly embedded items use the existing frozen mean immediately; recomputing the means is not required for each ingestion run.

Why this approach:

- Handles multiple unrelated interests (an averaged profile of "Linux + astronomy" matches neither well).
- Works with very little feedback (a handful of likes).
- Explainable: the closest liked item is the reason for the recommendation.

### 2.2 Final ranking and exploration

- The prototype's final score is interest plus $\beta \cdot 0.5^{\text{age}/h}$, with $\beta = 0.1$. The half-life $h$ is 24 hours for articles and 7 days for videos. Candidate windows are 7 days for articles and 30 days for videos; all rated items are excluded.
- `get_feed` runs as `SECURITY INVOKER`, reads identity from `auth.uid()`, and is executable by authenticated users only. Pages contain 30 items; later pages exclude already shown IDs instead of using offsets. The limit is clamped to 1-100 and exclusions to 1,000 IDs.
- These defaults are kept together in the SQL function and will be tuned in week 6. Cards already displayed do not reorder; refreshing reloads the ranking, and subsequent pages use the latest feedback.
- Diversity re-ranking (MMR) and exploration slots are deferred to spec 007, not part of the prototype. The planned slot distribution is:
  - ~70% best-matching items
  - ~20% related but unfamiliar items (moderate similarity band)
  - ~10% exploratory items (topics/sources the user rarely engages with)

### 2.3 Cold start

With no eligible likes, the prototype round-robins sources, newest first within each source. Candidates with similarity at least $\theta = 0.4$ to any eligible _Not interested_ signal follow all other candidates, with source round-robin within each group. Explanations say "Recent from source". Personalization starts after the first eligible like and explains each result using its closest liked item.

### 2.4 Baselines (evaluation only)

- **Average vector:** rank by similarity to the mean embedding of liked items.
- **Newest first.**
- **Random.**

### 2.5 LLM usage (limited)

OpenAI API (a small, low-cost GPT model, chosen in week 1). The LLM is **not** used to rank individual items (cost, latency, reproducibility). It is used for:

1. **Interest summary** (optional): periodically turns likes/dislikes into a readable profile shown to the user.
2. **Evaluation judge:** labels test items as relevant/not relevant for simulated personas.
3. **Source discovery** (stretch, stage b): finds candidate sites with the built-in web search tool and assesses source quality.
4. **Description enrichment:** `gpt-6-luna` via the Responses API creates a concise, factual description only when feed and page metadata descriptions are unavailable. The request has no tools or URL access; extracted article text is untrusted content, not instructions. The output must preserve Finnish or English, use only facts in the text, and fit the existing 1,000-character summary limit. Prompt constraints and representative tests live with the enrichment implementation.

Description generation is bounded to 20 API requests per ingestion run, including retries, at most 24,000 extracted characters per item and 200 output tokens per request. At an estimated 6,000 input tokens per request, the full request budget is about $0.014 at the model's current standard rates ($0.10/M input tokens and $0.50/M output tokens); this is an estimate, not a hard dollar cap. A failed item gets at most three attempts total, with retries due after 1 hour and 6 hours; exhausted items require an explicit backfill retry. Readable article text is extracted with the approved `@mozilla/readability` and `jsdom` dependencies. No full page or article text is retained.

## 3. Source discovery (stretch goal)

Two independent stages, both attempted only after gate 2 ([plan.md §9](plan.md#9-decision-gates-and-cut-order)). Both feed the same validation and approval steps.

**Stage (a) — catalog-based (no LLM, ~5 h):** inactive sources from the catalog ([feeds.md](feeds.md)) are fetched, their recent items embedded and scored against each user's liked items. Sources that match well are proposed to the admin.

**Stage (b) — LLM web search (~6–8 h):** the LLM, using web search and the interest summary, suggests candidate sites. The LLM only _suggests_; deterministic code verifies.

Validation and approval (both stages):

1. Fetch each site and detect RSS/Atom feeds (autodiscovery). Feed URLs proposed by the LLM are never trusted without fetching.
2. Parse the feed: is it active, with recent posts?
3. Embed recent items and score them against the user's interests; in stage (b) the LLM also assesses source quality.
4. An admin approves a source before it is ingested. Approved sources join the shared source pool; each user's recommender decides whether its items are relevant to them.

Optional extra candidate source: outbound links from liked articles, fed into the same validation pipeline.

Safeguards: discovery runs manually or weekly with a cap on searches per run; fetching is restricted to http/https, blocks private/internal addresses (SSRF), and enforces timeouts and response size limits.

The core recommender must work without this feature.

## 4. Evaluation

Goal: a rigorous comparison of the recommender against simple baselines. A careful comparison is a successful result even if the recommender does not win; the report then analyzes why.

### 4.1 Early checks (week 2, [spec 001](specs/001-ingestion.md))

- **Cross-lingual check:** Finnish–English pairs of the same event (Yle News in English vs Finnish Yle feeds) must be clearly more similar than random pairs.
- **Early ranking experiment:** a fixed bilingual sample of ~300 items; for 2 personas, ~5 hand-picked liked items each (at least one Finnish). Rank the rest with nearest-liked, average-vector, and newest-first, then judge the top 10 of each by hand. The three lists are merged and shuffled before judging, so the method behind each item is not visible.
- **Gate 1:** if nearest-liked is not at least on par with average-vector and better than newest-first, investigate (embedding input text, $\lambda$, sample) before building the UI around it. Average-vector is the fallback ranking; the rest of the application does not depend on the choice.
- The sample is small, so the result is indicative only; it is recorded in [ai-log.md](ai-log.md).

### 4.2 Dataset and labels

1. Freeze a snapshot of ~1.5–2k items covering at least two weeks.
2. Define 3–4 personas as text descriptions (e.g. "AI and software", "cars and engineering", "science and space", "Finnish sports"). Each persona is a real user in the database, so the replay also exercises the multi-user setup and RLS.
3. An LLM labels each item's relevance per persona. These labels are **proxy judgments**, not independent ground truth. Using a different model family than the embedding provider (e.g. a local Qwen model) reduces shared bias.
4. Manually label ~100 items, balanced between Finnish and English. Report agreement with the LLM labels (percent agreement and Cohen's κ) overall and separately for Finnish and English.

### 4.3 Protocol safeguards

- **Time-based split:** items are ordered by publication time into a feedback window (oldest ~50%), a validation window (~25%), and a test window (newest ~25%). Feedback comes only from the feedback window; candidates come only from later windows. This mirrors real use and prevents leakage.
- **Identical feedback histories:** for each persona and run, one feedback sequence is sampled from the feedback window independently of any method (relevant items as likes, a fixed share of non-relevant items as _Not interested_). Every method receives exactly the same sequence.
- **Rated items are excluded** from every method's candidates.
- **Near-duplicates:** candidates with cosine similarity above a threshold fixed in advance (e.g. 0.9) to any feedback item are excluded from the headline metric, since the same story from several sources would inflate nearest-neighbor matching. Results including them are reported separately.
- **Tuning only on the validation window.** Parameters ($\lambda$, recency weight, click weight, slot mix) are frozen and recorded (commit hash) before a single run on the test window.
- **Repeated runs:** at least 10 runs with different random seeds for feedback sampling; report the mean and spread (standard deviation or 95% interval) per method.

### 4.4 Metrics

- Precision@10 as a function of the number of feedback items (e.g. 0, 3, 5, 10, 20), for the recommender and all baselines.
- Topic diversity of the top 10 (distinct categories and sources).
- Divergence between persona rankings.
- Cross-lingual retrieval: share of relevant Finnish items ranked in the top 10 from English-only feedback, and vice versa.

Limitation: this demonstrates adaptation in a controlled setting, not real-world recommendation accuracy.

## 5. Technology stack

Guiding principle: lowest possible cost, single language (TypeScript).

| Part                 | Choice                                                                                                | Cost          |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ------------- |
| Frontend and API     | Next.js (App Router, TypeScript) on Vercel Hobby                                                      | Free          |
| Database and vectors | Supabase Postgres + pgvector                                                                          | Free tier     |
| Database access      | supabase-js (`@supabase/ssr` in Next.js), SQL migrations via Supabase CLI, generated TypeScript types | Free          |
| Authentication       | Supabase Auth with Google login                                                                       | Free          |
| Scheduled jobs       | GitHub Actions scheduled workflow running TypeScript scripts                                          | Free          |
| Embeddings           | OpenAI `text-embedding-3-small`, 512 dimensions                                                       | < 1 €/month   |
| LLM                  | OpenAI GPT models via Responses API; description enrichment uses `gpt-6-luna`                         | A few € total |
| RSS parsing          | `rss-parser` or similar                                                                               | Free          |

Implementation notes:

- Recommender and baseline scoring are Postgres SQL functions called via RPC, so vectors never leave the database.
- Scheduled jobs run outside Vercel to avoid Hobby cron and function timeout limits; regular jobs also prevent the Supabase free project from pausing.
- Hourly ingestion uses roughly 700–800 GitHub Actions minutes per month, within the 2,000 free minutes for private repositories (unlimited for public ones).
- 512-dimension embeddings and pruning of old items keep the database within the 500 MB free limit.
- Evaluation scripts are TypeScript; results are exported as CSV/JSON for charts.
- Vercel Hobby is non-commercial only; a paid plan is needed if the project becomes a product.
- Google OAuth consent screen stays in "Testing" mode during the course (only listed test users can log in).

### 5.1 Data access and security

All user-facing queries run through supabase-js with the user's session, so Row Level Security (RLS) is enforced by the database.

| Data     | Examples                                           | Read                                | Write                                |
| -------- | -------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| Shared   | `sources`, content items, embedding language means | Authenticated users                 | Service role only (ingestion, admin) |
| Per-user | feedback, interest summaries, discovery candidates | Owner only (`user_id = auth.uid()`) | Owner only                           |

Rules:

- RLS is enabled on every table.
- Any verified Google user can use the app; no invitation or email provisioning is required.
- App pages verify identity with `getClaims()`; RLS and database functions remain the authorization boundary. Google OAuth must be published to Production for sign-in beyond Google's configured test users.
- Feed and scoring functions read the user from `auth.uid()` internally and never accept a `user_id` parameter; they run as `SECURITY INVOKER`.
- Views are created with `security_invoker = true`.
- The service-role key is used only in GitHub Actions secrets and server-only environment variables, never in `NEXT_PUBLIC_` variables.
- Description enrichment fetches only an ingested item's canonical `http` or `https` URL. It rejects loopback, private, link-local, reserved, and mixed DNS answers; pins each validated public answer to its connection; and validates every redirect target before connecting, preserving the hostname for Host and TLS verification. It forwards no credentials or feed validators, accepts only HTML, caps each request at 8 seconds and 1 MB with at most 3 redirects and 3 concurrent fetches, executes no JavaScript, and never stores or logs fetched page/article text.
- RLS does not limit cost. Current AI usage is shared ingestion work, independent of user count; per-user limits must be implemented with the first user-triggered LLM action.
- Policies are covered by automated tests with two users.

## 6. Data model

Tables are added by the spec that first needs them. Shared content tables are readable only by authenticated users and writable only with the service role (§5.1).

### 6.1 `sources` (shared)

| Column                               | Type               | Notes                                               |
| ------------------------------------ | ------------------ | --------------------------------------------------- |
| `id`                                 | `uuid` PK          |                                                     |
| `name`                               | `text`             | e.g. "Yle — Science"                                |
| `feed_url`                           | `text` unique      |                                                     |
| `site_url`                           | `text` null        |                                                     |
| `kind`                               | `text`             | `rss` or `youtube` (RSS also covers Atom)           |
| `language`                           | `text`             | `fi` or `en`; set per source, not detected per item |
| `is_active`                          | `boolean`          | Initial set active, rest of the catalog inactive    |
| `etag`, `last_modified`              | `text` null        | Conditional GET                                     |
| `last_fetched_at`, `last_success_at` | `timestamptz` null |                                                     |
| `last_error`                         | `text` null        | Last fetch/parse error                              |
| `created_at`                         | `timestamptz`      |                                                     |

### 6.2 `content_items` (shared)

| Column                       | Type                  | Notes                                                             |
| ---------------------------- | --------------------- | ----------------------------------------------------------------- |
| `id`                         | `uuid` PK             |                                                                   |
| `source_id`                  | `uuid` FK → `sources` | First source that delivered the item                              |
| `type`                       | `text`                | `article` or `video`                                              |
| `url`                        | `text` unique         | Normalized URL; deduplication key                                 |
| `title`                      | `text`                | Plain text                                                        |
| `summary`                    | `text` null           | Plain text, cleaned, max ~1,000 characters                        |
| `summary_origin`             | `text` null           | `feed`, `page_metadata`, or `ai_generated`; null while unresolved |
| `enrichment_status`          | `text`                | `pending`, `completed`, or `exhausted`                            |
| `enrichment_attempt_count`   | `integer`             | Non-negative; bounded by the retry policy                         |
| `enrichment_last_attempt_at` | `timestamptz` null    |                                                                   |
| `enrichment_next_attempt_at` | `timestamptz` null    | Due time for a pending retry                                      |
| `enrichment_error`           | `text` null           | Bounded to 500 characters                                         |
| `language`                   | `text`                | Copied from the source                                            |
| `categories`                 | `text[]`              | Feed category tags; not used for ranking                          |
| `thumbnail_url`              | `text` null           |                                                                   |
| `published_at`               | `timestamptz`         | Falls back to fetch time                                          |
| `embedding`                  | `vector(512)` null    | Null until embedded                                               |
| `embedding_model`            | `text` null           | e.g. `text-embedding-3-small@512`                                 |
| `created_at`                 | `timestamptz`         |                                                                   |

Non-empty existing summaries are backfilled as `feed`/`completed`; empty summaries are `pending` with no provenance. Database checks enforce valid provenance and enrichment-state combinations. Indexes cover `published_at desc`, due pending enrichment, and completed items missing embeddings. An HNSW index on `embedding` is added only if exact search becomes slow (tens of thousands of rows are fine without it).

### 6.3 `feedback` (per-user)

One row per user and item; the current state only (latest action wins). Undo deletes the row.

| Column                     | Type                        | Notes                                                    |
| -------------------------- | --------------------------- | -------------------------------------------------------- |
| `user_id`                  | `uuid` FK → `auth.users`    | Part of PK; defaults to `auth.uid()`                     |
| `item_id`                  | `uuid` FK → `content_items` | Part of PK                                               |
| `kind`                     | `text` not null             | `like`, `not_interested`, or `seen`                      |
| `via`                      | `text` not null             | `button` or `swipe`; used to analyze accidental gestures |
| `created_at`, `updated_at` | `timestamptz` not null      | Default `now()`; trigger updates `updated_at`            |

RLS: owner-only `select`, `insert`, `update (kind, via)`, `delete`; covered by two-user tests. Writes go through `set_feedback(item_id, kind, via)` (`SECURITY INVOKER`, user from `auth.uid()`), because a client-side upsert would also try to update `item_id`.

### 6.4 `embedding_language_means` (shared)

| Column            | Type                   | Notes                                         |
| ----------------- | ---------------------- | --------------------------------------------- |
| `embedding_model` | `text`                 | Part of PK; e.g. `text-embedding-3-small@512` |
| `language`        | `text`                 | Part of PK; `fi` or `en`                      |
| `mean`            | `vector(512)` not null | Corpus mean for the model and language        |
| `item_count`      | `integer` not null     | At least 50 embedded items                    |
| `computed_at`     | `timestamptz` not null | Time the mean was computed                    |

RLS is enabled. Authenticated users have `select` only; anonymous users have no access, and only the service role writes. `pnpm embeddings:means` manually computes the means from all embedded items of the active model, upserts qualifying groups, and reports skipped groups below 50 items. Means remain frozen until the next run. The normal command targets `.env.local`; hosted runs explicitly load `.env.production.local` without changing the local environment file.

### 6.5 Access-control removal

The email allowlist table was removed by a forward migration. `public.is_allowed()` remains temporarily for rollout compatibility with the previous app: it is `stable`, `SECURITY INVOKER`, has an empty search path, is executable only by `authenticated`, and returns whether `auth.uid()` is non-null. No current policy, feed/feedback RPC, or app page calls it. Drop this compatibility function in a later migration after the updated app is deployed.

### 6.6 Later tables

Click events, interest summaries, and discovery candidates are defined in their specs.

## 7. User interaction

The feed is a single column of compact cards, responsive for phone and desktop. Each card shows title, source, time, thumbnail (if any), and a one-line explanation.

### 7.1 Actions

| Action           | Button     | Touch gesture | Signal   | Effect in the feed                                                      |
| ---------------- | ---------- | ------------- | -------- | ----------------------------------------------------------------------- |
| _Like_           | 👍         | Swipe right   | Positive | Card stays, marked as liked                                             |
| _Not interested_ | 👎         | Swipe left    | Negative | Card collapses immediately                                              |
| _Seen_           | ✓ ("Seen") | —             | Neutral  | Card collapses immediately; for items already read or watched elsewhere |

- Pressing the active button again undoes the action; choosing another action replaces it.
- Every action that hides a card shows a short **Undo** toast.
- Buttons are always available on every device; gestures are a touch shortcut, not the only way (accessibility).
- Rated items (any action) do not return in the feed. A _Liked_ page lists liked items.
- _Seen_ is a button only, so that swipe-left keeps a single meaning.

### 7.2 Gesture safeguards

Swipe-to-dismiss is a common habit (e.g. in email), so a left swipe meaning "already seen" could be recorded as _Not interested_. Safeguards:

- The swipe reveals a colored background with an icon and label ("Like" / "Not interested") and only commits past a threshold (~40% of card width).
- Horizontal swipes lock direction so vertical scrolling is never misread as a swipe.
- Undo toast after every swipe.
- Feedback records `via` (`button` / `swipe`), so undo rates by input method can be measured and reported.

### 7.3 Ranking updates

The ranking does not reorder while the user is interacting. New feedback takes effect on the next load or when the user presses **Refresh feed**.

### 7.4 Explanations

- Personalized items: "Similar to _X_, which you liked".
- Exploration slots: "Exploring: something new".
- Cold start: "Recent from _source_".

### 7.5 Not included

Reasons for dislikes ("not this topic" / "not this source"), hiding a whole source, and impression tracking are possible later additions.

**Implicit skip signals** (scrolling quickly past an item as a weak negative) are deliberately left out:

- Scrolling past is ambiguous: the user may have already read the story elsewhere, got enough from the title, or been in a hurry. Lower positions are skipped more just because of their position.
- Most items are skipped, so even small negative weights would add up and, with the nearest-item penalty, push down whole topics.
- It needs impression tracking (which cards were visible and for how long) and would have to be simulated in the evaluation, where realistic skip behavior is hard to model.

If added later, the safer variant is "skip above click": items shown above a clicked item without any interaction get a small negative weight. It requires click tracking and a log of the ordered item IDs per feed load.
