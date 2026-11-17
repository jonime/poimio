import { encodeCsv } from "./early-ranking.ts";
import {
  DESCRIPTION_JUDGE_MODELS,
  DESCRIPTION_JUDGE_PRICES,
  DESCRIPTION_RUBRIC_VERSION,
  type DescriptionClassifier,
  type DescriptionDecisionThresholds,
  type DescriptionJudgeCacheRow,
  type DescriptionQuality,
  descriptionJevDecision,
  descriptionJudgeCacheKey,
  validateFrozenDescriptionProtocol,
} from "./evaluation-description-judges.ts";
import {
  type DescriptionSample,
  type DescriptionSampleEntry,
  type DescriptionSampleItem,
  descriptionHeuristicReasons,
  descriptionTextHash,
  findRepeatedDescriptions,
} from "./evaluation-description-quality.ts";
import { hashSnapshotRow, parseJsonLines, sha256 } from "./evaluation-snapshot.ts";
import { descriptionJudgingConfig, readConfiguredJudgingCsv } from "./manual-judging.ts";
import { requireDefined } from "./required.ts";

export interface FrozenDescriptionConfig {
  thresholds: DescriptionDecisionThresholds;
  h1MinWords: number | null;
  plannedTestRuns: number[];
  sampleHash: string;
  snapshotManifestHash: string;
  auditDesignHash: string;
  repeatDesignHash: string;
  labelCsvHashes: { dev: string; audit: string; repeat: string };
  finalizedLabelsHash: string;
  finalizedRepeatLabelsHash: string;
  devCacheHashAtFreeze: string;
  devSummaryHash: string;
  policyProjection: {
    monthlyItems: number;
    summaryInputTokens: number;
    summaryOutputTokens: number;
  };
}
export interface DescriptionHumanLabel {
  itemId: string;
  label: DescriptionQuality;
  reason: string;
}
export interface DescriptionAuditEntry extends DescriptionSampleEntry {
  auditInclusionProbability: number;
  auditWeight: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function quality(value: unknown): value is DescriptionQuality {
  return value === "good" || value === "weak" || value === "unusable";
}

export function parseFrozenDescriptionConfig(text: string): FrozenDescriptionConfig {
  const value: unknown = JSON.parse(text);
  validateFrozenDescriptionProtocol(value);
  if (
    !record(value) ||
    !record(value.thresholds) ||
    !probability(value.thresholds.replaceProbability) ||
    !probability(value.thresholds.minConfidence) ||
    !(
      value.h1MinWords === null ||
      (typeof value.h1MinWords === "number" &&
        Number.isSafeInteger(value.h1MinWords) &&
        value.h1MinWords >= 0)
    ) ||
    JSON.stringify(value.plannedTestRuns) !== "[1,2]" ||
    value.uncertainBinaryDecision !== "keep" ||
    value.llmReplaceLabel !== "unusable" ||
    JSON.stringify(value.decisionOrder) !==
      JSON.stringify([
        "deterministic_empty_or_placeholder",
        "uncertain_if_confidence_below_minimum",
        "replace_if_p0_at_least_threshold",
        "keep",
      ]) ||
    !record(value.labelCsvHashes) ||
    !record(value.policyProjection) ||
    !positive(value.policyProjection.monthlyItems) ||
    !positive(value.policyProjection.summaryInputTokens) ||
    !positive(value.policyProjection.summaryOutputTokens)
  )
    throw new Error("Invalid frozen description pilot configuration");
  function hash(input: unknown): string {
    if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) {
      throw new Error("Frozen description configuration requires SHA-256 input hashes");
    }
    return input;
  }
  return {
    thresholds: {
      replaceProbability: value.thresholds.replaceProbability,
      minConfidence: value.thresholds.minConfidence,
    },
    h1MinWords: value.h1MinWords,
    plannedTestRuns: [1, 2],
    sampleHash: hash(value.sampleHash),
    snapshotManifestHash: hash(value.snapshotManifestHash),
    auditDesignHash: hash(value.auditDesignHash),
    repeatDesignHash: hash(value.repeatDesignHash),
    labelCsvHashes: {
      dev: hash(value.labelCsvHashes.dev),
      audit: hash(value.labelCsvHashes.audit),
      repeat: hash(value.labelCsvHashes.repeat),
    },
    finalizedLabelsHash: hash(value.finalizedLabelsHash),
    finalizedRepeatLabelsHash: hash(value.finalizedRepeatLabelsHash),
    devCacheHashAtFreeze: hash(value.devCacheHashAtFreeze),
    devSummaryHash: hash(value.devSummaryHash),
    policyProjection: {
      monthlyItems: value.policyProjection.monthlyItems,
      summaryInputTokens: value.policyProjection.summaryInputTokens,
      summaryOutputTokens: value.policyProjection.summaryOutputTokens,
    },
  };
}

export function requireCommittedDescriptionConfig(current: string, committed: string): void {
  if (current !== committed) throw new Error("Commit the unchanged frozen config before test runs");
}

export function descriptionHumanLabels(
  csv: string,
  entries: readonly DescriptionSampleEntry[],
  items: readonly DescriptionSampleItem[],
): DescriptionHumanLabel[] {
  const rows = readConfiguredJudgingCsv(csv, descriptionJudgingConfig);
  const byBlindId = new Map(entries.map((entry) => [entry.blindId, entry]));
  const byItemId = new Map(items.map((item) => [item.id, item]));
  if (
    rows.length !== entries.length ||
    byBlindId.size !== entries.length ||
    new Set(rows.map(({ values }) => values.blind_id)).size !== rows.length
  )
    throw new Error("Human label rows do not match the frozen selection");
  return rows.map(({ values }) => {
    const entry = requireDefined(byBlindId.get(values.blind_id ?? ""), "frozen human-label entry");
    const item = requireDefined(byItemId.get(entry.itemId), `human-label item ${entry.itemId}`);
    if (
      !quality(values.quality) ||
      !values.reason ||
      descriptionTextHash({ title: values.title ?? "", summary: values.description ?? "" }) !==
        entry.textHash ||
      values.language !== item.language ||
      values.content_type !== item.type
    )
      throw new Error("Human labels are incomplete or differ from frozen inputs");
    return { itemId: item.id, label: values.quality, reason: values.reason };
  });
}

