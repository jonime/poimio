import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./early-ranking.ts";
import {
  createDescriptionAudit,
  createDescriptionRepeat,
  createDescriptionSample,
  type DescriptionQualityItem,
  type DescriptionSample,
  type DescriptionSampleItem,
  descriptionBlindCsv,
  descriptionHeuristicReasons,
  descriptionTextHash,
  findRepeatedDescriptions,
  normalizeDescriptionText,
  parseDescriptionQualityItems,
  readDescriptionSnapshot,
  routeDescriptionJudge,
  validateDescriptionSample,
} from "./evaluation-description-quality.ts";
import { hashSnapshotRow, sha256 } from "./evaluation-snapshot.ts";
import {
  descriptionJudgingConfig,
  readConfiguredJudgingCsv,
  setJudgingAnswer,
} from "./manual-judging.ts";

describe("delayed description repeat", () => {
  function fixture() {
    const items: DescriptionSampleItem[] = Array.from({ length: 60 }, (_, index) => ({
      id: `item-${index}`,
      source_id: "source",
      title: `Title ${index}`,
      summary: `Description ${index}`,
      language: index % 2 === 0 ? "fi" : "en",
      summary_origin: "feed",
      type: "article",
      url: `https://example.com/${index}`,
    }));
    const sample = createDescriptionSample({
      items,
      snapshotManifestHash: sha256("repeat fixture"),
      seed: 42,
      devSize: 0,
      testSize: 30,
    });
    let auditCsv = descriptionBlindCsv(sample.sets.test, items);
    for (let index = 0; index < 30; index += 1) {
      auditCsv = setJudgingAnswer(auditCsv, index, "quality", "good", descriptionJudgingConfig);
      auditCsv = setJudgingAnswer(auditCsv, index, "reason", "none", descriptionJudgingConfig);
    }
    return {
      auditEntries: sample.sets.test,
      auditCsv,
      auditLabelsHash: sha256(auditCsv),
      completedAt: "2026-11-16T08:06:36.734+02:00",
      preparedAt: "2026-11-17T08:06:36.734+02:00",
      seed: 42,
    };
  }

  it("draws ten reproducible blind items without copying prior answers", () => {
    const input = fixture();
    const repeat = createDescriptionRepeat(input);
    expect(repeat).toEqual(createDescriptionRepeat(input));
    const rows = readConfiguredJudgingCsv(repeat.csv, descriptionJudgingConfig);
    expect(rows).toHaveLength(10);
    expect(new Set(repeat.design.blindIds).size).toBe(10);
    expect(rows.every(({ values }) => values.quality === "" && values.reason === "")).toBe(true);
    const originals = readConfiguredJudgingCsv(input.auditCsv, descriptionJudgingConfig);
    for (const { values } of rows) {
      const original = originals.find((row) => row.values.blind_id === values.blind_id);
      for (const column of descriptionJudgingConfig.displayColumns) {
        expect(values[column]).toBe(original?.values[column]);
      }
    }
    expect(createDescriptionRepeat({ ...input, seed: 43 }).design.blindIds).not.toEqual(
      repeat.design.blindIds,
    );
    expect(repeat.design.auditLabelsHash).toBe(input.auditLabelsHash);
  });

  it("rejects early preparation, changed or incomplete labels, and changed inputs", () => {
    const input = fixture();
    expect(() =>
      createDescriptionRepeat({
        ...input,
        preparedAt: "2026-11-17T08:06:36.733+02:00",
      }),
    ).toThrow(/at least 24 hours/u);
    expect(() => createDescriptionRepeat({ ...input, completedAt: "invalid" })).toThrow(
      /valid timestamps/u,
    );
    expect(() => createDescriptionRepeat({ ...input, auditCsv: `${input.auditCsv}\n` })).toThrow(
      /changed since/u,
    );
    const blankCsv = input.auditCsv.replace('"good"', '""');
    expect(() =>
      createDescriptionRepeat({
        ...input,
        auditCsv: blankCsv,
        auditLabelsHash: sha256(blankCsv),
      }),
    ).toThrow(/Complete all audit labels/u);
    const changedCsv = input.auditCsv.replace("Description", "Changed");
    expect(() =>
      createDescriptionRepeat({
        ...input,
        auditCsv: changedCsv,
        auditLabelsHash: sha256(changedCsv),
      }),
    ).toThrow(/mismatch/u);
    expect(() =>
      createDescriptionRepeat({ ...input, auditEntries: input.auditEntries.slice(1) }),
    ).toThrow(/exactly 30/u);
  });
});

