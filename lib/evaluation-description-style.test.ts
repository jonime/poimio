import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertDescriptionStyleRunAllowed,
  classifyExtractionFailure,
  classifySummaryFailure,
  countDescriptionStyleFailures,
  createDescriptionStyleBlindReview,
  createDescriptionStyleSample,
  type DescriptionStyleItem,
  type DescriptionStyleRun,
  type DescriptionStyleRunItem,
  hasNarrationOpening,
  parseNarrationPatterns,
  scoreDescriptionStyleReview,
} from "./evaluation-description-style.ts";
import { requireDefined } from "./required.ts";

const patterns = parseNarrationPatterns(
  JSON.parse(
    readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../evaluation/description-style/narration-patterns.json",
      ),
      "utf8",
    ),
  ),
);
const snapshotHash = "a".repeat(64);

function item(id: string, language: "fi" | "en", sourceId: string): DescriptionStyleItem {
  return {
    id,
    source_id: sourceId,
    type: "article",
    url: `https://example.com/${id}`,
    title: `Title ${id}`,
    language,
    summary_origin: "ai_generated",
  };
}

function pool(): DescriptionStyleItem[] {
  return ["fi", "en"].flatMap((language) =>
    ["source-a", "source-b", "source-c"].flatMap((sourceId) =>
      Array.from({ length: 9 }, (_, index) =>
        item(
          `${language}-${sourceId}-${String(index).padStart(2, "0")}`,
          language as "fi" | "en",
          sourceId,
        ),
      ),
    ),
  );
}

function runItem(index: number, language: "fi" | "en"): DescriptionStyleRunItem {
  const output =
    language === "fi" ? "Suora tosiasia aiheesta." : "A direct fact about the subject.";
  const current =
    language === "fi" ? "Artikkelissa käsitellään aihetta." : "The article discusses the subject.";
  return {
    itemId: `item-${index}`,
    sourceId: `source-${index % 3}`,
    language,
    title: `Title ${index}`,
    url: `https://example.com/item-${index}`,
    finalUrl: `https://example.com/item-${index}`,
    extractionTimestamp: "2026-11-24T12:00:00.000Z",
    inputTextDigest: "b".repeat(64),
    changedInputDigest: false,
    extractionStatus: "complete",
    extractionError: null,
    current: { status: "complete", text: current, error: null },
    candidate: { status: "complete", text: output, error: null },
    pairComplete: true,
  };
}

function reviewRun(count = 22): DescriptionStyleRun {
  return {
    schemaVersion: 1,
    runId: "run-1",
    timestamp: "2026-11-24T12:00:00.000Z",
    sampleHash: "c".repeat(64),
    model: "gpt-6-luna",
    currentInstructionHash: "d".repeat(64),
    candidateInstructionHash: "e".repeat(64),
    items: Array.from({ length: count }, (_, index) =>
      runItem(index, index % 2 === 0 ? "fi" : "en"),
    ),
  };
}

function fillReview(
  review: ReturnType<typeof createDescriptionStyleBlindReview>,
  preference: "candidate" | "tie" | "blank",
): string {
  const keyByPair = new Map(review.key.map((entry) => [entry.pairId, entry]));
  const lines = review.csv.trimEnd().split("\n");
  return `${lines
    .map((line, index) => {
      if (index === 0 || preference === "blank") return line;
      const pairId = line.split(",")[0] ?? "";
      const key = keyByPair.get(pairId);
      if (!key) throw new Error(`missing key ${pairId}`);
      const answer = preference === "tie" ? "tie" : key.candidate;
      return line.replace(/,,,,$/u, `,${answer},neither,neither,neither`);
    })
    .join("\n")}\n`;
}

describe("description-style sample", () => {
  it("is deterministic and covers each source in round-robin order per language", () => {
    const input = { items: pool(), seed: 23024, snapshotManifestHash: snapshotHash };
    const first = createDescriptionStyleSample(input);
    const second = createDescriptionStyleSample(input);

    expect(second).toEqual(first);
    for (const language of ["fi", "en"] as const) {
      const entries = first.items.filter((entry) => entry.language === language);
      expect(entries).toHaveLength(12);
      expect(
        entries
          .slice(0, 3)
          .map((entry) => entry.sourceId)
          .sort(),
      ).toEqual(["source-a", "source-b", "source-c"]);
      expect(new Set(entries.slice(0, 6).map((entry) => entry.sourceId)).size).toBe(3);
    }
  });

  it("requires both languages and the requested quota", () => {
    expect(() =>
      createDescriptionStyleSample({
        items: pool().filter((row) => row.language === "fi"),
        seed: 1,
        snapshotManifestHash: snapshotHash,
      }),
    ).toThrow(/eligible en items/u);
  });
});

describe("description-style narration diagnostic", () => {
  it.each([
    ["en", "The article discusses a result."],
    ["en", "This post explains the change."],
    ["en", "They report a new number."],
    ["fi", "Artikkelissa käsitellään muutosta."],
    ["fi", "Tekstissä kerrotaan tuloksesta."],
    ["fi", "  Videossa esitetään uusi tulos.  "],
  ] as const)("matches %s narration %s", (language, text) => {
    expect(hasNarrationOpening(text, language, patterns)).toBe(true);
  });

  it.each([
    ["en", "The company says the launch succeeded."],
    ["fi", "Yhtiön mukaan julkaisu onnistui."],
    ["fi", "Yle kertoo muutoksesta."],
    ["fi", "Tutkijat kertovat tuloksesta."],
    ["en", "The company says this. The article discusses it further."],
  ] as const)("does not match attribution or a later sentence in %s", (language, text) => {
    expect(hasNarrationOpening(text, language, patterns)).toBe(false);
  });
});

