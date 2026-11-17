# Description-quality labelling

This experiment judges whether a description tells a reader what a specific item
is about. It does not check facts against the article. See
[spec 009](../../docs/specs/009-description-quality-jev.md).

## Rubric

| Quality | Definition | Examples |
| --- | --- | --- |
| `good` | States the specific subject or main point of the item. | Who did what; what the article explains or reports. A short description can be good: "Tekninen vika on saatu korjattua." |
| `weak` | Gives some item-specific information, but is vague, teaser-like, or incomplete. | "Tom Gauld's weekly cartoon" names the format without its subject; a question or invitation to take a quiz can be a teaser. |
| `unusable` | Says nothing specific about this item. | "[...]", "None", a site slogan such as "Uutiset nopeasti ja luotettavasti.", or text that only describes pagination or navigation. |

For ambiguous cases, use this rule: if a reader could not tell the topic from
the title and description together, label the description `unusable`.

Choose one reason:

| Reason | Meaning |
| --- | --- |
| `none` | No quality problem. |
| `boilerplate` | Generic publisher, website, or section description. |
| `placeholder` | A missing-value marker or punctuation-only text. |
| `promotional` | Mainly asks the reader to click, buy, subscribe, or participate. |
| `teaser` | Hints at the topic without stating the useful point. |
| `vague` | Gives insufficiently specific or incomplete information. |
| `page_structure` | Describes page layout, navigation, pagination, or format instead of the subject. |
| `off_topic` | Describes a different subject from the item. |
| `other` | A quality problem that does not fit another reason. |

## Prepare the blind files

Keep the exact final snapshot manifest and `items.jsonl` in this worktree's
`evaluation/snapshot/`. Do not export a fresh snapshot to replace the experiment
input or read the database for this experiment.

Run `pnpm eval:description-quality sample`. It creates:

| File | Purpose |
| --- | --- |
| `labels-dev.csv` | 30 dev articles for later rubric and threshold tuning. |
| `labels-test.csv` | Original 150-item model-test sample; do not finish its remaining labels. |
| `labels-videos.csv` | Video census; human labels are not required in the reduced pilot. |
| `sample.json` | Reproduction metadata, item IDs, text hashes, and weights. |
| `items.jsonl` | Local frozen input text. |

The command refuses to overwrite these files. Do not delete existing labels to
rerun it. Only `sample.json` is intended for Git at this stage; input text and
all `labels-*.csv` files are gitignored.

## Label in the terminal

From the worktree root, start with the dev set:

```bash
pnpm eval:judge --description-quality evaluation/description-quality/labels-dev.csv
```

The CLI shows one title and description at a time, with language and content
type. Choose quality with `1` (`good`), `2` (`weak`), or `3` (`unusable`), then
choose a reason from the numbered menu. Enter the number or the exact label,
then press Enter. `s` skips the current item; `q` quits.

Each answer is saved immediately. Rerun the same command to resume blank cells,
including an unfinished reason after a saved quality answer. Completed rows are
not shown again. The CLI refuses to overwrite a file changed by another editor
while you are answering, so use only one judging process for each file.

### Reduced pilot: only 22 more articles

The approved pilot requires 30 human test labels total, not 150. The dev set is
already complete. Prepare the audit once:

```bash
pnpm eval:description-quality audit
```

This preserves the 8 completed test rows and selects 22 additional rows with
language and original failure-flag coverage, without looking at answer values.
It writes a separate `labels-audit.csv` and response-free `audit.json` design;
the original 150-item sample and labels are unchanged. Existing audit files
will not be overwritten. Do not inspect the design while labelling.

Then run:

```bash
pnpm eval:judge --description-quality evaluation/description-quality/labels-audit.csv
```

Completed rows are skipped, so you only answer the 22 new items. Do not finish
`labels-test.csv` or label videos. Ten delayed repeat items are the only
remaining required human work after the audit. The existing relevance judging
command is unchanged.

### Optional CSV editing

Open each CSV in a UTF-8 CSV editor that preserves quoted commas, quotes, and
line breaks. Edit only `quality` and `reason`; keep the other cells unchanged.
Use the exact lowercase values above. Save and reopen the CSV to confirm that
your answers persist and that the row count and input text are unchanged.

### Blind labelling rules

