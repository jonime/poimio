import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_JUDGE_MODELS,
  DESCRIPTION_JUDGE_PRICES,
  DESCRIPTION_RUBRIC_VERSION,
  type DescriptionJudgeCacheRow,
  descriptionJudgeCacheKey,
  descriptionJudgeProtocolHash,
} from "./evaluation-description-judges.ts";
import {
  createDescriptionSample,
  type DescriptionSampleItem,
  descriptionBlindCsv,
  descriptionTextHash,
} from "./evaluation-description-quality.ts";
import {
  buildDescriptionPilotReport,
  type DescriptionAuditEntry,
  type DescriptionHumanLabel,
  descriptionAuc,
  descriptionClassification,
  descriptionPolicyProjection,
  descriptionSpearman,
  descriptionWilson,
  type FrozenDescriptionConfig,
  parseFrozenDescriptionConfig,
  requireCommittedDescriptionConfig,
  requireDescriptionPriorRun,
  validateFrozenDescriptionEvidence,
} from "./evaluation-description-report.ts";
import { sha256 } from "./evaluation-snapshot.ts";
import { descriptionJudgingConfig, setJudgingAnswer } from "./manual-judging.ts";
import { requireDefined } from "./required.ts";

describe("description pilot statistics", () => {
  it("matches hand-computed weighted precision, recall, kappa, F1, and false-good replacements", () => {
    const rows = [
      { label: "unusable" as const, replace: true, weight: 2 },
      { label: "good" as const, replace: true, weight: 1 },
      { label: "good" as const, replace: false, weight: 2 },
      { label: "unusable" as const, replace: false, weight: 1 },
    ];
    const weighted = descriptionClassification(rows, true);
    expect(weighted).toMatchObject({ tp: 2, fp: 1, tn: 2, fn: 1, goodWeight: 3, falseGood: 1 });
    expect(weighted.precision).toBeCloseTo(2 / 3);
    expect(weighted.recall).toBeCloseTo(2 / 3);
    expect(weighted.f1).toBeCloseTo(2 / 3);
    expect(weighted.falseReplacementRate).toBeCloseTo(1 / 3);
    expect(weighted.binaryKappa).toBeCloseTo(1 / 3);
    expect(weighted.effectiveSampleSize).toBeCloseTo(36 / 10);
    expect(weighted.wilson95).toBeNull();
    const unweighted = descriptionClassification(rows);
    expect(unweighted.precision).toBe(0.5);
    expect(unweighted.recall).toBe(0.5);
    expect(unweighted.binaryKappa).toBe(0);
    expect(unweighted.falseReplacementRate).toBe(0.5);
  });

  it("reports undefined metrics honestly for empty and constant-label cells", () => {
    const empty = descriptionClassification([]);
    expect(empty).toMatchObject({
      sampleItems: 0,
      precision: null,
      recall: null,
      binaryKappa: null,
      falseReplacementRate: null,
    });
    const constant = descriptionClassification([{ label: "good", replace: false, weight: 1 }]);
    expect(constant.binaryKappa).toBeNull();
    expect(constant.recall).toBeNull();
    expect(() =>
      descriptionClassification([{ label: "good", replace: false, weight: 0 }]),
    ).toThrow();
    const weak = descriptionClassification([{ label: "weak", replace: true, weight: 1 }]);
    expect(weak.fp).toBe(1);
    expect(weak.falseGood).toBe(0);
  });

  it("matches known 95% Wilson bounds and handles zero observations", () => {
    const interval = requireDefined(descriptionWilson(1, 2) ?? undefined, "Wilson interval");
    expect(interval[0]).toBeCloseTo(0.0945312);
    expect(interval[1]).toBeCloseTo(0.9054688);
    expect(descriptionWilson(0, 0)).toBeNull();
    expect(descriptionWilson(0, 10)?.[1]).toBeCloseTo(0.2775328);
    expect(() => descriptionWilson(2, 1)).toThrow();
    expect(() => descriptionWilson(0.5, 2)).toThrow();
  });

  it("calculates tied-score AUC and rank correlation, not raw-score Pearson correlation", () => {
    expect(
      descriptionAuc([
        { positive: true, score: 0.9, weight: 2 },
        { positive: true, score: 0.5, weight: 1 },
        { positive: false, score: 0.5, weight: 2 },
        { positive: false, score: 0.1, weight: 1 },
      ]),
    ).toBeCloseTo(8 / 9);
    expect(descriptionAuc([{ positive: false, score: 0.3, weight: 1 }])).toBeNull();
    expect(
      descriptionSpearman([
        { score: 1, ordinal: 1 },
        { score: 10, ordinal: 2 },
        { score: 100, ordinal: 3 },
      ]),
    ).toBe(1);
    expect(
      descriptionSpearman([
        { score: 1, ordinal: 2 },
        { score: 1, ordinal: 2 },
        { score: 2, ordinal: 1 },
      ]),
    ).toBe(-1);
    expect(descriptionSpearman([{ score: 1, ordinal: 1 }])).toBeNull();
  });

  it("matches hand-computed policy routing and separates model calls from audit estimates", () => {
    const projection = descriptionPolicyProjection({
      routedWeight: 3,
      populationWeight: 6,
      poorRoutedWeight: 2,
      goodRoutedWeight: 1,
      auditWeight: 6,
      auditRoutedWeight: 3,
      articleRoutedWeight: 3,
      judgeCostWeighted: 0.00006,
      monthlyItems: 5400,
      summaryCost: 0.0007,
    });
    expect(projection.generationCallsPer1000).toBe(500);
    expect(projection.estimatedPoorDescriptionsRoutedPer1000).toBeCloseTo(1000 / 3);
    expect(projection.estimatedGoodDescriptionsWronglyRoutedPer1000).toBeCloseTo(1000 / 6);
    expect(projection.judgeCostPer1000Usd).toBeCloseTo(0.01);
    expect(projection.generationCostPer1000Usd).toBeCloseTo(0.35);
    expect(projection.projectedMonthlyCostUsd).toBeCloseTo(1.944);
    const articlesOnly = descriptionPolicyProjection({
      routedWeight: 3,
      populationWeight: 6,
      poorRoutedWeight: 2,
      goodRoutedWeight: 1,
      auditWeight: 6,
      auditRoutedWeight: 3,
      articleRoutedWeight: 1.5,
      judgeCostWeighted: 0.00006,
      monthlyItems: 5400,
      summaryCost: 0.0007,
    });
    expect(articlesOnly.generationCallsPer1000).toBe(500);
    expect(articlesOnly.estimatedPoorDescriptionsRoutedPer1000).toBeCloseTo(1000 / 6);
    expect(articlesOnly.estimatedGoodDescriptionsWronglyRoutedPer1000).toBeCloseTo(1000 / 12);
    expect(() =>
      descriptionPolicyProjection({
        routedWeight: 7,
        populationWeight: 6,
        poorRoutedWeight: 2,
        goodRoutedWeight: 1,
        auditWeight: 6,
        auditRoutedWeight: 3,
        articleRoutedWeight: 3,
        judgeCostWeighted: 0,
        monthlyItems: 5400,
        summaryCost: 0.0007,
      }),
    ).toThrow();
  });

  it("does not invent quality estimates when a routed policy has no human examples", () => {
    const projection = descriptionPolicyProjection({
      routedWeight: 3,
      populationWeight: 6,
      poorRoutedWeight: 0,
      goodRoutedWeight: 0,
      auditWeight: 6,
      auditRoutedWeight: 0,
      articleRoutedWeight: 3,
      judgeCostWeighted: 0,
      monthlyItems: 5400,
      summaryCost: 0.0007,
    });
    expect(projection.generationCallsPer1000).toBe(500);
    expect(projection.estimatedPoorDescriptionsRoutedPer1000).toBeNull();
    expect(projection.estimatedGoodDescriptionsWronglyRoutedPer1000).toBeNull();
    const coherent = descriptionPolicyProjection({
      routedWeight: 0.5,
      populationWeight: 6,
      poorRoutedWeight: 2,
      goodRoutedWeight: 1,
      auditWeight: 6,
      auditRoutedWeight: 3,
      articleRoutedWeight: 0.5,
      judgeCostWeighted: 0,
      monthlyItems: 5400,
      summaryCost: 0.0007,
    });
    expect(
      requireDefined(
        coherent.estimatedPoorDescriptionsRoutedPer1000 ?? undefined,
        "poor estimate",
      ) +
        requireDefined(
          coherent.estimatedGoodDescriptionsWronglyRoutedPer1000 ?? undefined,
          "good estimate",
        ),
    ).toBeCloseTo(coherent.generationCallsPer1000);
  });
});