export function validateFrozenDescriptionEvidence(input: {
  config: FrozenDescriptionConfig;
  sample: DescriptionSample;
  texts: {
    sample: string;
    audit: string;
    repeat: string;
    devCsv: string;
    auditCsv: string;
    repeatCsv: string;
    labels: string;
    repeatLabels: string;
    devSummary: string;
  };
  items: readonly DescriptionSampleItem[];
}) {
  const { config, sample, texts, items } = input;
  const hashes = [
    [texts.sample, config.sampleHash],
    [texts.audit, config.auditDesignHash],
    [texts.repeat, config.repeatDesignHash],
    [texts.devCsv, config.labelCsvHashes.dev],
    [texts.auditCsv, config.labelCsvHashes.audit],
    [texts.repeatCsv, config.labelCsvHashes.repeat],
    [texts.labels, config.finalizedLabelsHash],
    [texts.repeatLabels, config.finalizedRepeatLabelsHash],
    [texts.devSummary, config.devSummaryHash],
  ];
  if (
    hashes.some(([text, hash]) => sha256(requireDefined(text, "frozen evidence text")) !== hash)
  ) {
    throw new Error("Frozen description evidence hash mismatch");
  }
  const audit: unknown = JSON.parse(texts.audit);
  if (
    !record(audit) ||
    !Array.isArray(audit.entries) ||
    audit.entries.length !== 30 ||
    audit.sampleHash !== config.sampleHash
  ) {
    throw new Error("Invalid frozen audit design");
  }
  const test = new Map(sample.sets.test.map((entry) => [entry.itemId, entry]));
  const auditEntries = audit.entries.map((entry: unknown): DescriptionAuditEntry => {
    if (
      !record(entry) ||
      typeof entry.itemId !== "string" ||
      !positive(entry.auditInclusionProbability) ||
      entry.auditInclusionProbability > 1 ||
      !positive(entry.auditWeight)
    )
      throw new Error("Invalid audit inclusion probability or weight");
    const original = requireDefined(test.get(entry.itemId), "sampled audit item");
    if (
      original.weight === null ||
      entry.blindId !== original.blindId ||
      entry.textHash !== original.textHash ||
      entry.stratumKey !== original.stratumKey ||
      Math.abs(entry.auditWeight - original.weight / entry.auditInclusionProbability) > 1e-8
    )
      throw new Error("Audit entry differs from frozen test selection");
    return {
      ...original,
      auditWeight: entry.auditWeight,
      auditInclusionProbability: entry.auditInclusionProbability,
    };
  });
  if (new Set(auditEntries.map((entry) => entry.itemId)).size !== 30) {
    throw new Error("Audit contains duplicate items");
  }
  const repeat: unknown = JSON.parse(texts.repeat);
  if (
    !record(repeat) ||
    !Array.isArray(repeat.blindIds) ||
    repeat.blindIds.length !== 10 ||
    new Set(repeat.blindIds).size !== 10 ||
    repeat.auditDesignHash !== config.auditDesignHash ||
    repeat.auditLabelsHash !== config.labelCsvHashes.audit ||
    typeof repeat.completedAt !== "string" ||
    typeof repeat.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(repeat.completedAt)) ||
    !Number.isFinite(Date.parse(repeat.preparedAt)) ||
    Date.parse(repeat.preparedAt) - Date.parse(repeat.completedAt) < 86_400_000
  )
    throw new Error("Invalid delayed repeat design");
  const repeatIds = new Set(repeat.blindIds);
  const repeatedEntries = auditEntries.filter((entry) => repeatIds.has(entry.blindId));
  if (repeatedEntries.length !== 10) throw new Error("Repeat IDs differ from the frozen audit");
  const devLabels = descriptionHumanLabels(texts.devCsv, sample.sets.dev, items);
  const auditLabels = descriptionHumanLabels(texts.auditCsv, auditEntries, items);
  const repeatLabels = descriptionHumanLabels(texts.repeatCsv, repeatedEntries, items);
  function checkFinalized(text: string, labels: DescriptionHumanLabel[]) {
    const rows = parseJsonLines<unknown>(text, "finalized description labels");
    const expected = [...labels].sort((a, b) => a.itemId.localeCompare(b.itemId));
    if (
      rows.length !== expected.length ||
      rows.some(
        (row, index) =>
          !record(row) ||
          hashSnapshotRow(row) !==
            hashSnapshotRow({ ...requireDefined(expected[index], "expected label") }),
      )
    )
      throw new Error("Finalized labels do not match the frozen human CSV answers");
  }
  checkFinalized(texts.labels, [...devLabels, ...auditLabels]);
  checkFinalized(texts.repeatLabels, repeatLabels);
  return { auditEntries, auditLabels, repeatLabels };
}

export interface DescriptionMetricRow {
  label: DescriptionQuality;
  replace: boolean;
  weight: number;
}
export function descriptionWilson(successes: number, trials: number): [number, number] | null {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    successes < 0 ||
    trials < successes
  ) {
    throw new Error("Wilson intervals require integer counts with 0 <= successes <= trials");
  }
  if (trials === 0) return null;
  const z = 1.959963984540054;
  const p = successes / trials,
    z2 = z * z;
  const center = (p + z2 / (2 * trials)) / (1 + z2 / trials);
  const margin =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / (1 + z2 / trials);
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
export function descriptionClassification(rows: readonly DescriptionMetricRow[], weighted = false) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0,
    good = 0,
    falseGood = 0,
    squaredWeight = 0;
  for (const row of rows) {
    if (!positive(row.weight))
      throw new Error("Description metric weights must be positive and finite");
    const w = weighted ? row.weight : 1;
    squaredWeight += w * w;
    if (row.label === "unusable") {
      if (row.replace) tp += w;
      else fn += w;
    } else {
      if (row.replace) fp += w;
      else tn += w;
      if (row.label === "good") {
        good += w;
        if (row.replace) falseGood += w;
      }
    }
  }
  const total = tp + fp + tn + fn;
  const observed = ratio(tp + tn, total);
  const expected = ratio((tp + fn) * (tp + fp) + (tn + fp) * (tn + fn), total * total);
  return {
    sampleItems: rows.length,
    humanUnusable: rows.filter((row) => row.label === "unusable").length,
    humanGood: rows.filter((row) => row.label === "good").length,
    weighted,
    totalWeight: total,
    tp,
    fp,
    tn,
    fn,
    goodWeight: good,
    falseGood,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    f1: ratio(2 * tp, 2 * tp + fp + fn),
    falseReplacementRate: ratio(falseGood, good),
    accuracy: observed,
    binaryKappa:
      observed === null || expected === null || expected === 1
        ? null
        : (observed - expected) / (1 - expected),
    effectiveSampleSize: ratio(total * total, squaredWeight),
    wilson95: weighted
      ? null
      : {
          precision: descriptionWilson(tp, tp + fp),
          recall: descriptionWilson(tp, tp + fn),
          falseReplacementRate: descriptionWilson(falseGood, good),
          accuracy: descriptionWilson(tp + tn, total),
        },
    evidence: "exploratory; insufficient evidence for production or per-language certification",
  };
}

