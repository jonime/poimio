import type {
  EvaluationLabel,
  EvaluationLabelItem,
  EvaluationPersona,
} from "./evaluation-labels.ts";

export interface AgreementPair {
  pairId: string;
  personaId: string;
  itemId: string;
  language: "fi" | "en";
  modelRelevant: boolean;
  manualRelevant: boolean | null;
  stratumKey: string;
  stratumSize: number;
  selectionSampleSize: number;
  reportingSampleSize: number;
  inclusionProbability: number;
}

export interface AgreementStratum {
  key: string;
  personaId: string;
  language: "fi" | "en";
  modelRelevant: boolean;
  populationSize: number;
  selectionSampleSize: number;
  reportingSampleSize: number;
}

export interface AgreementDesign {
  seed: number;
  sets: { selection: AgreementPair[]; reporting: AgreementPair[] };
  strata: AgreementStratum[];
  stratumCounts: Record<string, number>;
}

export interface WeightedAgreementMetrics {
  samplePairs: number;
  weightedPercentAgreement: number;
  weightedCohenKappa: number | null;
  weightedPrecision: number | null;
  weightedRecall: number | null;
  effectiveSampleSize: number;
}

export interface AgreementScore {
  overall: WeightedAgreementMetrics;
  fi: WeightedAgreementMetrics | null;
  en: WeightedAgreementMetrics | null;
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  const shuffled = [...items];
  let state = 0;
  for (const character of seed) {
    state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  if (state === 0) state = 0x9e3779b9;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const swapIndex = (state >>> 0) % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex]!,
      shuffled[index]!,
    ];
  }
  return shuffled;
}

function allocateProportionally(
  sizes: Map<string, number>,
  quota: number,
): Map<string, number> {
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  if (quota > total) {
    throw new Error(`agreement stratum has ${total} pairs but needs ${quota}`);
  }
  if (quota === 0) return new Map([...sizes.keys()].map((key) => [key, 0]));

  const allocations = new Map<string, number>();
  const fractions = [...sizes].map(([key, size]) => {
    const exact = (quota * size) / total;
    const floor = Math.min(size, Math.floor(exact));
    allocations.set(key, floor);
    return { key, fraction: exact - floor };
  });
  let remaining =
    quota - [...allocations.values()].reduce((sum, n) => sum + n, 0);
  fractions.sort(
    (left, right) =>
      right.fraction - left.fraction || left.key.localeCompare(right.key),
  );
  while (remaining > 0) {
    let progressed = false;
    for (const { key } of fractions) {
      const current = allocations.get(key) ?? 0;
      if (current < (sizes.get(key) ?? 0)) {
        allocations.set(key, current + 1);
        remaining -= 1;
        progressed = true;
        if (remaining === 0) break;
      }
    }
    if (!progressed)
      throw new Error("could not allocate agreement sample quota");
  }
  return allocations;
}

function balancedLanguageQuota(
  language: "fi" | "en",
  personaIndex: number,
  perPersona: number,
): number {
  const lower = Math.floor(perPersona / 2);
  const extraLanguage: "fi" | "en" = personaIndex % 2 === 0 ? "fi" : "en";
  return lower + (perPersona % 2 === 1 && language === extraLanguage ? 1 : 0);
}