describe("reduced human audit", () => {
  function fixture() {
    const items = (["fi", "en"] as const).flatMap((language) =>
      Array.from({ length: 60 }, (_, index) => ({
        id: `${language}-${index}`,
        source_id: "source",
        title: `Title ${language} ${index}`,
        summary: index < 15 ? "None" : `Description ${language} ${index}`,
        language,
        summary_origin: "feed" as const,
        type: "article" as const,
        url: `https://example.com/${language}/${index}`,
      })),
    );
    const sample = createDescriptionSample({
      items,
      snapshotManifestHash: sha256("audit fixture"),
      seed: 42,
      devSize: 0,
      testSize: 80,
    });
    let csv = descriptionBlindCsv(sample.sets.test, items);
    for (let index = 0; index < 8; index += 1) {
      csv = setJudgingAnswer(csv, index, "quality", "good", descriptionJudgingConfig);
      csv = setJudgingAnswer(csv, index, "reason", "none", descriptionJudgingConfig);
    }
    return { sample, csv };
  }

  it("preserves eight labels and selects only 22 new rows with language and flag coverage", () => {
    const { sample, csv } = fixture();
    const result = createDescriptionAudit(sample, csv);
    expect(result).toEqual(createDescriptionAudit(sample, csv));
    const rows = readConfiguredJudgingCsv(result.csv, descriptionJudgingConfig);
    expect(rows).toHaveLength(30);
    expect(rows.filter(({ values }) => values.quality === "" && values.reason === "")).toHaveLength(
      22,
    );
    expect(result.design.retainedCount).toBe(8);
    const originals = readConfiguredJudgingCsv(csv, descriptionJudgingConfig).slice(0, 8);
    for (const { values } of originals) {
      expect(rows.find((row) => row.values.blind_id === values.blind_id)?.values).toEqual(values);
    }
    expect(rows.filter(({ values }) => values.language === "fi")).toHaveLength(15);
    expect(rows.filter(({ values }) => values.language === "en")).toHaveLength(15);
    const added = result.design.entries.filter((entry) => !entry.retained);
    expect(new Set(added.map((entry) => entry.stratumKey)).size).toBe(4);
    for (const entry of result.design.entries) {
      expect(entry.auditWeight).toBeCloseTo((entry.weight ?? 0) / entry.auditInclusionProbability);
      expect(entry.auditInclusionProbability).toBeGreaterThan(0);
      if (entry.retained) expect(entry.auditInclusionProbability).toBe(1);
    }
    expect(result.csv).not.toContain("auditWeight");
    expect(result.csv).not.toContain("flagged");
  });

  it("retains a partial answer and rejects changed text, missing rows, and too many labels", () => {
    const { sample, csv } = fixture();
    const partial = setJudgingAnswer(csv, 8, "quality", "weak", descriptionJudgingConfig);
    const audit = createDescriptionAudit(sample, partial);
    expect(audit.design.retainedCount).toBe(9);
    expect(
      readConfiguredJudgingCsv(audit.csv, descriptionJudgingConfig).some(
        ({ values }) => values.quality === "weak" && values.reason === "",
      ),
    ).toBe(true);
    expect(() => createDescriptionAudit(sample, csv.replace("Title", "Changed"))).toThrow(
      /mismatch/u,
    );
    expect(() =>
      createDescriptionAudit(
        { ...sample, sets: { ...sample.sets, test: sample.sets.test.slice(1) } },
        csv,
      ),
    ).toThrow(/every original test row/u);
    let tooMany = csv;
    for (let index = 8; index < 31; index += 1) {
      tooMany = setJudgingAnswer(tooMany, index, "quality", "good", descriptionJudgingConfig);
    }
    expect(() => createDescriptionAudit(sample, tooMany)).toThrow(/cannot discard/u);
  });
});