export function descriptionAuc(
  rows: readonly { positive: boolean; score: number; weight: number }[],
): number | null {
  let concordant = 0,
    pairs = 0;
  for (const row of rows) {
    if (!positive(row.weight) || !Number.isFinite(row.score))
      throw new Error("Invalid AUC score or weight");
  }
  for (const p of rows.filter((row) => row.positive)) {
    for (const n of rows.filter((row) => !row.positive)) {
      pairs += p.weight * n.weight;
      concordant += p.weight * n.weight * (p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0);
    }
  }
  return ratio(concordant, pairs);
}
export function descriptionSpearman(
  pairs: readonly { score: number; ordinal: number }[],
): number | null {
  if (pairs.some((pair) => !Number.isFinite(pair.score) || !Number.isFinite(pair.ordinal))) {
    throw new Error("Spearman correlation requires finite inputs");
  }
  function ranks(values: number[]) {
    return values.map(
      (value) =>
        1 +
        values.filter((x) => x < value).length +
        (values.filter((x) => x === value).length - 1) / 2,
    );
  }
  const x = ranks(pairs.map((pair) => pair.score)),
    y = ranks(pairs.map((pair) => pair.ordinal));
  const mean = (pairs.length + 1) / 2;
  let covariance = 0,
    xx = 0,
    yy = 0;
  for (let index = 0; index < pairs.length; index += 1) {
    const dx = requireDefined(x[index], "score rank") - mean;
    const dy = requireDefined(y[index], "ordinal rank") - mean;
    covariance += dx * dy;
    xx += dx * dx;
    yy += dy * dy;
  }
  return ratio(covariance, Math.sqrt(xx * yy));
}

export type DescriptionPolicy = "P0" | "P1" | "P2" | "P2_L" | "P3" | "P3_L" | "P4";
export function descriptionPolicyProjection(input: {
  routedWeight: number;
  populationWeight: number;
  poorRoutedWeight: number;
  goodRoutedWeight: number;
  auditWeight: number;
  auditRoutedWeight: number;
  articleRoutedWeight: number;
  judgeCostWeighted: number;
  monthlyItems: number;
  summaryCost: number;
}) {
  if (
    !positive(input.populationWeight) ||
    !positive(input.auditWeight) ||
    !positive(input.monthlyItems) ||
    Object.values(input).some((value) => !Number.isFinite(value) || value < 0) ||
    input.routedWeight > input.populationWeight + 1e-8 ||
    input.articleRoutedWeight > input.routedWeight + 1e-8 ||
    input.auditRoutedWeight > input.auditWeight + 1e-8 ||
    input.poorRoutedWeight + input.goodRoutedWeight > input.auditRoutedWeight + 1e-8
  )
    throw new Error("Invalid policy-simulation totals");
  const callsPer1000 = (input.routedWeight / input.populationWeight) * 1000;
  const judgeCostPer1000 = (input.judgeCostWeighted / input.populationWeight) * 1000;
  function qualityRate(weight: number): number | null {
    if (input.articleRoutedWeight === 0) return 0;
    if (input.auditRoutedWeight === 0) return null;
    return (
      (((input.articleRoutedWeight / input.populationWeight) * weight) / input.auditRoutedWeight) *
      1000
    );
  }
  return {
    generationCallsPer1000: callsPer1000,
    estimatedPoorDescriptionsRoutedPer1000: qualityRate(input.poorRoutedWeight),
    estimatedGoodDescriptionsWronglyRoutedPer1000: qualityRate(input.goodRoutedWeight),
    auditRoutedWeight: input.auditRoutedWeight,
    judgeCostPer1000Usd: judgeCostPer1000,
    generationCostPer1000Usd: callsPer1000 * input.summaryCost,
    projectedMonthlyCostUsd:
      ((judgeCostPer1000 + callsPer1000 * input.summaryCost) * input.monthlyItems) / 1000,
    interpretation:
      "Hypothetical routing, not successful replacements. Article routing volume from the original sample is multiplied by the audit-weighted poor/good share among routed audit articles. With no routed audit examples, quality estimates are null. Video label outcomes are unknown and excluded, not treated as good or poor. No replacement probe was performed.",
  };
}

const CLASSIFIERS = ["H0", "H1", "J", "L", "H1_J", "H1_L"] as const;
type Classifier = (typeof CLASSIFIERS)[number];
const ORDINAL = { unusable: 0, weak: 1, good: 2 } as const;

function requireJudgeRow(
  cache: Map<string, DescriptionJudgeCacheRow>,
  classifier: DescriptionClassifier,
  item: DescriptionSampleItem,
  run: number,
) {
  const key = descriptionJudgeCacheKey({
    classifier,
    itemId: item.id,
    textHash: descriptionTextHash(item),
    model: DESCRIPTION_JUDGE_MODELS[classifier],
    rubricVersion: DESCRIPTION_RUBRIC_VERSION,
    run,
  });
  return requireDefined(cache.get(key), `completed ${classifier} run ${run} for ${item.id}`);
}

export function requireDescriptionPriorRun(input: {
  items: readonly DescriptionSampleItem[];
  classifiers: readonly DescriptionClassifier[];
  cache: readonly DescriptionJudgeCacheRow[];
  run: number;
}) {
  if (input.run === 1) return;
  if (input.run !== 2) throw new Error("Frozen pilot permits only runs 1 and 2");
  const cache = new Map(input.cache.map((row) => [row.key, row]));
  for (const item of input.items) {
    for (const classifier of input.classifiers) requireJudgeRow(cache, classifier, item, 1);
  }
}

function measurement(
  item: DescriptionSampleItem,
  entry: DescriptionSampleEntry,
  audit: Map<string, DescriptionAuditEntry>,
  labels: Map<string, DescriptionHumanLabel>,
  cache: Map<string, DescriptionJudgeCacheRow>,
  repeated: ReadonlySet<string>,
  config: FrozenDescriptionConfig,
  run: number,
) {
  const j = requireJudgeRow(cache, "jev", item, run);
  const l = requireJudgeRow(cache, "llm", item, run);
  const jj = j.result.status === "ok" ? j.result.judgment : null;
  const lj = l.result.status === "ok" ? l.result.judgment : null;
  if ((jj !== null && jj.kind !== "jev") || (lj !== null && lj.kind !== "llm")) {
    throw new Error("Cached judgment kind does not match the requested classifier");
  }
  const jev = jj?.kind === "jev" ? jj : null;
  const llm = lj?.kind === "llm" ? lj : null;
  const jevDecision =
    j.result.status === "deterministic"
      ? "replace"
      : jev !== null
        ? descriptionJevDecision(jev, config.thresholds)
        : "error";
  const llmDecision =
    l.result.status === "deterministic"
      ? "replace"
      : llm !== null
        ? llm.quality === "unusable"
          ? "replace"
          : "keep"
        : "error";
  const jevLevel: DescriptionQuality | null =
    j.result.status === "deterministic"
      ? "unusable"
      : jev !== null
        ? jev.score < 0.5
          ? "unusable"
          : jev.score < 1.5
            ? "weak"
            : "good"
        : null;
  const llmLevel = l.result.status === "deterministic" ? "unusable" : (llm?.quality ?? null);
  const h1Reasons = descriptionHeuristicReasons(item, repeated, config.h1MinWords);
  const human = labels.has(item.id) ? requireDefined(labels.get(item.id), "audit label") : null;
  const auditWeight = audit.has(item.id)
    ? requireDefined(audit.get(item.id), "audit entry").auditWeight
    : null;
  if ((human === null) !== (auditWeight === null))
    throw new Error("Audit labels and weights differ");
  return {
    item,
    entry,
    human,
    auditWeight,
    j,
    l,
    jev,
    llm,
    jevDecision,
    llmDecision,
    jevLevel,
    llmLevel,
    h1Reasons,
    decisions: {
      H0: false,
      H1: h1Reasons.length > 0,
      J: jevDecision === "replace",
      L: llmDecision === "replace",
      H1_J: h1Reasons.length > 0 || jevDecision === "replace",
      H1_L: h1Reasons.length > 0 || llmDecision === "replace",
    } satisfies Record<Classifier, boolean>,
  };
}
type Measurement = ReturnType<typeof measurement>;