function configuration() {
  const hash = sha256("fixture");
  return {
    schemaVersion: 1,
    rubricVersion: DESCRIPTION_RUBRIC_VERSION,
    requestProtocolHash: descriptionJudgeProtocolHash(),
    models: DESCRIPTION_JUDGE_MODELS,
    pricesUsdPerMillionTokens: DESCRIPTION_JUDGE_PRICES,
    thresholds: { replaceProbability: 0.8, minConfidence: 0.5 },
    h1MinWords: null,
    plannedTestRuns: [1, 2],
    uncertainBinaryDecision: "keep",
    llmReplaceLabel: "unusable",
    decisionOrder: [
      "deterministic_empty_or_placeholder",
      "uncertain_if_confidence_below_minimum",
      "replace_if_p0_at_least_threshold",
      "keep",
    ],
    sampleHash: hash,
    snapshotManifestHash: hash,
    auditDesignHash: hash,
    repeatDesignHash: hash,
    labelCsvHashes: { dev: hash, audit: hash, repeat: hash },
    finalizedLabelsHash: hash,
    finalizedRepeatLabelsHash: hash,
    devCacheHashAtFreeze: hash,
    devSummaryHash: hash,
    policyProjection: { monthlyItems: 5400, summaryInputTokens: 6000, summaryOutputTokens: 200 },
  };
}
function fixture() {
  const items: DescriptionSampleItem[] = Array.from({ length: 182 }, (_, index) => ({
    id: `item-${index}`,
    source_id: "source",
    title: `Private fixture title ${index}`,
    summary: `Private fixture description ${index}`,
    language: index % 2 === 0 ? "fi" : "en",
    summary_origin: "feed",
    type: index < 180 ? "article" : "video",
    url: `https://example.com/${index}`,
  }));
  const sample = createDescriptionSample({
    items,
    snapshotManifestHash: sha256("fixture"),
    seed: 1,
  });
  const auditEntries: DescriptionAuditEntry[] = sample.sets.test.slice(0, 30).map((entry) => ({
    ...entry,
    auditInclusionProbability: 1,
    auditWeight: requireDefined(entry.weight ?? undefined, "test weight"),
  }));
  const auditLabels: DescriptionHumanLabel[] = auditEntries.map((entry, index) => ({
    itemId: entry.itemId,
    label: index % 5 === 0 ? "unusable" : "good",
    reason: index % 5 === 0 ? "vague" : "none",
  }));
  const repeatLabels = auditLabels.slice(0, 10);
  const labels = new Map(auditLabels.map((label) => [label.itemId, label]));
  const ids = new Set([...sample.sets.test, ...sample.sets.videos].map((entry) => entry.itemId));
  const cache: DescriptionJudgeCacheRow[] = [1, 2].flatMap((run) =>
    items
      .filter((item) => ids.has(item.id))
      .flatMap((item) =>
        (["jev", "llm"] as const).map((classifier): DescriptionJudgeCacheRow => {
          const label = labels.get(item.id)?.label ?? "good";
          const replace = label === "unusable";
          const identity = {
            classifier,
            itemId: item.id,
            textHash: descriptionTextHash(item),
            model: DESCRIPTION_JUDGE_MODELS[classifier],
            rubricVersion: DESCRIPTION_RUBRIC_VERSION,
            run,
          };
          return {
            ...identity,
            key: descriptionJudgeCacheKey(identity),
            recordedAt: "2026-11-17T15:00:00Z",
            result: {
              status: "ok",
              resolvedModel: DESCRIPTION_JUDGE_MODELS[classifier],
              inputTokens: 100,
              outputTokens: 10,
              estimatedCostUsd: 0.00001,
              attempts: [{ status: 200, latencyMs: run * 100, error: null }],
              retries: 0,
              judgment:
                classifier === "llm"
                  ? { kind: "llm", quality: label }
                  : {
                      kind: "jev",
                      score: replace ? 0 : 2,
                      confidence: 1,
                      probabilities: { "0": replace ? 1 : 0, "1": 0, "2": replace ? 0 : 1 },
                      legend: { "0": "unusable", "1": "weak", "2": "good" },
                      nouls: { about_publisher: 0, promotional: 0, describes_page: 0 },
                    },
            },
          };
        }),
      ),
  );
  const config: FrozenDescriptionConfig = parseFrozenDescriptionConfig(
    JSON.stringify(configuration()),
  );
  return {
    config,
    sample,
    items,
    auditEntries,
    auditLabels,
    repeatLabels,
    cache,
    provenance: {
      generatedAt: "2026-11-17T16:00:00Z",
      configHash: sha256("config"),
      cacheHash: sha256("cache"),
      gitCommit: "commit",
      workingTreeDirty: true,
      sourceCodeHash: sha256("source"),
      configCommit: "config-commit",
    },
  };
}