function item(
  summary: string | null,
  overrides: Partial<DescriptionQualityItem> = {},
): DescriptionQualityItem {
  return {
    id: "item-1",
    source_id: "source-1",
    title: "A specific news story",
    summary,
    ...overrides,
  };
}

const noRepeats = new Set<string>();

describe("description-quality routing and normalization", () => {
  it.each([null, "", " \n\t "])(
    "routes missing description %j without a judge request",
    (summary) => {
      expect(descriptionHeuristicReasons(item(summary), noRepeats)).toEqual(["empty"]);
      expect(routeDescriptionJudge(summary)).toEqual({ kind: "replace", reason: "empty" });
    },
  );

  it.each(["[...]", "…", "123 / !", "None", " NULL ", "undefined", "N/A"])(
    "routes placeholder %j without a judge request",
    (summary) => {
      expect(descriptionHeuristicReasons(item(summary), noRepeats)).toEqual(["placeholder"]);
      expect(routeDescriptionJudge(summary)).toEqual({ kind: "replace", reason: "placeholder" });
    },
  );

  it("normalizes Finnish case, whitespace, and canonically equivalent accents", () => {
    expect(normalizeDescriptionText("  UUTISET \n nopeasti ja luotettavasti. ")).toBe(
      "uutiset nopeasti ja luotettavasti.",
    );
    expect(normalizeDescriptionText("Sa\u0308hko\u0308")).toBe("sähkö");
    expect(
      descriptionHeuristicReasons(item("Tekninen vika on saatu korjattua."), noRepeats),
    ).toEqual([]);
    expect(routeDescriptionJudge("Tekninen vika on saatu korjattua.")).toEqual({ kind: "judge" });
  });
});

function sampleItem(
  id: string,
  overrides: Partial<DescriptionSampleItem> = {},
): DescriptionSampleItem {
  return {
    id,
    source_id: "source",
    title: `News story ${id}`,
    summary: `Specific description of the topic for ${id}`,
    language: "en",
    summary_origin: "feed",
    type: "article",
    url: `https://example.com/${id}`,
    ...overrides,
  };
}

const sampleItems = (["fi", "en"] as const).flatMap((language) =>
  (["feed", "page_metadata", "ai_generated"] as const).flatMap((summary_origin) =>
    [true, false].flatMap((flagged) =>
      Array.from({ length: 30 }, (_, index) => {
        const id = `${language}-${summary_origin}-${flagged}-${index}`;
        return sampleItem(id, {
          language,
          summary_origin,
          ...(flagged ? { summary: "None" } : {}),
        });
      }),
    ),
  ),
);
const manifestHash = sha256("final snapshot");

function sampledItems(sample: DescriptionSample, items: DescriptionSampleItem[]) {
  const ids = new Set(
    [...sample.sets.dev, ...sample.sets.test, ...sample.sets.videos].map((entry) => entry.itemId),
  );
  return items.filter((item) => ids.has(item.id));
}

function snapshotTexts(items: DescriptionSampleItem[]) {
  const rows = items.map((item) => ({ ...item, enrichment_status: "completed", embedding: [1] }));
  return {
    manifestText: JSON.stringify({
      schemaVersion: 1,
      provisional: false,
      itemIds: rows.map((row) => row.id),
      itemRowHashes: Object.fromEntries(rows.map((row) => [row.id, hashSnapshotRow(row)])),
    }),
    itemText: rows.map((row) => JSON.stringify(row)).join("\n"),
  };
}