function classificationGroups(rows: readonly Measurement[]) {
  function group(selected: readonly Measurement[]) {
    return Object.fromEntries(
      CLASSIFIERS.map((classifier) => {
        const metricRows = selected.flatMap((row): DescriptionMetricRow[] =>
          row.human === null || row.auditWeight === null
            ? []
            : [
                {
                  label: row.human.label,
                  weight: row.auditWeight,
                  replace: row.decisions[classifier],
                },
              ],
        );
        return [
          classifier,
          {
            unweighted: descriptionClassification(metricRows),
            weighted: descriptionClassification(metricRows, true),
          },
        ];
      }),
    );
  }
  const origins = ["feed", "page_metadata", "ai_generated"] as const;
  return {
    overall: group(rows),
    byLanguage: Object.fromEntries(
      (["fi", "en"] as const).map((language) => [
        language,
        group(rows.filter((row) => row.item.language === language)),
      ]),
    ),
    byOrigin: Object.fromEntries(
      origins.map((origin) => [
        origin,
        group(rows.filter((row) => row.item.summary_origin === origin)),
      ]),
    ),
    h1AcceptedOnly: group(rows.filter((row) => row.h1Reasons.length === 0)),
    excludingAiGenerated: group(rows.filter((row) => row.item.summary_origin !== "ai_generated")),
  };
}
function paired(rows: readonly Measurement[], left: Classifier, right: Classifier) {
  let leftOnlyCorrect = 0,
    rightOnlyCorrect = 0,
    weightedLeftOnlyCorrect = 0,
    weightedRightOnlyCorrect = 0;
  let pairs = 0;
  for (const row of rows) {
    if (row.human === null || row.auditWeight === null) continue;
    pairs += 1;
    const target = row.human.label === "unusable";
    if (row.decisions[left] === target && row.decisions[right] !== target) {
      leftOnlyCorrect += 1;
      weightedLeftOnlyCorrect += row.auditWeight;
    }
    if (row.decisions[right] === target && row.decisions[left] !== target) {
      rightOnlyCorrect += 1;
      weightedRightOnlyCorrect += row.auditWeight;
    }
  }
  return {
    left,
    right,
    pairs,
    leftOnlyCorrect,
    rightOnlyCorrect,
    weightedLeftOnlyCorrect,
    weightedRightOnlyCorrect,
  };
}
function ordinal(rows: readonly Measurement[]) {
  const scored = rows.filter((row) => row.human !== null && row.jev !== null);
  function threeLevels(classifier: "jevLevel" | "llmLevel") {
    const pairs = rows.flatMap((row) =>
      row.human === null || row[classifier] === null
        ? []
        : [
            {
              human: row.human.label,
              model: row[classifier],
              weight: requireDefined(row.auditWeight, "ordinal weight"),
            },
          ],
    );
    function calculate(weighted: boolean) {
      const cells = Array.from({ length: 3 }, () => [0, 0, 0]);
      for (const pair of pairs) {
        const row = requireDefined(cells[ORDINAL[pair.human]], "ordinal confusion row");
        const column = ORDINAL[pair.model];
        row[column] =
          requireDefined(row[column], "ordinal confusion cell") + (weighted ? pair.weight : 1);
      }
      const total = pairs.reduce((sum, pair) => sum + (weighted ? pair.weight : 1), 0);
      const agreements = cells.reduce(
        (sum, row, index) => sum + requireDefined(row[index], "ordinal diagonal"),
        0,
      );
      let expectedNumerator = 0;
      for (let i = 0; i < 3; i += 1) {
        const rowTotal = requireDefined(cells[i], "ordinal row").reduce(
          (sum, value) => sum + value,
          0,
        );
        const columnTotal = cells.reduce(
          (sum, row) => sum + requireDefined(row[i], "ordinal column"),
          0,
        );
        expectedNumerator += rowTotal * columnTotal;
      }
      const agreement = ratio(agreements, total),
        expected = ratio(expectedNumerator, total * total);
      return {
        items: pairs.length,
        confusion: cells,
        order: ["unusable", "weak", "good"],
        agreement,
        kappa:
          agreement === null || expected === null || expected === 1
            ? null
            : (agreement - expected) / (1 - expected),
      };
    }
    return { unweighted: calculate(false), weighted: calculate(true) };
  }
  return {
    jevThreeLevel: threeLevels("jevLevel"),
    llmThreeLevel: threeLevels("llmLevel"),
    rounding:
      "Jev score rounded to nearest level for ordinal descriptions only; decisions use frozen p0/confidence thresholds.",
    jevScoredAuditItems: scored.length,
    jevSpearman: descriptionSpearman(
      scored.map((row) => ({
        score: requireDefined(row.jev, "scored judgment").score,
        ordinal: ORDINAL[requireDefined(row.human, "scored human label").label],
      })),
    ),
    jevAuc: Object.fromEntries(
      ([false, true] as const).map((weighted) => [
        weighted ? "weighted" : "unweighted",
        descriptionAuc(
          scored.map((row) => ({
            positive: requireDefined(row.human, "AUC human").label === "unusable",
            score: requireDefined(row.jev, "AUC judgment").probabilities["0"],
            weight: weighted ? requireDefined(row.auditWeight, "AUC weight") : 1,
          })),
        ),
      ]),
    ),
  };
}