describe("held-out description guard", () => {
  it("binds complete audit/repeat answers to the frozen designs, CSV hashes, and finalized labels", () => {
    const input = fixture();
    const devLabels: DescriptionHumanLabel[] = input.sample.sets.dev.map((entry) => ({
      itemId: entry.itemId,
      label: "good",
      reason: "none",
    }));
    function csv(entries: typeof input.sample.sets.dev, labels: DescriptionHumanLabel[]) {
      let text = descriptionBlindCsv(entries, input.items);
      for (let index = 0; index < labels.length; index += 1) {
        const label = requireDefined(labels[index], "fixture label");
        text = setJudgingAnswer(text, index, "quality", label.label, descriptionJudgingConfig);
        text = setJudgingAnswer(text, index, "reason", label.reason, descriptionJudgingConfig);
      }
      return text;
    }
    const sampleText = JSON.stringify(input.sample);
    const devCsv = csv(input.sample.sets.dev, devLabels);
    const auditCsv = csv(input.auditEntries, input.auditLabels);
    const repeatCsv = csv(input.auditEntries.slice(0, 10), input.repeatLabels);
    const auditText = JSON.stringify({
      sampleHash: sha256(sampleText),
      entries: input.auditEntries,
    });
    const repeatText = JSON.stringify({
      blindIds: input.auditEntries.slice(0, 10).map((entry) => entry.blindId),
      auditDesignHash: sha256(auditText),
      auditLabelsHash: sha256(auditCsv),
      completedAt: "2026-11-16T08:00:00Z",
      preparedAt: "2026-11-17T08:00:00Z",
    });
    const jsonl = (labels: DescriptionHumanLabel[]) =>
      [...labels]
        .sort((a, b) => a.itemId.localeCompare(b.itemId))
        .map((row) => JSON.stringify(row))
        .join("\n");
    const texts = {
      sample: sampleText,
      audit: auditText,
      repeat: repeatText,
      devCsv,
      auditCsv,
      repeatCsv,
      labels: jsonl([...devLabels, ...input.auditLabels]),
      repeatLabels: jsonl(input.repeatLabels),
      devSummary: "{}",
    };
    const config: FrozenDescriptionConfig = {
      ...input.config,
      sampleHash: sha256(sampleText),
      auditDesignHash: sha256(auditText),
      repeatDesignHash: sha256(repeatText),
      labelCsvHashes: {
        dev: sha256(devCsv),
        audit: sha256(auditCsv),
        repeat: sha256(repeatCsv),
      },
      finalizedLabelsHash: sha256(texts.labels),
      finalizedRepeatLabelsHash: sha256(texts.repeatLabels),
      devSummaryHash: sha256(texts.devSummary),
    };
    const result = validateFrozenDescriptionEvidence({
      config,
      texts,
      sample: input.sample,
      items: input.items,
    });
    expect(result.auditLabels).toEqual(input.auditLabels);
    expect(result.repeatLabels).toEqual(input.repeatLabels);
    expect(() =>
      validateFrozenDescriptionEvidence({
        config,
        texts: { ...texts, auditCsv: `${auditCsv}\n` },
        sample: input.sample,
        items: input.items,
      }),
    ).toThrow(/evidence hash mismatch/u);
    const wrongLabels = texts.labels.replace('"label":"good"', '"label":"weak"');
    expect(() =>
      validateFrozenDescriptionEvidence({
        config: { ...config, finalizedLabelsHash: sha256(wrongLabels) },
        texts: { ...texts, labels: wrongLabels },
        sample: input.sample,
        items: input.items,
      }),
    ).toThrow(/Finalized labels do not match/u);
    const earlyRepeat = repeatText.replace("2026-11-17T08:00:00Z", "2026-11-17T07:59:59Z");
    expect(() =>
      validateFrozenDescriptionEvidence({
        config: { ...config, repeatDesignHash: sha256(earlyRepeat) },
        texts: { ...texts, repeat: earlyRepeat },
        sample: input.sample,
        items: input.items,
      }),
    ).toThrow(/Invalid delayed repeat/u);
  });

  it("requires a committed exact config and rejects invalid settings", () => {
    requireCommittedDescriptionConfig("same", "same");
    expect(() => requireCommittedDescriptionConfig("changed", "same")).toThrow(/Commit/u);
    expect(
      parseFrozenDescriptionConfig(JSON.stringify(configuration())).thresholds.replaceProbability,
    ).toBe(0.8);
    expect(() =>
      parseFrozenDescriptionConfig(
        JSON.stringify({ ...configuration(), plannedTestRuns: [1, 2, 3] }),
      ),
    ).toThrow();
    expect(() =>
      parseFrozenDescriptionConfig(
        JSON.stringify({
          ...configuration(),
          thresholds: { minConfidence: -1, replaceProbability: 0.8 },
        }),
      ),
    ).toThrow();
  });

  it("requires the first measurement before stability and never defaults missing rows to keep", () => {
    const input = fixture();
    const ids = new Set(input.sample.sets.test.map((entry) => entry.itemId));
    const items = input.items.filter((item) => ids.has(item.id));
    requireDescriptionPriorRun({ items, classifiers: ["jev", "llm"], cache: input.cache, run: 2 });
    expect(() =>
      requireDescriptionPriorRun({ items, classifiers: ["jev"], cache: [], run: 2 }),
    ).toThrow(/completed jev run 1/u);
    expect(() =>
      requireDescriptionPriorRun({ items, classifiers: ["jev"], cache: [], run: 3 }),
    ).toThrow(/only runs 1 and 2/u);
    expect(() => buildDescriptionPilotReport({ ...input, cache: input.cache.slice(1) })).toThrow(
      /completed/u,
    );
  });
});

