# Prototype Video Script

Frame-by-frame narration for TTS. Scene timing follows [plan.md](plan.md). Narration runs at about 150 words per minute, so 10 seconds is roughly 25 words.

## TTS notes

- "Poimio": check the pronunciation (POY-mee-oh). If the voice gets it wrong, spell it phonetically in the TTS input only.
- "pgvector": if the voice reads it badly, use "P G vector" in the TTS input.
- Generate each frame as a separate clip so timing can be adjusted in the edit.

## Frames

### 0. Logo (0:00–0:10)

On screen: Poimio logo video with its own sound effects. No narration.

### 1. Intro (0:10–0:23)

On screen: the app's home feed.

> This is Poimio, a personal feed of Finnish and English news, articles, and videos. There's nothing to set up: tap Like or Not interested, and it learns what you want to see.

### 2. Empty profile (0:23–0:55)

Three separate clips; place each when the matching moment appears in the recording.

**2a. Sign in** (on screen: Sign in with Google, then the first feed)

> Signing in takes one click with Google. This is a brand-new account, so there are no likes yet.

**2b. Cold-start feed** (on screen: scrolling the feed, pause on a "Recent from …" label)

> Without likes, the feed is a balanced mix of the newest items from every source: Finnish and English, articles and videos. Each card says why it's there, for now just "Recent from" its source.

**2c. AI summary** (on screen: a card with the "AI summary" badge, e.g. a Hacker News link)

> Some feeds, like Hacker News, give only a link. If the page has no description either, Poimio writes a short one with a language model and marks it with an AI summary badge.

### 3. Learning (0:55–1:35)

_TBD after recording._

### 4. Phone (1:35–2:05)

Separate clips; place each when the matching moment appears in the phone recording.

**4a. Swipe** (on screen: swipe left on a sports item)

> On a phone, swipe right to like and left for Not interested. Not into sports? Swipe it away.

**4b. Undo** (on screen: the "Undo" toast, tap it, then swipe again)

> Every swipe can be undone for a few seconds, in case it was a mistake.

**4c. Seen** (on screen: press Seen on a video)

> Seen hides something you've already read or watched elsewhere. It doesn't count as a like or a dislike.

**4d. Refresh** (on screen: refresh; sports items are gone or lower)

> After a refresh, sports stories move down the feed.

Check in the rehearsal that this actually happens; otherwise drop 4d.

**4e. Liked page** (on screen: open Liked)

> And everything you've liked is saved on the Liked page.

### 5. Pipeline diagram (2:05–2:30)

On screen: [diagram1.png](diagram1.png).

> Here's how it works. Every hour, a GitHub Actions job fetches seventeen Finnish and English feeds. If an item has no description, Poimio tries the page's metadata, and only then asks a language model for a short summary. Each item becomes an OpenAI embedding, stored in Postgres with pgvector. One SQL function ranks the feed by similarity to what you've liked, and every like or dismissal feeds back into the next refresh.

### 6. Gate 1 chart (2:30–2:47)

On screen: [chart1.png](chart1.png).

> Early on, the embeddings matched by language, not topic, so unrelated Finnish news pushed out relevant English items. Subtracting each language's average embedding fixed it: in a blind-judged test, top-ten precision rose from sixty-five to one hundred percent. Newest-first reached thirty.

### 7. Security (2:47–3:02)

On screen: [security.png](security.png).

> Security is built in. Row Level Security in the database keeps each user's feedback private. Automated tests sign in as two different users and check that neither can see or change the other's data. And production deploys only after the tests and build pass in CI.

### 8. Next steps (3:02–3:25)

On screen: [next-steps.png](next-steps.png), static.

> Next, I'll build an evaluation harness with simulated users, time-based data splits, and baselines, so the ranking is measured, not just eyeballed. Then exploration and diversity, so the feed doesn't only repeat what you already like. And finally, a short AI summary of your interests. Try it at Poimio dot C C.