function confidenceAndDiagnostics(rows: readonly Measurement[], config: FrozenDescriptionConfig) {
  const scored = rows.filter((row) => row.jev !== null);
  const auditScored = scored.filter((row) => row.human !== null);
  const bands = [
    [0, 0.5],
    [0.5, 0.8],
    [0.8, 1],
  ] as const;
  const diagnostics = [
    ["about_publisher", "boilerplate"],
    ["promotional", "promotional"],
    ["describes_page", "page_structure"],
  ] as const;
  return {
    scored: scored.length,
    confident: scored.filter(
      (row) =>
        requireDefined(row.jev, "confidence judgment").confidence >=
        config.thresholds.minConfidence,
    ).length,
    confidenceCoverage: ratio(
      scored.filter(
        (row) =>
          requireDefined(row.jev, "confidence judgment").confidence >=
          config.thresholds.minConfidence,
      ).length,
      scored.length,
    ),
    uncertain: rows.filter((row) => row.jevDecision === "uncertain").length,
    bands: bands.map(([lower, upper]) => {
      const selected = auditScored.filter((row) => {
        const confidence = requireDefined(row.jev, "band confidence").confidence;
        return confidence >= lower && (upper === 1 ? confidence <= upper : confidence < upper);
      });
      const correct = selected.filter(
        (row) =>
          row.decisions.J === (requireDefined(row.human, "band human label").label === "unusable"),
      ).length;
      return {
        lowerInclusive: lower,
        upper,
        upperInclusive: upper === 1,
        items: selected.length,
        correct,
        accuracy: ratio(correct, selected.length),
        wilson95: descriptionWilson(correct, selected.length),
      };
    }),
    diagnostics: diagnostics.map(([noul, reason]) => ({
      noul,
      humanReason: reason,
      items: auditScored.length,
      matchingReasons: auditScored.filter((row) => row.human?.reason === reason).length,
      auc: descriptionAuc(
        auditScored.map((row) => ({
          positive: row.human?.reason === reason,
          score: requireDefined(row.jev, "diagnostic judgment").nouls[noul],
          weight: 1,
        })),
      ),
      byHumanReason: Object.fromEntries(
        [...new Set(auditScored.map((row) => requireDefined(row.human, "diagnostic human").reason))]
          .sort()
          .map((humanReason) => {
            const matching = auditScored.filter((row) => row.human?.reason === humanReason);
            return [
              humanReason,
              {
                items: matching.length,
                meanProbability: ratio(
                  matching.reduce(
                    (sum, row) =>
                      sum + requireDefined(row.jev, "diagnostic probability").nouls[noul],
                    0,
                  ),
                  matching.length,
                ),
              },
            ];
          }),
      ),
      interpretation: "Descriptive diagnostic, not an independently validated quality gate",
    })),
  };
}

function operational(rows: readonly Measurement[], classifier: DescriptionClassifier) {
  const results = rows.map((row) => (classifier === "jev" ? row.j.result : row.l.result));
  const called = results.filter((result) => result.status !== "deterministic");
  const successes = results.filter((result) => result.status === "ok");
  const latencies = called
    .map((result) => requireDefined(result.attempts[0], "first attempt").latencyMs)
    .sort((a, b) => a - b);
  const errorStatuses: Record<string, number> = {};
  const attemptErrorStatuses: Record<string, number> = {};
  for (const result of called) {
    for (const attempt of result.attempts) {
      if (attempt.error !== null) {
        const key = `${attempt.status ?? "no_http_status"}:${attempt.error}`;
        attemptErrorStatuses[key] = (attemptErrorStatuses[key] ?? 0) + 1;
      }
    }
    if (result.status === "error") {
      const key = `${requireDefined(result.attempts.at(-1), "last error attempt").status ?? "no_http_status"}:${result.error}`;
      errorStatuses[key] = (errorStatuses[key] ?? 0) + 1;
    }
  }
  const inputTokens = successes.reduce((sum, result) => sum + result.inputTokens, 0);
  const outputTokens = successes.reduce((sum, result) => sum + result.outputTokens, 0);
  return {
    items: rows.length,
    calls: called.length,
    deterministic: results.length - called.length,
    errors: called.length - successes.length,
    errorRateAfterRetries: ratio(called.length - successes.length, called.length),
    errorStatuses,
    attemptErrorStatuses,
    retries: called.reduce((sum, result) => sum + result.retries, 0),
    requestedModel: DESCRIPTION_JUDGE_MODELS[classifier],
    resolvedModels: [...new Set(successes.map((result) => result.resolvedModel))],
    firstAttemptLatencyMs: {
      p50: latencies.length
        ? requireDefined(latencies[Math.ceil(latencies.length * 0.5) - 1], "p50")
        : null,
      p95: latencies.length
        ? requireDefined(latencies[Math.ceil(latencies.length * 0.95) - 1], "p95")
        : null,
      method: "nearest rank; sequential HTTP attempts, including failed first attempts",
    },
    inputTokens,
    outputTokens,
    inputTokensPerSuccessfulCall: ratio(inputTokens, successes.length),
    outputTokensPerSuccessfulCall: ratio(outputTokens, successes.length),
    estimatedCostUsd: successes.reduce((sum, result) => sum + result.estimatedCostUsd, 0),
    costIncomplete: called.some((result) => result.status === "error" || result.retries > 0),
    note: "Failed-attempt token usage is unknown; estimates use frozen standard rates, without cache discounts.",
  };
}

function agreement(rows: readonly Measurement[]) {
  const valid = rows.filter((row) => row.jevDecision !== "error" && row.llmDecision !== "error");
  const ordinalPairs = valid.filter((row) => row.jevLevel !== null && row.llmLevel !== null);
  const binaryAgree = valid.filter((row) => row.decisions.J === row.decisions.L).length;
  const ordinalAgree = ordinalPairs.filter((row) => row.jevLevel === row.llmLevel).length;
  return {
    items: rows.length,
    compared: valid.length,
    excludedErrors: rows.length - valid.length,
    binaryAgree,
    binaryAgreement: ratio(binaryAgree, valid.length),
    ordinalCompared: ordinalPairs.length,
    ordinalAgree,
    ordinalAgreement: ratio(ordinalAgree, ordinalPairs.length),
    interpretation: "Model agreement only; unlabelled items are not correctness evidence",
  };
}
function stability(
  first: readonly Measurement[],
  second: readonly Measurement[],
  classifier: DescriptionClassifier,
) {
  const later = new Map(second.map((row) => [row.item.id, row]));
  let compared = 0,
    identical = 0,
    identicalBinary = 0,
    ordinalCompared = 0,
    identicalOrdinal = 0,
    p0Pairs = 0,
    p0Difference = 0;
  for (const a of first) {
    const b = requireDefined(later.get(a.item.id), "stability pair");
    const aDecision = classifier === "jev" ? a.jevDecision : a.llmDecision;
    const bDecision = classifier === "jev" ? b.jevDecision : b.llmDecision;
    if (aDecision === "error" || bDecision === "error") continue;
    compared += 1;
    if (aDecision === bDecision) identical += 1;
    if (
      a.decisions[classifier === "jev" ? "J" : "L"] ===
      b.decisions[classifier === "jev" ? "J" : "L"]
    ) {
      identicalBinary += 1;
    }
    const aLevel = classifier === "jev" ? a.jevLevel : a.llmLevel;
    const bLevel = classifier === "jev" ? b.jevLevel : b.llmLevel;
    if (aLevel !== null && bLevel !== null) {
      ordinalCompared += 1;
      if (aLevel === bLevel) identicalOrdinal += 1;
    }
    if (classifier === "jev" && a.jev !== null && b.jev !== null) {
      p0Pairs += 1;
      p0Difference += Math.abs(a.jev.probabilities["0"] - b.jev.probabilities["0"]);
    }
  }
  return {
    items: first.length,
    compared,
    excludedErrors: first.length - compared,
    identical,
    identicalDecisionRate: ratio(identical, compared),
    decisionMeaning: classifier === "jev" ? "replace/uncertain/keep" : "replace/keep",
    identicalBinary,
    identicalBinaryDecisionRate: ratio(identicalBinary, compared),
    ordinalCompared,
    identicalOrdinal,
    identicalOrdinalRate: ratio(identicalOrdinal, ordinalCompared),
    p0Pairs,
    meanAbsoluteP0Difference: ratio(p0Difference, p0Pairs),
    meets98PercentObservation:
      compared === first.length && compared > 0 ? identical / compared >= 0.98 : null,
  };
}

