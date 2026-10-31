# Prototype Video Plan

Target length 2–3 minutes, recorded on the deployed app at https://poimio.cc. Submission deadline: Sun 22 Nov 2026 12:00 (see [proto-deliverable.md](proto-deliverable.md)).

## Script

| Time      | Scene          | What to show                                                                                                                                                                                                                                                                                                                          |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | Intro          | What Poimio is: a personal feed that learns from _Like_ and _Not interested_; nothing to configure.                                                                                                                                                                                                                                   |
| 0:15–0:45 | Empty profile  | Sign in with a fresh Google account. Varied cold-start feed from many sources: Finnish and English, articles and videos, "Recent from …" labels. Point out an item with an **AI-generated description** (e.g. a Hacker News link).                                                                                                    |
| 0:45–1:25 | Learning       | Like 4–5 AI/software items, then **Refresh feed**. The feed re-ranks and each card says "Similar to _X_, which you liked". Point out a **Finnish** item recommended because of English likes.                                                                                                                                         |
| 1:25–1:55 | Phone          | Swipe left on a sports item, show **Undo**, swipe again; press **Seen** on a video; refresh: sports items drop. Briefly show the **Liked** page.                                                                                                                                                                                      |
| 1:55–2:40 | Under the hood | One diagram: feeds → hourly GitHub Actions → descriptions (feed → page metadata → LLM) → embeddings → Postgres/pgvector → `get_feed` SQL. One chart: gate 1 precision@10 — nearest-liked raw 0.65 vs centered 1.00, average-vector centered 0.95, newest-first 0.30. One line on security: RLS, two-user tests, deploy only after CI. |
| 2:40–3:00 | Next steps     | Evaluation harness, exploration and diversity, interest summary.                                                                                                                                                                                                                                                                      |

## Preparation

- [ ] Use a separate Google account so the empty-profile start is real.
- [ ] Rehearse once on the deployed app; note which 4–5 items to like so a Finnish match reliably appears.
- [ ] Check that a sports item and a video are in the cold-start feed for the phone scene.
- [ ] Prepare the pipeline diagram and the gate 1 chart (numbers from `evaluation/early-ranking/centered-results.json`).
- [ ] Record the phone part separately (screen recording) and cut it in.
- [ ] Optional: if the cross-lingual check (spec 006) is ready, add its result next to the gate 1 chart.

## After recording

- [ ] Upload to YouTube and add the link to [proto-deliverable.md](proto-deliverable.md).
