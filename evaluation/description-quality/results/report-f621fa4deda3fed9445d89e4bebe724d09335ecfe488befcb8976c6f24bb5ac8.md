# Description-quality pilot report

**Exploratory only. No production-readiness or replacement-benefit claim.**

Config SHA-256: `f621fa4deda3fed9445d89e4bebe724d09335ecfe488befcb8976c6f24bb5ac8`
Git HEAD: `e07c2413b315b6ca8ccfec30f46f62d56335e1ad`; working tree dirty: true. Source hash: `420409544d815ce3f579abee4be49865c001e101d2811ef77a8acf083eb10bf6`.
Snapshot: `6a8057e2a2278c945d167a21e3cff344a45bfecc5a5d259cb944ab400bd4b314`; rubric: `desc-quality-v1`.
Audit CSV: `2008148f8fdeb325bbe2b215ced95dce6e88f3c06411513ac070b8ad6d7aee64`.
Models: jev-1.14.0; gpt-6-luna.

Model sample: 150 articles and 8 videos. Accuracy uses only 30 audit labels; 120 articles remain unlabelled.

## Audit classification

Unweighted / two-stage weighted point estimates. Denominators below are raw counts. Wilson intervals, confusion matrices, kappa, per-origin results, H1-accepted-only results, and AI-origin exclusions are in the JSON report.

| Classifier | Correct / all replacements | Found / all unusable | Precision U/W | Recall U/W | F1 U/W | Good falsely replaced U/W |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| H0 | 0/0 | 0/1 | insufficient evidence / insufficient evidence | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| H1 | 0/2 | 0/1 | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| J | 0/2 | 0/1 | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| L | 1/1 | 1/1 | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% | 0.0% / 0.0% |
| H1_J | 0/2 | 0/1 | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| H1_L | 1/3 | 1/1 | 33.3% / 77.8% | 100.0% / 100.0% | 50.0% / 87.5% | 0.0% / 0.0% |

## Languages

- fi: 15 human labels, 0 unusable and 13 good; Jev precision 0.0%, recall insufficient evidence. Insufficient evidence for language certification.
- en: 15 human labels, 1 unusable and 5 good; Jev precision 0.0%, recall 0.0%. Insufficient evidence for language certification.

## Agreement and stability

Human delayed-repeat agreement: 90.0%, kappa 0 on 10 items; descriptive only.
Article J/L binary agreement: 94.0%; this is not correctness on unlabelled items.
Article decision stability: Jev replace/uncertain/keep 96.7%; binary replace/keep 100.0%. L binary replace/keep 98.7%.
Jev mean absolute p0 difference: 0.004899328859060402.
H1 misses 1 audit unusable items; J recovers 0, L recovers 1.

## Operations

| Run | Judge | HTTP calls | Deterministic | Errors | Retries | p50 / p95 ms | Estimated cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | jev | 157 | 1 | 0 | 0 | 179 / 222 | $0.004151 |
| 1 | llm | 157 | 1 | 0 | 0 | 1018 / 1802 | $0.005532 |
| 2 | jev | 157 | 1 | 0 | 0 | 176 / 226 | $0.004151 |
| 2 | llm | 157 | 1 | 0 | 0 | 1095 / 2226 | $0.005533 |

## Hypothetical policies

Per 1,000 snapshot items. Article routing volumes are multiplied by the audit-weighted poor/good share among routed audit articles. With no routed audit examples, quality estimates are insufficient evidence. Video outcomes are unknown. No successful replacements were measured. Monthly costs use frozen token prices and 5,400 new items.

| Policy | Generation calls | Poor routed (estimated) | Good wrongly routed (estimated) | Monthly cost |
| --- | ---: | ---: | ---: | ---: |
| P0 | 0.0 | 0.0 | 0.0 | $0.000 |
| P1 | 6.4 | 0.0 | 0.0 | $0.024 |
| P2 | 14.8 | 0.0 | 0.0 | $0.197 |
| P2_L | 4.1 | 4.1 | 0.0 | $0.202 |
| P3 | 18.2 | 0.0 | 0.0 | $0.209 |
| P3_L | 9.8 | 7.6 | 0.0 | $0.222 |
| P4 | 1000.0 | 25.6 | 555.3 | $3.780 |