function policySimulation(rows: readonly Measurement[], config: FrozenDescriptionConfig) {
  const populationWeight = rows.reduce(
    (sum, row) => sum + requireDefined(row.entry.weight, "policy population weight"),
    0,
  );
  const audited = rows.filter((row) => row.human !== null && row.auditWeight !== null);
  const auditWeight = audited.reduce(
    (sum, row) => sum + requireDefined(row.auditWeight, "policy audit weight"),
    0,
  );
  const map: Record<DescriptionPolicy, Classifier | "always"> = {
    P0: "H0",
    P1: "H1",
    P2: "J",
    P2_L: "L",
    P3: "H1_J",
    P3_L: "H1_L",
    P4: "always",
  };
  // Rates are fixed by the frozen, protocol-validated price table.
  const summaryCost =
    (config.policyProjection.summaryInputTokens * DESCRIPTION_JUDGE_PRICES.llm.inputPerMillion +
      config.policyProjection.summaryOutputTokens * DESCRIPTION_JUDGE_PRICES.llm.outputPerMillion) /
    1_000_000;
  return Object.fromEntries(
    (["P0", "P1", "P2", "P2_L", "P3", "P3_L", "P4"] as const).map((policy) => {
      const classifier = map[policy];
      const routes = (row: Measurement) => classifier === "always" || row.decisions[classifier];
      const judge =
        policy === "P2" || policy === "P3"
          ? "jev"
          : policy === "P2_L" || policy === "P3_L"
            ? "llm"
            : null;
      const judgeCostWeighted = rows.reduce((sum, row) => {
        if (judge === null || ((policy === "P3" || policy === "P3_L") && row.decisions.H1))
          return sum;
        const result = judge === "jev" ? row.j.result : row.l.result;
        return (
          sum +
          (result.status === "ok" ? result.estimatedCostUsd : 0) *
            requireDefined(row.entry.weight, "policy judge weight")
        );
      }, 0);
      return [
        policy,
        descriptionPolicyProjection({
          routedWeight: rows
            .filter(routes)
            .reduce((sum, row) => sum + requireDefined(row.entry.weight, "route weight"), 0),
          populationWeight,
          articleRoutedWeight: rows
            .filter((row) => row.item.type === "article" && routes(row))
            .reduce(
              (sum, row) => sum + requireDefined(row.entry.weight, "article population weight"),
              0,
            ),
          auditRoutedWeight: audited
            .filter(routes)
            .reduce((sum, row) => sum + requireDefined(row.auditWeight, "routed audit weight"), 0),
          auditWeight,
          judgeCostWeighted,
          poorRoutedWeight: audited
            .filter((row) => routes(row) && row.human?.label === "unusable")
            .reduce((sum, row) => sum + requireDefined(row.auditWeight, "poor audit weight"), 0),
          goodRoutedWeight: audited
            .filter((row) => routes(row) && row.human?.label === "good")
            .reduce((sum, row) => sum + requireDefined(row.auditWeight, "good audit weight"), 0),
          monthlyItems: config.policyProjection.monthlyItems,
          summaryCost,
        }),
      ];
    }),
  );
}

