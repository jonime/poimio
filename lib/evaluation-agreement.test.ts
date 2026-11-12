import { describe, expect, it } from "vitest";
import {
  type AgreementPair,
  createAgreementDesign,
  scoreAgreement,
} from "./evaluation-agreement.ts";
import type {
  EvaluationLabel,
  EvaluationLabelItem,
  EvaluationPersona,
} from "./evaluation-labels.ts";

const personas: EvaluationPersona[] = Array.from({ length: 4 }, (_, index) => ({
  id: `p${index}`,
  description: `Persona ${index}`,
}));
const items: EvaluationLabelItem[] = Array.from({ length: 80 }, (_, index) => ({
  id: `i${index}`,
  title: `Item ${index}`,
  summary: "Summary",
  language: index % 2 === 0 ? "fi" : "en",
}));
const labels: EvaluationLabel[] = personas.flatMap((persona, personaIndex) =>
  items.map((item, index) => ({
    personaId: persona.id,
    itemId: item.id,
    model: "primary-qwen",
    promptVersion: "relevance-v1",
    relevant: (index + personaIndex) % 3 === 0,
  })),
);

describe("evaluation agreement", () => {
  it("creates deterministic, balanced, disjoint, stratified blind sets", () => {
    const first = createAgreementDesign({ personas, items, labels, seed: 42 });
    const repeated = createAgreementDesign({
      personas,
      items,
      labels,
      seed: 42,
    });
    expect(first).toEqual(repeated);
    expect(first.sets.selection).toHaveLength(60);
    expect(first.sets.reporting).toHaveLength(60);
    expect(new Set(first.sets.selection.map((pair) => pair.pairId)).size).toBe(60);
    const selectionIds = new Set(first.sets.selection.map((pair) => pair.pairId));
    expect(first.sets.reporting.some((pair) => selectionIds.has(pair.pairId))).toBe(false);
    for (const persona of personas) {
      for (const sample of [first.sets.selection, first.sets.reporting]) {
        const personaPairs = sample.filter((pair) => pair.personaId === persona.id);
        expect(personaPairs).toHaveLength(15);
        expect(personaPairs.filter((pair) => pair.language === "fi").length).toBeGreaterThanOrEqual(
          7,
        );
        expect(personaPairs.filter((pair) => pair.language === "en").length).toBeGreaterThanOrEqual(
          7,
        );
      }
    }
    expect(first.strata.every((stratum) => stratum.populationSize > 0)).toBe(true);
    expect(first.sets.selection.every((pair) => pair.inclusionProbability > 0)).toBe(true);
  });

  it("calculates weighted agreement, kappa, precision, and recall", () => {
    const pairs: AgreementPair[] = [
      pair("1", true, true, 0.5),
      pair("2", true, false, 1),
      pair("3", false, false, 0.5),
      pair("4", false, true, 1),
    ];
    const score = scoreAgreement(pairs);
    expect(score.overall.weightedPercentAgreement).toBeCloseTo(2 / 3);
    expect(score.overall.weightedCohenKappa).toBeCloseTo(1 / 3);
    expect(score.overall.weightedPrecision).toBeCloseTo(2 / 3);
    expect(score.overall.weightedRecall).toBeCloseTo(2 / 3);
    expect(score.fi?.samplePairs).toBe(4);
  });

  it("includes rare nonempty strata in both disjoint samples", () => {
    const rareLabels = labels.map((label) => ({
      ...label,
      relevant:
        label.itemId === "i0" ||
        label.itemId === "i2" ||
        label.itemId === "i1" ||
        label.itemId === "i3",
    }));
    const design = createAgreementDesign({ personas, items, labels: rareLabels, seed: 42 });
    expect(design.strata.every((stratum) => stratum.selectionSampleSize > 0)).toBe(true);
    expect(design.strata.every((stratum) => stratum.reportingSampleSize > 0)).toBe(true);
    expect(design.sets.selection).toHaveLength(60);
    expect(design.sets.reporting).toHaveLength(60);
  });

  it("rejects a stratum too small for both disjoint samples", () => {
    const rareLabels = labels.map((label) => ({ ...label, relevant: label.itemId === "i0" }));
    expect(() => createAgreementDesign({ personas, items, labels: rareLabels, seed: 42 })).toThrow(
      /agreement stratum/u,
    );
  });

  it("rejects incomplete primary labels and unscored manual samples", () => {
    expect(() =>
      createAgreementDesign({
        personas,
        items,
        labels: labels.slice(1),
        seed: 1,
      }),
    ).toThrow(/missing/u);
    expect(() => scoreAgreement([pair("1", true, null, 0.5)])).toThrow(/missing labels/u);
  });
});

function pair(
  itemId: string,
  modelRelevant: boolean,
  manualRelevant: boolean | null,
  inclusionProbability: number,
): AgreementPair {
  return {
    pairId: `p:${itemId}`,
    personaId: "p",
    itemId,
    language: "fi",
    modelRelevant,
    manualRelevant,
    stratumKey: `p|fi|${Number(modelRelevant)}`,
    stratumSize: 2,
    selectionSampleSize: 1,
    reportingSampleSize: 1,
    inclusionProbability,
  };
}