describe("description-style execution guards", () => {
  it("requires an OpenAI key and refuses when CI is present", () => {
    expect(() => assertDescriptionStyleRunAllowed({})).toThrow(/OPENAI_API_KEY/u);
    expect(() => assertDescriptionStyleRunAllowed({ CI: "false", OPENAI_API_KEY: "test" })).toThrow(
      /must not run in CI/u,
    );
    expect(assertDescriptionStyleRunAllowed({ OPENAI_API_KEY: " test " })).toBe("test");
  });

  it("stops the real CLI in CI before network or database work", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const script = readFileSync(resolve(root, "scripts/description-style.mts"), "utf8");
    expect(script).not.toContain("lib/db");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/description-style.mts"],
      {
        cwd: root,
        env: { ...process.env, CI: "1", OPENAI_API_KEY: "unused" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("must not run in CI");
  });

  it("maps extraction and summary errors to explicit failure categories", () => {
    expect(classifyExtractionFailure("page has no readable article text")).toBe(
      "extraction_failure",
    );
    expect(classifyExtractionFailure("article extraction failed: invalid document")).toBe(
      "extraction_failure",
    );
    expect(classifyExtractionFailure("request timed out")).toBe("http_or_timeout");
    expect(classifySummaryFailure(new Error("summary service returned no text"))).toBe(
      "refusal_or_empty",
    );
    expect(classifySummaryFailure(new Error("summary service returned HTTP 503"))).toBe(
      "http_or_timeout",
    );
  });
});

describe("description-style pair preparation and scoring", () => {
  it("counts extraction and per-instruction summary failures without treating empties as pairs", () => {
    const items = reviewRun(4).items;
    items[0] = {
      ...requireDefined(items[0], "extraction failure item"),
      extractionStatus: "extraction_failure",
      current: { status: "not_attempted", text: null, error: null },
      candidate: { status: "not_attempted", text: null, error: null },
      pairComplete: false,
    };
    items[1] = {
      ...requireDefined(items[1], "fetch failure item"),
      extractionStatus: "http_or_timeout",
      current: { status: "not_attempted", text: null, error: null },
      candidate: { status: "not_attempted", text: null, error: null },
      pairComplete: false,
    };
    items[2] = {
      ...requireDefined(items[2], "empty output item"),
      current: { status: "refusal_or_empty", text: null, error: "no text" },
      pairComplete: false,
    };

    expect(countDescriptionStyleFailures(items)).toEqual({
      extractionFailures: 1,
      fetchFailures: 1,
      refusalOrEmpty: { current: 1, candidate: 0 },
      summaryHttpOrTimeout: { current: 0, candidate: 0 },
      completePairs: 1,
    });
  });

  it("uses deterministic per-item A/B order and stores the role key separately", () => {
    const run = reviewRun();
    const first = createDescriptionStyleBlindReview(run, 7);
    const second = createDescriptionStyleBlindReview(run, 7);

    expect(second).toEqual(first);
    expect(first.csv).not.toContain("current");
    expect(first.csv).not.toContain("candidate");
    expect(new Set(first.key.map((entry) => entry.candidate))).toEqual(new Set(["A", "B"]));
    expect(first.key).toHaveLength(run.items.length);
  });

  it("scores wins, target decisions, and candidate-specific errors from the key", () => {
    const run = reviewRun();
    const review = createDescriptionStyleBlindReview(run, 11);
    const csv = fillReview(review, "candidate");
    const score = scoreDescriptionStyleReview({ csv, key: review.key, run, patterns });

    expect(score.overall).toMatchObject({
      reviewedPairs: 22,
      candidateWins: 22,
      candidateLosses: 0,
      ties: 0,
      currentNarrationOpenings: 22,
      candidateNarrationOpenings: 0,
      preferenceRate: 1,
      decision: "meets",
      targetsMet: true,
    });
  });

  it("requires wins to exceed losses even when wins plus ties reaches 80 percent", () => {
    const run = reviewRun();
    const review = createDescriptionStyleBlindReview(run, 13);
    const score = scoreDescriptionStyleReview({
      csv: fillReview(review, "tie"),
      key: review.key,
      run,
      patterns,
    });

    expect(score.overall.preferenceRate).toBe(1);
    expect(score.overall.preferenceTargetMet).toBe(false);
    expect(score.overall.decision).toBe("misses");
  });

  it("reports an inconclusive result below 20 reviewed pairs", () => {
    const run = reviewRun();
    const review = createDescriptionStyleBlindReview(run, 17);
    const score = scoreDescriptionStyleReview({
      csv: fillReview(review, "blank"),
      key: review.key,
      run,
      patterns,
    });

    expect(score.overall.reviewedPairs).toBe(0);
    expect(score.overall.decision).toBe("inconclusive");
    expect(score.fi.decision).toBe("inconclusive");
    expect(score.en.decision).toBe("inconclusive");
  });
});
