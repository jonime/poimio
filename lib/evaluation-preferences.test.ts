import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_VERSION } from "./embeddings.ts";
import {
  assessLessCase,
  embedPreferenceDescriptions,
  exclusiveCount,
  lessTargetMet,
  morePersonaImproved,
  moreTargetMet,
  orderedLessCases,
  parsePreferenceEmbeddings,
  parsePreferences,
} from "./evaluation-preferences.ts";

const personaIds = ["ai-software", "cars-engineering", "science-space", "finnish-sports"];

function preference(personaId: string) {
  return {
    personaId,
    label: personaId,
    description_fi: "Yksi lause suomeksi.",
    description_en: "One sentence in English.",
  };
}

function vector(value: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);
}

describe("preference check inputs", () => {
  it("requires one positive sentence per persona", () => {
    expect(parsePreferences(personaIds.map(preference), personaIds)).toHaveLength(4);
    expect(() => parsePreferences(personaIds.slice(0, 3).map(preference), personaIds)).toThrow(
      /exactly one row/u,
    );
    expect(() =>
      parsePreferences(
        personaIds.map((personaId) => ({ ...preference(personaId), description_en: "No period" })),
        personaIds,
      ),
    ).toThrow(/one sentence/u);
  });

  it("requires cached embeddings for the active model", () => {
    const file = {
      model: EMBEDDING_MODEL_VERSION,
      preferences: personaIds.map((personaId) => ({
        personaId,
        embedding_fi: vector(0),
        embedding_en: vector(1),
      })),
    };
    expect(parsePreferenceEmbeddings(file, personaIds).preferences).toHaveLength(4);
    expect(() => parsePreferenceEmbeddings({ ...file, model: "other@512" }, personaIds)).toThrow(
      /text-embedding-3-small@512/u,
    );
  });
});

describe("preference ranking targets", () => {
  it("builds 12 ordered less cases and counts exclusive items in the top 10", () => {
    const cases = orderedLessCases(personaIds);
    expect(cases).toHaveLength(12);
    expect(new Set(cases.map((entry) => `${entry.compositeId}:${entry.bPersonaId}`)).size).toBe(12);
    expect(exclusiveCount(["b", "a", "b"], new Set(["b"]), new Set(["a"]))).toBe(2);
  });

  it("requires a strict precision gain for at least 3 of 4 personas", () => {
    expect(morePersonaImproved(0.2, 0.3)).toBe(true);
    expect(morePersonaImproved(0.2, 0.2)).toBe(false);
    expect(morePersonaImproved(null, 0.3)).toBe(false);
    expect(moreTargetMet(3, 4)).toBe(true);
    expect(moreTargetMet(2, 4)).toBe(false);
  });

  it("counts a less case as missed when a cell is missing, the baseline share is zero, or the share is not lower", () => {
    const complete = (baseline: number, treatment: number) => ({
      seed: 0,
      missing: false,
      baselineBExclusiveCount: baseline,
      treatmentBExclusiveCount: treatment,
      baselineAExclusiveCount: 1,
      treatmentAExclusiveCount: 1,
      baselineRelevantCount: 4,
      treatmentRelevantCount: 4,
    });
    expect(assessLessCase([complete(3, 1)]).met).toBe(true);
    expect(assessLessCase([complete(3, 3)]).reason).toBe("not lower");
    expect(assessLessCase([complete(0, 0)]).reason).toBe("zero baseline share");
    expect(assessLessCase([{ ...complete(3, 1), missing: true }]).reason).toBe("missing cell");
    expect(lessTargetMet(10, 12)).toBe(true);
    expect(lessTargetMet(9, 12)).toBe(false);
  });
});

describe("preference description embeddings", () => {
  it("sends at most 10 descriptions and returns vectors in input order", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
      expect(body.model).toBe("text-embedding-3-small");
      expect(body.input).toEqual(["first", "second"]);
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: vector(2) },
            { index: 0, embedding: vector(1) },
          ],
        }),
        { status: 200 },
      );
    });
    const vectors = await embedPreferenceDescriptions({
      texts: ["first", "second"],
      apiKey: "test-key",
      fetchImpl,
    });
    expect(vectors[0]?.[0]).toBe(1);
    expect(vectors[1]?.[0]).toBe(2);
    await expect(
      embedPreferenceDescriptions({
        texts: Array.from({ length: 11 }, () => "sentence"),
        apiKey: "test-key",
        fetchImpl,
      }),
    ).rejects.toThrow(/1 to 10/u);
  });
});