## Disagreements (IDs only)

Confident Jev errors on labelled items come first. Unlabelled rows are model/rule disagreements, not errors against ground truth. Full title/description/Noul details remain in the local gitignored disagreement CSV.

| Item ID | Human | H1 | Jev | p0 | Confidence | L |
| --- | --- | --- | --- | ---: | ---: | --- |
| d1378b87-4c4d-40e5-86e1-3100fd7842c2 | weak | repeated | replace | 1 | 1 | weak |
| eacf9655-7bca-4a4b-a517-573172559732 | weak | equals_title | replace | 0.83 | 0.7 | weak |
| 000f6c77-634b-470c-bd60-7270e9e86b12 | unusable | accept | uncertain | 0.63 | 0.02 | unusable |
| b7b1b8eb-aed1-4f24-89dc-330e8f32a344 | unlabelled | repeated | replace | 1 | 1 | weak |
| c4e37056-2d23-45de-aa08-36c2945cdf34 | unlabelled | repeated | replace | 1 | 1 | weak |
| 4888149a-954e-4784-9c66-fde1c612ca47 | unlabelled | accept | replace | 0.96 | 0.92 | weak |
| 07fec1bf-ac3c-4cb1-be6e-707aee9ffae7 | unlabelled | accept | replace | 0.93 | 0.88 | weak |
| df20f964-2866-4b80-9da9-2fe319a9405f | unlabelled | accept | replace | 0.87 | 0.8 | weak |
| f0d3e9ef-38f9-460b-ab16-238b3c8e7ba3 | unlabelled | repeated | keep | 0.01 | 0.8 | weak |
| 516fa5d4-dc87-43bb-b8b2-f15f95889b46 | unlabelled | repeated | keep | 0.01 | 0.79 | weak |
| 4c7b0fcf-8dd1-4c04-b8b7-9d2cb6d6ae4f | unlabelled | equals_title | replace | 0.88 | 0.72 | good |
| db930359-d98c-42e0-a804-680449684f4f | unlabelled | equals_title | replace | 0.87 | 0.72 | weak |
| 42d714b6-4523-41d6-b825-a40bb3eb3082 | unlabelled | equals_title | keep | 0.14 | 0.68 | weak |
| d5d70601-c66c-4488-bf58-78786f7000a1 | unlabelled | repeated | keep | 0.01 | 0.68 | weak |
| 4149a8af-134b-46c5-9849-d14f41185d66 | unlabelled | repeated | keep | 0.01 | 0.66 | weak |
| 6da40127-7e14-4d08-b28b-3ba0e01ceb0c | unlabelled | repeated | keep | 0.01 | 0.64 | weak |
| 65ae009a-d2e3-425e-b751-cd8abe4b3338 | unlabelled | equals_title | keep | 0.12 | 0.53 | good |
| 8c875f89-662b-4d4c-a8b1-2d3faa43e44a | unlabelled | equals_title | uncertain | 0.6 | 0.01 | weak |
| 0f2f8068-165b-4846-a28e-9b6d7b509792 | unlabelled | equals_title | uncertain | 0.44 | 0 | weak |

## Limitations

- Exploratory 30-item single-human audit; original 150-item model sample is not fully human-labelled.
- Audit weights are two-stage conditional estimates. Policy quality estimates calibrate article routing volumes to the weighted label mix among routed audit articles; no routed audit examples means insufficient evidence. Video quality is unknown.
- No per-language accuracy or <=5% false-replacement certification, even if point estimates meet reference targets.
- Uncertain/error judgments keep the original description in binary policy metrics; error statuses remain explicit.
- Raw agreement and kappa on 10 repeat labels are descriptive; class imbalance can make kappa low despite high agreement.
- Videos are an unlabelled descriptive census, not accuracy evidence.
- Jev score rounding is used only for ordinal descriptions, never for replacement decisions.
- OpenAI judges some descriptions generated by the same model; see excludingAiGenerated results.
- No article-level factual verification, replacement probe, or measured replacement improvement.
- Only public title/description/language/type went to providers; no user data or human labels. TypeSafe says customer requests are not training data; zero retention is enterprise-only.
- Unknown failed-attempt usage is not included in successful-response token/cost estimates.