Label the dev set first, then the reduced audit. Do not inspect `sample.json`,
`audit.json`, H1 flags, source/provenance metadata,
or model output while labelling. Do not fetch the linked article to decide a
label: only the displayed title and description are evidence.

Leave a row blank if it needs more thought, then return to it before declaring
the set finished. Both answer cells must be filled in every finished row.
Record the audit-labelling completion time locally so the one-day repeat delay
can be checked. Do not change human labels to agree with a classifier.

## Repeat check

At least one day after finishing the audit labels, prepare the repeat file:

```bash
pnpm eval:description-quality repeat --completed-at <recorded-completion-timestamp> --audit-hash <completed-audit-sha256>
```

Use the timestamp and SHA-256 recorded when the audit was completed. The
command requires at least 24 hours to have elapsed and rejects an audit CSV
that changed since completion. It selects 10 items using the recorded default
seed, clears all answers, and writes `labels-repeat.csv` and response-free
`repeat.json` metadata. It refuses to overwrite either file and leaves audit
labels unchanged. No snapshot re-export is needed.

Then run:

```bash
pnpm eval:judge --description-quality evaluation/description-quality/labels-repeat.csv
```

Label these 10 rows again without consulting the first labels. Match the
finished repeat rows to the audit rows by `blind_id` only after relabelling.
The comparison uses `unusable` versus `good`/`weak`. Report raw agreement and
binary Cohen's kappa; with 10 rows this is descriptive only. Low agreement is a
limitation, not a requirement to label more items in this pilot.

Do not run models on test items before human audit labels and the experiment
configuration are frozen. Models will judge all 150 original articles, but
accuracy is measured only against the human audit. Agreement elsewhere is not
ground truth. This pilot cannot establish per-language accuracy, a low false
replacement rate, replacement benefit, or production readiness. There is no
additional human disagreement-review or replacement-probe queue.

## Judge clients (task 5)

The HTTP clients and resumable runner currently support only dev-set
execution. The first dev run is now complete and cached:

```bash
pnpm eval:description-quality run --set dev
```

This sends public dev titles/descriptions to TypeSafe Jev and OpenAI; it does
not send human labels, source/provenance metadata, URLs, or user data.
`TYPESAFE_API_KEY` and `OPENAI_API_KEY` must be available in the environment
(`.env.local` is loaded by the package command). Do not put keys in command
arguments. There is no database access.

Optional `--classifier jev` or `--classifier llm` selects one service. The
default is both. Matching `judge-cache.jsonl` rows are skipped when the same
command resumes. Errors are recorded without request/response bodies and
produce a nonzero exit; cached errors remain errors on resume. `--run 2`
creates a separate measurement rather than replacing earlier results.

Each call has at most three 15-second attempts and two waits of at most
10 seconds. A longer server-requested wait ends that call rather than
retrying too early. Success rows record tokens and estimated cost; failed
attempt usage is unknown, so recorded costs can understate actual billing.
Empty/placeholder descriptions are handled without an API request.

Do not run two judge commands against the same directory. The exclusive
`.judge-cache.lock` is normally removed on exit; after an interrupted process,
verify the recorded PID is no longer running before removing that specific
stale lock. Do not edit or delete cached results to rerun an experiment.

Test/video runs are deliberately unavailable until the frozen configuration
and guarded test execution are implemented in the next tasks. No test
judgments should be viewed during dev tuning.

## Frozen pilot settings (task 6)

`config.json` is frozen before test runs. The approved settings require Jev
`p0 >= 0.80` **and** confidence `>= 0.50` to replace a description. Lower
confidence means uncertain/keep; the word-count rule remains disabled.
The rubric is unchanged. With only one human-`unusable` dev item, these are
conservative defaults, not reliably optimized thresholds.

Dev results are preserved in `results/dev-run-1.json` (IDs only). The local
`results/disagreements-dev.csv` shows human/model disagreements with item text.
Do not change human labels to match the models. The existing placeholder
disagreement is retained: deterministic routing rejects it, but the human
label is `weak`. Other differences include good/weak judgments; these are not
automatically replacement errors.

`labels.jsonl` and `labels-repeat.jsonl` preserve finalized human labels
without item text. CSV hashes, finalized-label hashes, and source-design
hashes are in the config. Resuming the cached dev run makes no new model calls.
The runner refuses protocol or input drift after the config is frozen; do not
edit frozen artifacts to rerun an experiment. Task 7 will add guarded test
execution and the held-out pilot report.