export function createAgreementDesign(input: {
  personas: EvaluationPersona[];
  items: EvaluationLabelItem[];
  labels: EvaluationLabel[];
  seed: number;
  perPersona?: number;
}): AgreementDesign {
  const { personas, items, labels, seed, perPersona = 15 } = input;
  const model = labels[0]?.model;
  const promptVersion = labels[0]?.promptVersion;
  if (!model || !promptVersion) throw new Error("primary label set is empty");
  if (
    labels.some(
      (label) => label.model !== model || label.promptVersion !== promptVersion,
    )
  ) {
    throw new Error(
      "agreement sampling requires one complete primary label set",
    );
  }
  if (!Number.isInteger(perPersona) || perPersona < 2) {
    throw new Error(
      "per-persona sample size must be an integer of at least two",
    );
  }
  const itemById = new Map(items.map((item) => [item.id, item]));
  const labelByPair = new Map(
    labels.map((label) => [`${label.personaId}\u0000${label.itemId}`, label]),
  );
  const grouped = new Map<string, AgreementPair[]>();
  for (const persona of personas) {
    for (const item of items) {
      const label = labelByPair.get(`${persona.id}\u0000${item.id}`);
      if (!label) {
        throw new Error(`primary labels are missing ${persona.id}/${item.id}`);
      }
      const pairItem = itemById.get(item.id)!;
      const stratumKey = `${persona.id}|${pairItem.language}|${Number(label.relevant)}`;
      const pair: AgreementPair = {
        pairId: `${persona.id}:${item.id}`,
        personaId: persona.id,
        itemId: item.id,
        language: pairItem.language,
        modelRelevant: label.relevant,
        manualRelevant: null,
        stratumKey,
        stratumSize: 0,
        selectionSampleSize: 0,
        reportingSampleSize: 0,
        inclusionProbability: 0,
      };
      const stratum = grouped.get(stratumKey) ?? [];
      stratum.push(pair);
      grouped.set(stratumKey, stratum);
    }
  }

  const selection: AgreementPair[] = [];
  const reporting: AgreementPair[] = [];
  const strata: AgreementStratum[] = [];
  personas.forEach((persona, personaIndex) => {
    for (const language of ["fi", "en"] as const) {
      const languageStrata = [...grouped.entries()].filter(([key]) => {
        const [stratumPersona, stratumLanguage] = key.split("|");
        return stratumPersona === persona.id && stratumLanguage === language;
      });
      const target = balancedLanguageQuota(language, personaIndex, perPersona);
      const sizes = new Map(
        languageStrata.map(([key, rows]) => [key, rows.length]),
      );
      const selectionAllocations = allocateProportionally(sizes, target);
      const remainingSizes = new Map(
        languageStrata.map(([key, rows]) => [
          key,
          rows.length - (selectionAllocations.get(key) ?? 0),
        ]),
      );
      const reportingAllocations = allocateProportionally(
        remainingSizes,
        target,
      );
      for (const [key, rows] of languageStrata) {
        const selectionCount = selectionAllocations.get(key) ?? 0;
        const reportingCount = reportingAllocations.get(key) ?? 0;
        const selected = seededShuffle(rows, `${seed}:selection:${key}`).slice(
          0,
          selectionCount,
        );
        const selectedIds = new Set(selected.map((pair) => pair.itemId));
        const remaining = rows.filter((pair) => !selectedIds.has(pair.itemId));
        const reported = seededShuffle(
          remaining,
          `${seed}:reporting:${key}`,
        ).slice(0, reportingCount);
        selected.forEach((pair) =>
          selection.push({
            ...pair,
            stratumSize: rows.length,
            selectionSampleSize: selectionCount,
            reportingSampleSize: reportingCount,
            inclusionProbability: selectionCount / rows.length,
          }),
        );
        reported.forEach((pair) =>
          reporting.push({
            ...pair,
            stratumSize: rows.length,
            selectionSampleSize: selectionCount,
            reportingSampleSize: reportingCount,
            inclusionProbability: reportingCount / rows.length,
          }),
        );
        strata.push({
          key,
          personaId: persona.id,
          language,
          modelRelevant: key.endsWith("|1"),
          populationSize: rows.length,
          selectionSampleSize: selectionCount,
          reportingSampleSize: reportingCount,
        });
      }
    }
  });

  if (selection.length !== personas.length * perPersona) {
    throw new Error("selection set does not match the requested sample size");
  }
  if (reporting.length !== personas.length * perPersona) {
    throw new Error("reporting set does not match the requested sample size");
  }
  const selectionIds = new Set(selection.map((pair) => pair.pairId));
  if (reporting.some((pair) => selectionIds.has(pair.pairId))) {
    throw new Error("selection and reporting sets are not disjoint");
  }
  return {
    seed,
    sets: { selection, reporting },
    strata,
    stratumCounts: Object.fromEntries(
      strata.map((stratum) => [stratum.key, stratum.populationSize]),
    ),
  };
}

function weightedMetrics(pairs: AgreementPair[]): WeightedAgreementMetrics {
  const weightedTotal = pairs.reduce(
    (sum, pair) => sum + 1 / pair.inclusionProbability,
    0,
  );
  const squaredWeights = pairs.reduce(
    (sum, pair) => sum + 1 / pair.inclusionProbability ** 2,
    0,
  );
  const weightedAgree = pairs.reduce(
    (sum, pair) =>
      sum +
      (pair.modelRelevant === pair.manualRelevant
        ? 1 / pair.inclusionProbability
        : 0),
    0,
  );
  const modelRelevant = pairs.reduce(
    (sum, pair) =>
      sum + (pair.modelRelevant ? 1 / pair.inclusionProbability : 0),
    0,
  );
  const manualRelevant = pairs.reduce(
    (sum, pair) =>
      sum + (pair.manualRelevant ? 1 / pair.inclusionProbability : 0),
    0,
  );
  const weightedTruePositive = pairs.reduce(
    (sum, pair) =>
      sum +
      (pair.modelRelevant && pair.manualRelevant
        ? 1 / pair.inclusionProbability
        : 0),
    0,
  );
  const expectedAgreement =
    (modelRelevant / weightedTotal) * (manualRelevant / weightedTotal) +
    ((weightedTotal - modelRelevant) / weightedTotal) *
      ((weightedTotal - manualRelevant) / weightedTotal);
  return {
    samplePairs: pairs.length,
    weightedPercentAgreement: weightedAgree / weightedTotal,
    weightedCohenKappa:
      expectedAgreement === 1
        ? null
        : (weightedAgree / weightedTotal - expectedAgreement) /
          (1 - expectedAgreement),
    weightedPrecision:
      modelRelevant === 0 ? null : weightedTruePositive / modelRelevant,
    weightedRecall:
      manualRelevant === 0 ? null : weightedTruePositive / manualRelevant,
    effectiveSampleSize: weightedTotal ** 2 / squaredWeights,
  };
}

export function scoreAgreement(pairs: AgreementPair[]): AgreementScore {
  if (pairs.length === 0) throw new Error("agreement sample is empty");
  if (
    pairs.some(
      (pair) =>
        pair.manualRelevant === null ||
        !Number.isFinite(pair.inclusionProbability) ||
        pair.inclusionProbability <= 0 ||
        pair.inclusionProbability > 1,
    )
  ) {
    throw new Error("agreement sample has missing labels or invalid weights");
  }
  const completePairs = pairs as Array<
    AgreementPair & { manualRelevant: boolean }
  >;
  const fi = completePairs.filter((pair) => pair.language === "fi");
  const en = completePairs.filter((pair) => pair.language === "en");
  return {
    overall: weightedMetrics(completePairs),
    fi: fi.length > 0 ? weightedMetrics(fi) : null,
    en: en.length > 0 ? weightedMetrics(en) : null,
  };
}