export function buildDescriptionPilotReport(input: {
  config: FrozenDescriptionConfig;
  sample: DescriptionSample;
  items: readonly DescriptionSampleItem[];
  auditEntries: readonly DescriptionAuditEntry[];
  auditLabels: readonly DescriptionHumanLabel[];
  repeatLabels: readonly DescriptionHumanLabel[];
  cache: readonly DescriptionJudgeCacheRow[];
  provenance: {
    generatedAt: string;
    configHash: string;
    cacheHash: string;
    gitCommit: string;
    workingTreeDirty: boolean;
    sourceCodeHash: string;
    configCommit: string;
  };
}) {
  const { config, sample } = input;
  const byItem = new Map(input.items.map((item) => [item.id, item]));
  const audit = new Map(input.auditEntries.map((entry) => [entry.itemId, entry]));
  const labels = new Map(input.auditLabels.map((label) => [label.itemId, label]));
  if (audit.size !== 30 || labels.size !== 30 || input.repeatLabels.length !== 10) {
    throw new Error("Pilot report requires 30 frozen audit labels and 10 repeat labels");
  }
  const repeated = findRepeatedDescriptions(input.items);
  const cache = new Map(input.cache.map((row) => [row.key, row]));
  const entries = [...sample.sets.test, ...sample.sets.videos];
  const runs = [1, 2].map((run) =>
    entries.map((entry) =>
      measurement(
        requireDefined(byItem.get(entry.itemId), "reported item"),
        entry,
        audit,
        labels,
        cache,
        repeated,
        config,
        run,
      ),
    ),
  );
  const first = requireDefined(runs[0], "first report run"),
    second = requireDefined(runs[1], "second report run");
  const articles = first.filter((row) => row.item.type === "article");
  const videos = first.filter((row) => row.item.type === "video");
  const repeatRows = input.repeatLabels.map((label) => {
    const initial = requireDefined(labels.get(label.itemId), "repeat original label");
    return { label: initial.label, replace: label.label === "unusable", weight: 1 };
  });
  const repeat = descriptionClassification(repeatRows);
  const h1Misses = first.filter((row) => row.human?.label === "unusable" && !row.decisions.H1);
  const missedWeight = h1Misses.reduce(
    (sum, row) => sum + requireDefined(row.auditWeight, "missed audit weight"),
    0,
  );
  const recoveredWeight = (classifier: "J" | "L") =>
    h1Misses
      .filter((row) => row.decisions[classifier])
      .reduce((sum, row) => sum + requireDefined(row.auditWeight, "recovered audit weight"), 0);
  const marginalValue = {
    h1MissedUnusable: h1Misses.length,
    jevRecovered: h1Misses.filter((row) => row.decisions.J).length,
    llmRecovered: h1Misses.filter((row) => row.decisions.L).length,
    jevRecoveryRate: ratio(h1Misses.filter((row) => row.decisions.J).length, h1Misses.length),
    llmRecoveryRate: ratio(h1Misses.filter((row) => row.decisions.L).length, h1Misses.length),
    weightedH1MissedUnusable: missedWeight,
    weightedJevRecovered: recoveredWeight("J"),
    weightedLlmRecovered: recoveredWeight("L"),
    weightedJevRecoveryRate: ratio(recoveredWeight("J"), missedWeight),
    weightedLlmRecoveryRate: ratio(recoveredWeight("L"), missedWeight),
    interpretation:
      "Audit-only exploratory counts; an empty denominator is insufficient evidence, not zero recovery.",
  };
  const publicRows = first.map((row) => ({
    itemId: row.item.id,
    type: row.item.type,
    language: row.item.language,
    origin: row.item.summary_origin,
    humanLabel: row.human?.label ?? null,
    humanReason: row.human?.reason ?? null,
    originalWeight: row.entry.weight,
    auditWeight: row.auditWeight,
    h1Reasons: row.h1Reasons,
    decisions: row.decisions,
    jev: {
      status: row.j.result.status,
      decision: row.jevDecision,
      p0: row.jev?.probabilities["0"] ?? null,
      score: row.jev?.score ?? null,
      confidence: row.jev?.confidence ?? null,
      nouls: row.jev?.nouls ?? null,
    },
    llm: { status: row.l.result.status, decision: row.llmDecision, quality: row.llmLevel },
    evidence: row.human === null ? "unlabelled; agreement only" : "human audit",
  }));
  const disagreements = publicRows
    .filter((row) =>
      row.humanLabel !== null
        ? row.decisions.J !== (row.humanLabel === "unusable") ||
          row.decisions.H1 !== (row.humanLabel === "unusable") ||
          row.decisions.L !== (row.humanLabel === "unusable")
        : row.decisions.J !== row.decisions.L ||
          row.decisions.J !== row.decisions.H1 ||
          row.jev.status === "error" ||
          row.llm.status === "error",
    )
    .sort((a, b) => {
      const aError = a.humanLabel !== null && a.decisions.J !== (a.humanLabel === "unusable");
      const bError = b.humanLabel !== null && b.decisions.J !== (b.humanLabel === "unusable");
      return (
        Number(bError) - Number(aError) ||
        (b.jev.confidence ?? -1) - (a.jev.confidence ?? -1) ||
        a.itemId.localeCompare(b.itemId)
      );
    });
  const operations = runs.map((rows, index) => ({
    run: index + 1,
    overall: { jev: operational(rows, "jev"), llm: operational(rows, "llm") },
    articles: {
      jev: operational(
        rows.filter((row) => row.item.type === "article"),
        "jev",
      ),
      llm: operational(
        rows.filter((row) => row.item.type === "article"),
        "llm",
      ),
    },
    videos: {
      jev: operational(
        rows.filter((row) => row.item.type === "video"),
        "jev",
      ),
      llm: operational(
        rows.filter((row) => row.item.type === "video"),
        "llm",
      ),
    },
  }));
  const report = {
    schemaVersion: 1,
    experiment: "description-quality-reduced-pilot",
    provenance: {
      ...input.provenance,
      snapshotManifestHash: config.snapshotManifestHash,
      sampleHash: config.sampleHash,
      auditDesignHash: config.auditDesignHash,
      labelCsvHashes: config.labelCsvHashes,
      rubricVersion: DESCRIPTION_RUBRIC_VERSION,
    },
    thresholds: config.thresholds,
    h1MinWords: config.h1MinWords,
    counts: {
      testArticles: articles.length,
      videoCensus: videos.length,
      humanAudit: labels.size,
      unlabelledArticles: articles.length - labels.size,
    },
    classification: classificationGroups(articles),
    ordinal: ordinal(articles),
    confidenceAndDiagnostics: confidenceAndDiagnostics(articles, config),
    paired: [paired(articles, "J", "H1"), paired(articles, "L", "H1"), paired(articles, "J", "L")],
    marginalValue,
    humanConsistency: {
      items: repeat.sampleItems,
      binaryAgreement: repeat.accuracy,
      binaryKappa: repeat.binaryKappa,
      ordinalAgreement: ratio(
        input.repeatLabels.filter((label) => labels.get(label.itemId)?.label === label.label)
          .length,
        input.repeatLabels.length,
      ),
      reasonAgreement: ratio(
        input.repeatLabels.filter((label) => labels.get(label.itemId)?.reason === label.reason)
          .length,
        input.repeatLabels.length,
      ),
    },
    agreement: { articles: agreement(articles), videos: agreement(videos) },
    stability: {
      articles: {
        jev: stability(
          articles,
          second.filter((row) => row.item.type === "article"),
          "jev",
        ),
        llm: stability(
          articles,
          second.filter((row) => row.item.type === "article"),
          "llm",
        ),
      },
      videos: {
        jev: stability(
          videos,
          second.filter((row) => row.item.type === "video"),
          "jev",
        ),
        llm: stability(
          videos,
          second.filter((row) => row.item.type === "video"),
          "llm",
        ),
      },
    },
    operations,
    policySimulation: policySimulation(first, config),
    representedPopulation: first.reduce(
      (sum, row) => sum + requireDefined(row.entry.weight, "population weight"),
      0,
    ),
    replacementProbe: "deferred; replacement benefit not measured",
    productionReadiness: "not assessed; insufficient evidence",
    limitations: [
      "Exploratory 30-item single-human audit; original 150-item model sample is not fully human-labelled.",
      "Audit weights are two-stage conditional estimates. Policy quality estimates calibrate article routing volumes to the weighted label mix among routed audit articles; no routed audit examples means insufficient evidence. Video quality is unknown.",
      "No per-language accuracy or <=5% false-replacement certification, even if point estimates meet reference targets.",
      "Uncertain/error judgments keep the original description in binary policy metrics; error statuses remain explicit.",
      "Raw agreement and kappa on 10 repeat labels are descriptive; class imbalance can make kappa low despite high agreement.",
      "Videos are an unlabelled descriptive census, not accuracy evidence.",
      "Jev score rounding is used only for ordinal descriptions, never for replacement decisions.",
      "OpenAI judges some descriptions generated by the same model; see excludingAiGenerated results.",
      "No article-level factual verification, replacement probe, or measured replacement improvement.",
      "Only public title/description/language/type went to providers; no user data or human labels. TypeSafe says customer requests are not training data; zero retention is enterprise-only.",
      "Unknown failed-attempt usage is not included in successful-response token/cost estimates.",
    ],
    items: publicRows,
    disagreements,
  };
  const localColumns = [
    "item_id",
    "title",
    "description",
    "evidence",
    "human_label",
    "human_reason",
    "h1_reasons",
    "jev_status",
    "jev_decision",
    "jev_p0",
    "jev_score",
    "jev_confidence",
    "jev_nouls",
    "llm_status",
    "llm_quality",
  ];
  const localCsv = encodeCsv([
    localColumns,
    ...disagreements.map((row) => {
      const item = requireDefined(byItem.get(row.itemId), "disagreement item");
      return [
        row.itemId,
        item.title,
        item.summary.slice(0, 400),
        row.evidence,
        row.humanLabel ?? "",
        row.humanReason ?? "",
        row.h1Reasons.join("|"),
        row.jev.status,
        row.jev.decision,
        String(row.jev.p0 ?? ""),
        String(row.jev.score ?? ""),
        String(row.jev.confidence ?? ""),
        JSON.stringify(row.jev.nouls),
        row.llm.status,
        row.llm.quality ?? "",
      ];
    }),
  ]);
  const csv = encodeCsv([
    [
      "item_id",
      "type",
      "language",
      "origin",
      "evidence",
      "human_label",
      "human_reason",
      "h1_reasons",
      "jev_status",
      "jev_decision",
      "jev_p0",
      "jev_score",
      "jev_confidence",
      "llm_status",
      "llm_quality",
    ],
    ...publicRows.map((row) => [
      row.itemId,
      row.type,
      row.language,
      row.origin,
      row.evidence,
      row.humanLabel ?? "",
      row.humanReason ?? "",
      row.h1Reasons.join("|"),
      row.jev.status,
      row.jev.decision,
      String(row.jev.p0 ?? ""),
      String(row.jev.score ?? ""),
      String(row.jev.confidence ?? ""),
      row.llm.status,
      row.llm.quality ?? "",
    ]),
  ]);
  function markdown(): string {
    const fmt = (value: number | null) =>
      value === null ? "insufficient evidence" : `${(value * 100).toFixed(1)}%`;
    const metricRows = CLASSIFIERS.map((classifier) => {
      const result = requireDefined(
        report.classification.overall[classifier],
        "classification result",
      );
      const m = result.unweighted,
        w = result.weighted;
      return `| ${classifier} | ${m.tp}/${m.tp + m.fp} | ${m.tp}/${m.tp + m.fn} | ${fmt(m.precision)} / ${fmt(w.precision)} | ${fmt(m.recall)} / ${fmt(w.recall)} | ${fmt(m.f1)} / ${fmt(w.f1)} | ${fmt(m.falseReplacementRate)} / ${fmt(w.falseReplacementRate)} |`;
    });
    const opRows = report.operations.flatMap((run) =>
      (["jev", "llm"] as const).map((classifier) => {
        const op = run.overall[classifier];
        return `| ${run.run} | ${classifier} | ${op.calls} | ${op.deterministic} | ${op.errors} | ${op.retries} | ${op.firstAttemptLatencyMs.p50 ?? "N/A"} / ${op.firstAttemptLatencyMs.p95 ?? "N/A"} | $${op.estimatedCostUsd.toFixed(6)} |`;
      }),
    );
    const policyRows = Object.entries(report.policySimulation).map(
      ([name, p]) =>
        `| ${name} | ${p.generationCallsPer1000.toFixed(1)} | ${p.estimatedPoorDescriptionsRoutedPer1000?.toFixed(1) ?? "insufficient evidence"} | ${p.estimatedGoodDescriptionsWronglyRoutedPer1000?.toFixed(1) ?? "insufficient evidence"} | $${p.projectedMonthlyCostUsd.toFixed(3)} |`,
    );
    const disagreementRows = report.disagreements.map(
      (row) =>
        `| ${row.itemId} | ${row.humanLabel ?? "unlabelled"} | ${row.h1Reasons.join(", ") || "accept"} | ${row.jev.decision} | ${row.jev.p0 ?? "N/A"} | ${row.jev.confidence ?? "N/A"} | ${row.llm.quality ?? row.llm.status} |`,
    );
    const languages = (["fi", "en"] as const).map((language) => {
      const metrics = requireDefined(
        report.classification.byLanguage[language],
        "language metrics",
      );
      const j = requireDefined(metrics.J, "language Jev metric").unweighted;
      return `- ${language}: ${j.sampleItems} human labels, ${j.humanUnusable} unusable and ${j.humanGood} good; Jev precision ${fmt(j.precision)}, recall ${fmt(j.recall)}. Insufficient evidence for language certification.`;
    });
    return [
      "# Description-quality pilot report",
      "",
      "**Exploratory only. No production-readiness or replacement-benefit claim.**",
      "",
      `Config SHA-256: \`${report.provenance.configHash}\``,
      `Git HEAD: \`${report.provenance.gitCommit}\`; working tree dirty: ${report.provenance.workingTreeDirty}. Source hash: \`${report.provenance.sourceCodeHash}\`.`,
      `Snapshot: \`${report.provenance.snapshotManifestHash}\`; rubric: \`${report.provenance.rubricVersion}\`.`,
      `Audit CSV: \`${report.provenance.labelCsvHashes.audit}\`.`,
      `Models: ${report.operations[0]?.overall.jev.resolvedModels.join(", ")}; ${report.operations[0]?.overall.llm.resolvedModels.join(", ")}.`,
      "",
      `Model sample: ${report.counts.testArticles} articles and ${report.counts.videoCensus} videos. Accuracy uses only ${report.counts.humanAudit} audit labels; ${report.counts.unlabelledArticles} articles remain unlabelled.`,
      "",
      "## Audit classification",
      "",
      "Unweighted / two-stage weighted point estimates. Denominators below are raw counts. Wilson intervals, confusion matrices, kappa, per-origin results, H1-accepted-only results, and AI-origin exclusions are in the JSON report.",
      "",
      "| Classifier | Correct / all replacements | Found / all unusable | Precision U/W | Recall U/W | F1 U/W | Good falsely replaced U/W |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...metricRows,
      "",
      "## Languages",
      "",
      ...languages,
      "",
      "## Agreement and stability",
      "",
      `Human delayed-repeat agreement: ${fmt(report.humanConsistency.binaryAgreement)}, kappa ${report.humanConsistency.binaryKappa ?? "undefined"} on ${report.humanConsistency.items} items; descriptive only.`,
      `Article J/L binary agreement: ${fmt(report.agreement.articles.binaryAgreement)}; this is not correctness on unlabelled items.`,
      `Article decision stability: Jev replace/uncertain/keep ${fmt(report.stability.articles.jev.identicalDecisionRate)}; binary replace/keep ${fmt(report.stability.articles.jev.identicalBinaryDecisionRate)}. L binary replace/keep ${fmt(report.stability.articles.llm.identicalDecisionRate)}.`,
      `Jev mean absolute p0 difference: ${report.stability.articles.jev.meanAbsoluteP0Difference ?? "undefined"}.`,
      `H1 misses ${report.marginalValue.h1MissedUnusable} audit unusable items; J recovers ${report.marginalValue.jevRecovered}, L recovers ${report.marginalValue.llmRecovered}.`,
      "",
      "## Operations",
      "",
      "| Run | Judge | HTTP calls | Deterministic | Errors | Retries | p50 / p95 ms | Estimated cost |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...opRows,
      "",
      "## Hypothetical policies",
      "",
      "Per 1,000 snapshot items. Article routing volumes are multiplied by the audit-weighted poor/good share among routed audit articles. With no routed audit examples, quality estimates are insufficient evidence. Video outcomes are unknown. No successful replacements were measured. Monthly costs use frozen token prices and 5,400 new items.",
      "",
      "| Policy | Generation calls | Poor routed (estimated) | Good wrongly routed (estimated) | Monthly cost |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...policyRows,
      "",
      "## Disagreements (IDs only)",
      "",
      "Confident Jev errors on labelled items come first. Unlabelled rows are model/rule disagreements, not errors against ground truth. Full title/description/Noul details remain in the local gitignored disagreement CSV.",
      "",
      "| Item ID | Human | H1 | Jev | p0 | Confidence | L |",
      "| --- | --- | --- | --- | ---: | ---: | --- |",
      ...disagreementRows,
      "",
      "## Limitations",
      "",
      ...report.limitations.map((limitation) => `- ${limitation}`),
      "",
    ].join("\n");
  }
  return { report, csv, localCsv, markdown: markdown() };
}