describe("held-out description report", () => {
  it("uses only human audit labels for accuracy and keeps titles/descriptions out of publishable reports", () => {
    const input = fixture();
    const built = buildDescriptionPilotReport(input);
    expect(built.report.counts).toEqual({
      testArticles: 150,
      videoCensus: 2,
      humanAudit: 30,
      unlabelledArticles: 120,
    });
    expect(built.report.classification.overall.J?.unweighted).toMatchObject({
      sampleItems: 30,
      tp: 6,
      fp: 0,
      fn: 0,
    });
    expect(built.report.agreement.articles.compared).toBe(150);
    expect(built.report.stability.articles.jev.identicalDecisionRate).toBe(1);
    expect(built.report.stability.articles.jev.meanAbsoluteP0Difference).toBe(0);
    expect(built.report.operations[0]?.overall.jev.calls).toBe(152);
    expect(built.report.humanConsistency.binaryKappa).toBe(1);
    const published = JSON.stringify(built.report) + built.csv + built.markdown;
    expect(published).not.toContain("Private fixture title");
    expect(published).not.toContain("Private fixture description");
    expect(built.localCsv).toContain("Private fixture title");
    const auditIds = new Set(input.auditLabels.map((label) => label.itemId));
    const changed = input.cache.map(
      (row): DescriptionJudgeCacheRow => ({
        ...row,
        result:
          row.result.status === "ok" &&
          row.result.judgment.kind === "llm" &&
          !auditIds.has(row.itemId)
            ? { ...row.result, judgment: { kind: "llm", quality: "unusable" } }
            : row.result,
      }),
    );
    const unlabelledChanged = buildDescriptionPilotReport({ ...input, cache: changed });
    expect(unlabelledChanged.report.classification).toEqual(built.report.classification);
    expect(unlabelledChanged.report.agreement.articles.binaryAgreement).toBeLessThan(1);
    expect(
      unlabelledChanged.report.items.filter(
        (row) => row.type === "article" && row.humanLabel === null,
      ),
    ).toHaveLength(120);
  });

  it("distinguishes confidence-band changes from binary replacement instability", () => {
    const input = fixture();
    const row = requireDefined(
      input.cache.find(
        (candidate) =>
          candidate.run === 2 &&
          candidate.classifier === "jev" &&
          candidate.result.status === "ok" &&
          candidate.result.judgment.kind === "jev" &&
          candidate.result.judgment.score === 2,
      ),
      "stable keep judgment",
    );
    const cache = input.cache.map(
      (candidate): DescriptionJudgeCacheRow =>
        candidate.key === row.key &&
        candidate.result.status === "ok" &&
        candidate.result.judgment.kind === "jev"
          ? {
              ...candidate,
              result: {
                ...candidate.result,
                judgment: { ...candidate.result.judgment, confidence: 0.4 },
              },
            }
          : candidate,
    );
    const report = buildDescriptionPilotReport({ ...input, cache }).report;
    expect(report.stability.articles.jev.identicalDecisionRate).toBeLessThan(1);
    expect(report.stability.articles.jev.identicalBinaryDecisionRate).toBe(1);
  });

  it("shows operational errors explicitly and excludes them from stability rather than claiming success", () => {
    const input = fixture();
    const first = requireDefined(
      input.cache.find((row) => row.classifier === "jev" && row.run === 1),
      "error row",
    );
    const cache = input.cache.map(
      (row): DescriptionJudgeCacheRow =>
        row.key !== first.key
          ? row
          : {
              ...row,
              result: {
                status: "error",
                error: "http",
                retries: 0,
                attempts: [{ status: 422, latencyMs: 200, error: "http" }],
              },
            },
    );
    const report = buildDescriptionPilotReport({ ...input, cache }).report;
    expect(report.operations[0]?.overall.jev.errors).toBe(1);
    const allExcluded =
      report.stability.articles.jev.excludedErrors + report.stability.videos.jev.excludedErrors;
    expect(allExcluded).toBe(1);
    expect(report.items.find((row) => row.itemId === first.itemId)?.jev.status).toBe("error");
  });
});