describe("description-quality sampling", () => {
  it("is seeded, independent of input order, and disjoint across dev, test, and video sets", () => {
    const items = [...sampleItems, sampleItem("video", { type: "video" })];
    const sample = createDescriptionSample({
      items,
      snapshotManifestHash: manifestHash,
      seed: 42,
    });
    expect(sample).toEqual(
      createDescriptionSample({
        items: [...items].reverse(),
        snapshotManifestHash: manifestHash,
        seed: 42,
      }),
    );
    expect(sample.sets.dev).toHaveLength(30);
    expect(sample.sets.test).toHaveLength(150);
    expect(sample.sets.videos).toHaveLength(1);
    expect(sample.sets.dev.filter((entry) => entry.stratumKey.endsWith(":flagged"))).toHaveLength(
      15,
    );
    expect(
      sample.sets.dev.every(
        (entry) => entry.weight === null && entry.inclusionProbability === null,
      ),
    ).toBe(true);
    const entries = [...sample.sets.dev, ...sample.sets.test, ...sample.sets.videos];
    expect(new Set(entries.map((entry) => entry.itemId)).size).toBe(entries.length);
    expect(sample.sets.videos[0]).toMatchObject({
      itemId: "video",
      weight: 1,
      inclusionProbability: 1,
    });
    expect(
      createDescriptionSample({ items, snapshotManifestHash: manifestHash, seed: 43 }).sets.test,
    ).not.toEqual(sample.sets.test);
  });

  it("records correct residual stratum sizes, quotas, probabilities, and weights", () => {
    const sample = createDescriptionSample({
      items: sampleItems,
      snapshotManifestHash: manifestHash,
      seed: 42,
    });
    for (const stratum of sample.strata) {
      expect(stratum.populationSize).toBe(30);
      expect(stratum.testPopulationSize).toBe(30 - stratum.devSize);
      expect(stratum.testSize).toBeGreaterThanOrEqual(8);
      const entries = sample.sets.test.filter((entry) => entry.stratumKey === stratum.key);
      expect(entries).toHaveLength(stratum.testSize);
      for (const entry of entries) {
        expect(entry.weight).toBeCloseTo(stratum.populationSize / stratum.testSize);
        expect(entry.inclusionProbability).toBeCloseTo(stratum.testSize / stratum.populationSize);
      }
    }
    expect(sample.sets.test.reduce((sum, entry) => sum + (entry.weight ?? 0), 0)).toBeCloseTo(360);
  });

  it("allocates the remainder proportionally and includes every item in a rare stratum", () => {
    const items = [
      ...Array.from({ length: 16 }, (_, i) => sampleItem(`fi-${i}`, { language: "fi" })),
      ...Array.from({ length: 24 }, (_, i) => sampleItem(`en-${i}`)),
      sampleItem("rare-1", { summary_origin: "ai_generated" }),
      sampleItem("rare-2", { summary_origin: "ai_generated" }),
    ];
    const sample = createDescriptionSample({
      items,
      snapshotManifestHash: manifestHash,
      seed: 1,
      devSize: 0,
      testSize: 22,
    });
    expect(sample.strata).toEqual([
      {
        key: "en:ai_generated:not_flagged",
        populationSize: 2,
        devSize: 0,
        testPopulationSize: 2,
        testSize: 2,
      },
      {
        key: "en:feed:not_flagged",
        populationSize: 24,
        devSize: 0,
        testPopulationSize: 24,
        testSize: 10,
      },
      {
        key: "fi:feed:not_flagged",
        populationSize: 16,
        devSize: 0,
        testPopulationSize: 16,
        testSize: 10,
      },
    ]);
    expect(
      sample.sets.test
        .filter((entry) => entry.itemId.startsWith("rare-"))
        .every((entry) => entry.weight === 1),
    ).toBe(true);
  });

  it("redistributes dev quotas when flagged items are reserved for rare-stratum test coverage", () => {
    const items = [
      sampleItem("flagged", { summary: "None" }),
      ...Array.from({ length: 60 }, (_, i) => sampleItem(`good-${i}`)),
    ];
    const sample = createDescriptionSample({
      items,
      snapshotManifestHash: manifestHash,
      seed: 1,
      devSize: 30,
      testSize: 20,
    });
    expect(sample.sets.dev).toHaveLength(30);
    expect(sample.sets.dev.filter((entry) => entry.stratumKey.endsWith(":flagged"))).toHaveLength(
      0,
    );
    expect(sample.strata.find((stratum) => stratum.key.endsWith(":flagged"))).toMatchObject({
      testPopulationSize: 1,
      testSize: 1,
    });
    expect(sample.sets.test).toHaveLength(20);
  });

  it("rejects impossible quotas, duplicate IDs, and invalid sampling configuration", () => {
    expect(() =>
      createDescriptionSample({
        items: Array.from({ length: 10 }, (_, index) => sampleItem(`small-${index}`)),
        snapshotManifestHash: manifestHash,
        seed: 1,
        devSize: 3,
        testSize: 7,
      }),
    ).toThrow(/reserving minimum test coverage/u);
    expect(() =>
      createDescriptionSample({
        items: sampleItems,
        snapshotManifestHash: manifestHash,
        seed: 1,
        testSize: 50,
      }),
    ).toThrow(/cannot allocate/u);
    expect(() =>
      createDescriptionSample({ items: [], snapshotManifestHash: manifestHash, seed: 1 }),
    ).toThrow(/needs 180 articles/u);
    expect(() =>
      createDescriptionSample({
        items: [...sampleItems, ...sampleItems],
        snapshotManifestHash: manifestHash,
        seed: 1,
      }),
    ).toThrow(/duplicate/u);
    expect(() =>
      createDescriptionSample({
        items: sampleItems,
        snapshotManifestHash: manifestHash,
        seed: 1,
        minWords: -1,
      }),
    ).toThrow(/valid sizes/u);
  });

  it("caps allocations at remaining capacity while retaining full-snapshot weights", () => {
    const sample = createDescriptionSample({
      items: Array.from({ length: 18 }, (_, index) => sampleItem(`small-${index}`)),
      snapshotManifestHash: manifestHash,
      seed: 1,
      devSize: 10,
      testSize: 8,
    });
    expect(sample.sets.dev).toHaveLength(10);
    expect(sample.sets.test).toHaveLength(8);
    expect(sample.sets.test.every((entry) => entry.weight === 18 / 8)).toBe(true);
  });

  it("validates final snapshot row hashes and IDs before projecting the frozen inputs", () => {
    const texts = snapshotTexts(sampleItems);
    const result = readDescriptionSnapshot(texts.manifestText, texts.itemText);
    expect(result.snapshotManifestHash).toBe(sha256(texts.manifestText));
    expect(result.items).toEqual(sampleItems);
    expect(() =>
      readDescriptionSnapshot(
        texts.manifestText,
        texts.itemText.replace("Specific description", "Changed description"),
      ),
    ).toThrow(/hash mismatch/u);
    expect(() =>
      readDescriptionSnapshot(
        texts.manifestText.replace('"provisional":false', '"provisional":true'),
        texts.itemText,
      ),
    ).toThrow(/final snapshot/u);
    expect(() =>
      readDescriptionSnapshot(texts.manifestText, `${texts.itemText}\n${texts.itemText}`),
    ).toThrow(/IDs/u);
  });

  it("rejects changed manifest or text hashes and mismatched frozen item IDs", () => {
    const sample = createDescriptionSample({
      items: sampleItems,
      snapshotManifestHash: manifestHash,
      seed: 42,
    });
    const frozen = sampledItems(sample, sampleItems);
    expect(() => validateDescriptionSample(sample, manifestHash, frozen)).not.toThrow();
    expect(() => validateDescriptionSample(sample, sha256("different snapshot"), frozen)).toThrow(
      /manifest hash mismatch/u,
    );
    expect(() =>
      validateDescriptionSample(
        sample,
        manifestHash,
        frozen.map((item) => ({ ...item, summary: `${item.summary} changed` })),
      ),
    ).toThrow(/text hash mismatch/u);
    expect(() => validateDescriptionSample(sample, manifestHash, frozen.slice(1))).toThrow(
      /item IDs/u,
    );
  });

  it("exports blind, escaped CSV without item IDs, source, origin, flags, weights, or model output", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      sampleItem(`item-${i}`, {
        title: '"Quoted" title',
        summary: `Description, with a quote " and newline\nfor item ${i}`,
      }),
    );
    const sample = createDescriptionSample({
      items,
      snapshotManifestHash: manifestHash,
      seed: 1,
      devSize: 0,
      testSize: 8,
    });
    const [header, ...rows] = parseCsv(descriptionBlindCsv(sample.sets.test, items));
    expect(header).toEqual([
      "blind_id",
      "title",
      "description",
      "language",
      "content_type",
      "quality",
      "reason",
    ]);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({
      0: "test-001",
      1: '"Quoted" title',
      3: "en",
      4: "article",
      5: "",
      6: "",
    });
    expect(rows[0]?.[2]).toContain('quote " and newline\n');
  });
});

describe("description-quality sample command", () => {
  it("refuses to run in CI before reading files", () => {
    const result = spawnSync(process.execPath, ["scripts/description-quality.mts", "sample"], {
      cwd: process.cwd(),
      env: { ...process.env, CI: "true" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not run in CI");
  });

  it("writes frozen sample and blind CSVs and refuses to overwrite labels", () => {
    const directory = mkdtempSync(resolve("test/.description-quality-"));
    try {
      const snapshot = resolve(directory, "snapshot");
      const output = resolve(directory, "output");
      mkdirSync(snapshot);
      const items = [...sampleItems, sampleItem("video", { type: "video" })];
      const texts = snapshotTexts(items);
      writeFileSync(resolve(snapshot, "manifest.json"), texts.manifestText);
      writeFileSync(resolve(snapshot, "items.jsonl"), texts.itemText);
      const run = () =>
        spawnSync(
          process.execPath,
          ["scripts/description-quality.mts", "sample", "--snapshot", snapshot, "--output", output],
          { cwd: process.cwd(), env: { ...process.env, CI: "false" }, encoding: "utf8" },
        );
      const result = run();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const sample: DescriptionSample = JSON.parse(
        readFileSync(resolve(output, "sample.json"), "utf8"),
      );
      const copied = parseDescriptionQualityItems(
        readFileSync(resolve(output, "items.jsonl"), "utf8"),
      );
      expect(() =>
        validateDescriptionSample(sample, sha256(texts.manifestText), copied),
      ).not.toThrow();
      expect(copied).toHaveLength(181);
      expect(parseCsv(readFileSync(resolve(output, "labels-dev.csv"), "utf8"))).toHaveLength(31);
      expect(parseCsv(readFileSync(resolve(output, "labels-test.csv"), "utf8"))).toHaveLength(151);
      expect(parseCsv(readFileSync(resolve(output, "labels-videos.csv"), "utf8"))).toHaveLength(2);
      const second = run();
      expect(second.status).toBe(1);
      expect(second.stderr).toContain("Refusing to overwrite");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("description-quality H1 rules", () => {
  it("flags normalized text repeated in three distinct items from the same source", () => {
    const first = item("Uutiset nopeasti ja luotettavasti.", { id: "1" });
    const otherSource = item("Uutiset nopeasti ja luotettavasti.", { id: "4", source_id: "other" });
    const items = [
      first,
      item(" UUTISET nopeasti ja luotettavasti. ", { id: "2" }),
      item("Uutiset\nnopeasti ja luotettavasti.", { id: "3" }),
      otherSource,
    ];
    const repeated = findRepeatedDescriptions(items);
    expect(descriptionHeuristicReasons(first, repeated)).toEqual(["repeated"]);
    expect(descriptionHeuristicReasons(otherSource, repeated)).toEqual([]);
    expect(routeDescriptionJudge(first.summary)).toEqual({ kind: "judge" });
  });

  it("does not count duplicate rows or different sources toward the repetition threshold", () => {
    expect(
      findRepeatedDescriptions([
        item("Same text"),
        item("Same text"),
        item("Same text", { id: "2" }),
        item("Same text", { id: "3", source_id: "other" }),
      ]).size,
    ).toBe(0);
  });

  it.each(["ALPINE LINUX", "Alpine"])(
    "flags text equal to or contained in the title: %s",
    (summary) => {
      expect(
        descriptionHeuristicReasons(item(summary, { title: "Alpine Linux" }), noRepeats),
      ).toEqual(["equals_title"]);
      expect(routeDescriptionJudge(summary)).toEqual({ kind: "judge" });
    },
  );

  it("uses a tunable word boundary and leaves short real descriptions accepted when disabled", () => {
    const description = item("Tekninen vika on saatu korjattua.");
    expect(descriptionHeuristicReasons(description, noRepeats, 5)).toEqual([]);
    expect(descriptionHeuristicReasons(description, noRepeats, 6)).toEqual(["too_short"]);
    expect(descriptionHeuristicReasons(description, noRepeats)).toEqual([]);
    expect(descriptionHeuristicReasons(item("Tom Gauld's weekly cartoon"), noRepeats, 5)).toEqual([
      "too_short",
    ]);
  });

  it.each([
    "Testaa, oletko todellinen USA-tietäjä.",
    "Innovation is sometimes funny. Links 'n stuff: …",
    "Table of contents",
    "Northflank Status",
    "This live blog is now closed.",
    "The text lists 12 books with their authors or editors and publication years, followed by pagination links.",
  ])("leaves semantic failures for the standalone judge: %s", (summary) => {
    expect(descriptionHeuristicReasons(item(summary), noRepeats)).toEqual([]);
    expect(routeDescriptionJudge(summary)).toEqual({ kind: "judge" });
  });

  it("reports overlapping H1 reasons in rule order", () => {
    const items = ["1", "2", "3"].map((id) => item("Alpine Linux", { id, title: "Alpine Linux" }));
    expect(
      descriptionHeuristicReasons(
        item("Alpine Linux", { title: "Alpine Linux" }),
        findRepeatedDescriptions(items),
        3,
      ),
    ).toEqual(["repeated", "equals_title", "too_short"]);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid word limit %s",
    (minWords) => {
      expect(() => descriptionHeuristicReasons(item("text"), noRepeats, minWords)).toThrow(
        /minimum words/u,
      );
    },
  );
});

describe("description-quality frozen text", () => {
  it("parses snapshot JSONL with shared parsing and rejects malformed fields", () => {
    const input = item(null);
    expect(
      parseDescriptionQualityItems(`${JSON.stringify({ ...input, embedding: [1] })}\n`),
    ).toEqual([input]);
    expect(() => parseDescriptionQualityItems("{")).toThrow(/invalid JSON/u);
    for (const row of [null, {}, { ...input, summary: 1 }, { ...input, source_id: "" }]) {
      expect(() => parseDescriptionQualityItems(JSON.stringify(row))).toThrow(/invalid fields/u);
    }
  });

  it("hashes exact title and description with unambiguous field boundaries", () => {
    const original = item("Some description");
    expect(descriptionTextHash(original)).toBe(
      descriptionTextHash(item("Some description", { id: "other" })),
    );
    expect(descriptionTextHash(original)).not.toBe(descriptionTextHash(item("Some description ")));
    expect(descriptionTextHash(original)).not.toBe(
      descriptionTextHash({ ...original, title: "Other title" }),
    );
    expect(descriptionTextHash(item("bc", { title: "a" }))).not.toBe(
      descriptionTextHash(item("c", { title: "ab" })),
    );
  });
});
