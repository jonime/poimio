import { encodeCsv } from "./early-ranking.ts";
import { seededShuffle } from "./evaluation-agreement.ts";
import { hashSnapshotRow, parseJsonLines, sha256 } from "./evaluation-snapshot.ts";
import { descriptionJudgingConfig, readConfiguredJudgingCsv } from "./manual-judging.ts";
import { requireDefined } from "./required.ts";

export interface DescriptionQualityItem {
  id: string;
  source_id: string;
  title: string;
  summary: string | null;
}

export type DescriptionHeuristicReason =
  | "empty"
  | "placeholder"
  | "repeated"
  | "equals_title"
  | "too_short";

export type DescriptionJudgeRoute =
  | { kind: "replace"; reason: "empty" | "placeholder" }
  | { kind: "judge" };

const PLACEHOLDERS = new Set(["none", "null", "undefined", "n/a"]);

export function parseDescriptionQualityItems(content: string): DescriptionQualityItem[] {
  return parseJsonLines<unknown>(content, "description-quality items").map(
    parseDescriptionQualityItem,
  );
}

function parseDescriptionQualityItem(row: unknown, index: number): DescriptionQualityItem {
  if (
    row === null ||
    typeof row !== "object" ||
    !("id" in row) ||
    typeof row.id !== "string" ||
    row.id.trim() === "" ||
    !("source_id" in row) ||
    typeof row.source_id !== "string" ||
    row.source_id.trim() === "" ||
    !("title" in row) ||
    typeof row.title !== "string" ||
    !("summary" in row) ||
    (row.summary !== null && typeof row.summary !== "string")
  ) {
    throw new Error(`description-quality items row ${index + 1} has invalid fields`);
  }
  return { id: row.id, source_id: row.source_id, title: row.title, summary: row.summary };
}

export function descriptionTextHash(
  item: Pick<DescriptionQualityItem, "title" | "summary">,
): string {
  return sha256(JSON.stringify([item.title, item.summary]));
}

export function normalizeDescriptionText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function missingOrPlaceholder(summary: string | null): "empty" | "placeholder" | null {
  const normalized = normalizeDescriptionText(summary ?? "");
  if (normalized === "") return "empty";
  if (!/\p{L}/u.test(normalized) || PLACEHOLDERS.has(normalized)) return "placeholder";
  return null;
}

function repeatedKey(sourceId: string, summary: string): string {
  return JSON.stringify([sourceId, normalizeDescriptionText(summary)]);
}

export function findRepeatedDescriptions(
  items: readonly DescriptionQualityItem[],
): ReadonlySet<string> {
  const idsByDescription = new Map<string, Set<string>>();
  for (const item of items) {
    if (missingOrPlaceholder(item.summary) === "empty") continue;
    const key = repeatedKey(item.source_id, item.summary ?? "");
    const ids = idsByDescription.get(key) ?? new Set<string>();
    ids.add(item.id);
    idsByDescription.set(key, ids);
  }
  return new Set([...idsByDescription].filter(([, ids]) => ids.size >= 3).map(([key]) => key));
}

export function descriptionHeuristicReasons(
  item: DescriptionQualityItem,
  repeatedDescriptions: ReadonlySet<string>,
  minWords: number | null = null,
): DescriptionHeuristicReason[] {
  if (minWords !== null && (!Number.isInteger(minWords) || minWords < 0)) {
    throw new Error("description-quality minimum words must be a nonnegative integer or null");
  }
  const deterministicReason = missingOrPlaceholder(item.summary);
  if (deterministicReason !== null) return [deterministicReason];

  const summary = normalizeDescriptionText(item.summary ?? "");
  const reasons: DescriptionHeuristicReason[] = [];
  if (repeatedDescriptions.has(repeatedKey(item.source_id, summary))) reasons.push("repeated");
  if (normalizeDescriptionText(item.title).includes(summary)) reasons.push("equals_title");
  if (minWords !== null && summary.split(" ").length < minWords) reasons.push("too_short");
  return reasons;
}

// Standalone judges must still see items rejected by the experiment-only H1 rules.
export function routeDescriptionJudge(summary: string | null): DescriptionJudgeRoute {
  const reason = missingOrPlaceholder(summary);
  return reason === null ? { kind: "judge" } : { kind: "replace", reason };
}

export interface DescriptionSampleItem extends DescriptionQualityItem {
  summary: string;
  language: "fi" | "en";
  summary_origin: "feed" | "page_metadata" | "ai_generated";
  type: "article" | "video";
  url: string;
}

export interface DescriptionSampleEntry {
  itemId: string;
  blindId: string;
  textHash: string;
  stratumKey: string;
  inclusionProbability: number | null;
  weight: number | null;
}

export interface DescriptionSampleStratum {
  key: string;
  populationSize: number;
  devSize: number;
  testPopulationSize: number;
  testSize: number;
}

export interface DescriptionSample {
  schemaVersion: 1;
  snapshotManifestHash: string;
  seed: number;
  minWords: number | null;
  strata: DescriptionSampleStratum[];
  sets: {
    dev: DescriptionSampleEntry[];
    test: DescriptionSampleEntry[];
    videos: DescriptionSampleEntry[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readDescriptionSnapshot(
  manifestText: string,
  itemText: string,
): {
  snapshotManifestHash: string;
  items: DescriptionSampleItem[];
} {
  const manifest: unknown = JSON.parse(manifestText);
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.provisional !== false ||
    !Array.isArray(manifest.itemIds) ||
    !manifest.itemIds.every((id: unknown) => typeof id === "string") ||
    !isRecord(manifest.itemRowHashes)
  ) {
    throw new Error("description-quality sampling requires a valid final snapshot manifest");
  }
  const rows = parseJsonLines<unknown>(itemText, "snapshot items");
  const hashes = manifest.itemRowHashes;
  const items = rows.map((row, index): DescriptionSampleItem => {
    const base = parseDescriptionQualityItem(row, index);
    if (!isRecord(row) || hashes[base.id] !== hashSnapshotRow(row)) {
      throw new Error(`Snapshot item hash mismatch for ${base.id}`);
    }
    if (
      row.enrichment_status !== "completed" ||
      typeof base.summary !== "string" ||
      base.summary.trim() === "" ||
      (row.language !== "fi" && row.language !== "en") ||
      (row.summary_origin !== "feed" &&
        row.summary_origin !== "page_metadata" &&
        row.summary_origin !== "ai_generated") ||
      (row.type !== "article" && row.type !== "video") ||
      typeof row.url !== "string"
    ) {
      throw new Error(`Snapshot item ${base.id} is missing completed description input fields`);
    }
    const url = new URL(row.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Snapshot item ${base.id} must have an HTTP(S) URL`);
    }
    return {
      ...base,
      summary: base.summary,
      language: row.language,
      summary_origin: row.summary_origin,
      type: row.type,
      url: row.url,
    };
  });
  const ids = new Set(items.map((item) => item.id));
  if (
    ids.size !== items.length ||
    new Set(manifest.itemIds).size !== manifest.itemIds.length ||
    manifest.itemIds.length !== items.length ||
    manifest.itemIds.some((id: string) => !ids.has(id)) ||
    Object.keys(hashes).length !== items.length
  ) {
    throw new Error("Snapshot item IDs do not match the manifest");
  }
  return { snapshotManifestHash: sha256(manifestText), items };
}

function allocateDescriptionSample(
  sizes: Map<string, number>,
  populationSizes: Map<string, number>,
  quota: number,
): Map<string, number> {
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  const allocations = new Map([...sizes].map(([key, size]) => [key, Math.min(size, 8)]));
  let remaining = quota - [...allocations.values()].reduce((sum, size) => sum + size, 0);
  if (remaining < 0 || quota > total) {
    throw new Error(
      `description-quality strata contain ${total} items but cannot allocate ${quota}`,
    );
  }
  while (remaining > 0) {
    const available = [...sizes].filter(([key, size]) => size > (allocations.get(key) ?? 0));
    const availablePopulation = available.reduce(
      (sum, [key]) => sum + requireDefined(populationSizes.get(key), `population size ${key}`),
      0,
    );
    const fractions = available.map(([key, size]) => {
      const current = allocations.get(key) ?? 0;
      const exact =
        (remaining * requireDefined(populationSizes.get(key), `population size ${key}`)) /
        availablePopulation;
      const added = Math.min(size - current, Math.floor(exact));
      allocations.set(key, current + added);
      return { key, size, fraction: exact - Math.floor(exact), added };
    });
    remaining -= fractions.reduce((sum, entry) => sum + entry.added, 0);
    fractions.sort((a, b) => b.fraction - a.fraction || a.key.localeCompare(b.key));
    for (const { key, size } of fractions) {
      if (remaining === 0) break;
      const current = allocations.get(key) ?? 0;
      if (current < size) {
        allocations.set(key, current + 1);
        remaining -= 1;
      }
    }
  }
  return allocations;
}

export function createDescriptionSample(input: {
  items: readonly DescriptionSampleItem[];
  snapshotManifestHash: string;
  seed: number;
  devSize?: number;
  testSize?: number;
  minWords?: number | null;
}): DescriptionSample {
  const { seed, snapshotManifestHash, devSize = 30, testSize = 150, minWords = null } = input;
  if (
    !Number.isSafeInteger(seed) ||
    !Number.isSafeInteger(devSize) ||
    devSize < 0 ||
    !Number.isSafeInteger(testSize) ||
    testSize < 1 ||
    (minWords !== null && (!Number.isInteger(minWords) || minWords < 0)) ||
    !/^[a-f0-9]{64}$/u.test(snapshotManifestHash)
  ) {
    throw new Error("description-quality sampling requires valid sizes, seed, and manifest hash");
  }
  const items = [...input.items].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error("description-quality sampling contains duplicate item IDs");
  }
  const repeated = findRepeatedDescriptions(items);
  const stratumById = new Map(
    items.map((item) => [
      item.id,
      item.type === "video"
        ? "video:census"
        : `${item.language}:${item.summary_origin}:${descriptionHeuristicReasons(item, repeated, minWords).length ? "flagged" : "not_flagged"}`,
    ]),
  );
  const articles = items.filter((item) => item.type === "article");
  if (articles.length < devSize + testSize) {
    throw new Error(`description-quality sampling needs ${devSize + testSize} articles`);
  }
  const populations = new Map<string, DescriptionSampleItem[]>();
  for (const item of articles) {
    const key = requireDefined(stratumById.get(item.id), `stratum ${item.id}`);
    const population = populations.get(key) ?? [];
    population.push(item);
    populations.set(key, population);
  }
  const devCapacity = new Map(
    [...populations].map(([key, population]) => [
      key,
      population.length - Math.min(population.length, 8),
    ]),
  );
  const flaggedCapacity = [...devCapacity]
    .filter(([key]) => key.endsWith(":flagged"))
    .reduce((sum, [, size]) => sum + size, 0);
  const notFlaggedCapacity = [...devCapacity]
    .filter(([key]) => key.endsWith(":not_flagged"))
    .reduce((sum, [, size]) => sum + size, 0);
  if (flaggedCapacity + notFlaggedCapacity < devSize) {
    throw new Error("Not enough dev items while reserving minimum test coverage in every stratum");
  }
  const flagged = seededShuffle(
    articles.filter((item) => stratumById.get(item.id)?.endsWith(":flagged")),
    `${seed}:dev:flagged`,
  );
  const notFlagged = seededShuffle(
    articles.filter((item) => stratumById.get(item.id)?.endsWith(":not_flagged")),
    `${seed}:dev:not_flagged`,
  );
  let flaggedQuota = Math.min(flaggedCapacity, Math.ceil(devSize / 2));
  const notFlaggedQuota = Math.min(notFlaggedCapacity, devSize - flaggedQuota);
  flaggedQuota = Math.min(flaggedCapacity, devSize - notFlaggedQuota);
  function drawDev(candidates: DescriptionSampleItem[], quota: number): DescriptionSampleItem[] {
    const selected: DescriptionSampleItem[] = [];
    for (const item of candidates) {
      if (selected.length === quota) break;
      const key = requireDefined(stratumById.get(item.id), `stratum ${item.id}`);
      const capacity = requireDefined(devCapacity.get(key), `dev capacity ${key}`);
      if (capacity > 0) {
        selected.push(item);
        devCapacity.set(key, capacity - 1);
      }
    }
    return selected;
  }
  const dev = seededShuffle(
    [...drawDev(flagged, flaggedQuota), ...drawDev(notFlagged, notFlaggedQuota)],
    `${seed}:dev:order`,
  );
  const devIds = new Set(dev.map((item) => item.id));
  const remaining = new Map(
    [...populations].map(([key, population]) => [
      key,
      population.filter((item) => !devIds.has(item.id)),
    ]),
  );
  const allocation = allocateDescriptionSample(
    new Map(
      [...remaining]
        .filter(([, population]) => population.length > 0)
        .map(([key, population]) => [key, population.length]),
    ),
    new Map([...populations].map(([key, population]) => [key, population.length])),
    testSize,
  );
  const test = seededShuffle(
    [...remaining].flatMap(([key, population]) =>
      seededShuffle(population, `${seed}:test:${key}`).slice(0, allocation.get(key) ?? 0),
    ),
    `${seed}:test:order`,
  );
  const videos = seededShuffle(
    items.filter((item) => item.type === "video"),
    `${seed}:videos`,
  );
  function entries(
    set: "dev" | "test",
    selected: DescriptionSampleItem[],
  ): DescriptionSampleEntry[] {
    return selected.map((item, index) => {
      const key = requireDefined(stratumById.get(item.id), `stratum ${item.id}`);
      const n = set === "dev" ? null : requireDefined(allocation.get(key), `allocation ${key}`);
      const size = requireDefined(populations.get(key), `population ${key}`).length;
      return {
        itemId: item.id,
        blindId: `${set}-${String(index + 1).padStart(3, "0")}`,
        textHash: descriptionTextHash(item),
        stratumKey: key,
        inclusionProbability: n === null ? null : n / size,
        weight: n === null ? null : size / n,
      };
    });
  }
  const strata = [...populations].map(([key, population]) => ({
    key,
    populationSize: population.length,
    devSize: population.filter((item) => devIds.has(item.id)).length,
    testPopulationSize: (remaining.get(key) ?? []).length,
    testSize: allocation.get(key) ?? 0,
  }));
  if (videos.length > 0) {
    strata.push({
      key: "video:census",
      populationSize: videos.length,
      devSize: 0,
      testPopulationSize: videos.length,
      testSize: videos.length,
    });
  }
  return {
    schemaVersion: 1,
    snapshotManifestHash,
    seed,
    minWords,
    strata: strata.sort((a, b) => a.key.localeCompare(b.key)),
    sets: {
      dev: entries("dev", dev),
      test: entries("test", test),
      videos: videos.map((item, index) => ({
        itemId: item.id,
        blindId: `videos-${String(index + 1).padStart(3, "0")}`,
        textHash: descriptionTextHash(item),
        stratumKey: "video:census",
        inclusionProbability: 1,
        weight: 1,
      })),
    },
  };
}

export function validateDescriptionSample(
  sample: DescriptionSample,
  snapshotManifestHash: string,
  items: readonly DescriptionQualityItem[],
): void {
  if (sample.snapshotManifestHash !== snapshotManifestHash) {
    throw new Error("Description-quality snapshot manifest hash mismatch");
  }
  const entries = [...sample.sets.dev, ...sample.sets.test, ...sample.sets.videos];
  const byId = new Map(items.map((item) => [item.id, item]));
  if (
    new Set(entries.map((entry) => entry.itemId)).size !== entries.length ||
    byId.size !== items.length ||
    items.length !== entries.length
  ) {
    throw new Error("Description-quality frozen item IDs do not match the sample");
  }
  for (const entry of entries) {
    const item = requireDefined(byId.get(entry.itemId), `frozen item ${entry.itemId}`);
    if (descriptionTextHash(item) !== entry.textHash) {
      throw new Error(`Description-quality text hash mismatch for ${entry.itemId}`);
    }
  }
}

export function descriptionBlindCsv(
  entries: readonly DescriptionSampleEntry[],
  items: readonly DescriptionSampleItem[],
): string {
  const byId = new Map(items.map((item) => [item.id, item]));
  return encodeCsv([
    ["blind_id", "title", "description", "language", "content_type", "quality", "reason"],
    ...entries.map((entry) => {
      const item = requireDefined(byId.get(entry.itemId), `sample item ${entry.itemId}`);
      if (descriptionTextHash(item) !== entry.textHash) {
        throw new Error(`Description-quality text hash mismatch for ${entry.itemId}`);
      }
      return [entry.blindId, item.title, item.summary, item.language, item.type, "", ""];
    }),
  ]);
}

export function createDescriptionRepeat(input: {
  auditEntries: readonly DescriptionSampleEntry[];
  auditCsv: string;
  auditLabelsHash: string;
  completedAt: string;
  preparedAt: string;
  seed: number;
}) {
  const { auditEntries, auditCsv, auditLabelsHash, completedAt, preparedAt, seed } = input;
  if (sha256(auditCsv) !== auditLabelsHash) {
    throw new Error("Audit labels changed since the recorded completion");
  }
  const completed = Date.parse(completedAt);
  const prepared = Date.parse(preparedAt);
  if (!Number.isFinite(completed) || !Number.isFinite(prepared) || !Number.isSafeInteger(seed)) {
    throw new Error("Repeat preparation requires valid timestamps and an integer seed");
  }
  if (prepared - completed < 24 * 60 * 60 * 1000) {
    throw new Error("Repeat labelling must wait at least 24 hours after audit completion");
  }
  const rows = readConfiguredJudgingCsv(auditCsv, descriptionJudgingConfig);
  const entries = new Map(auditEntries.map((entry) => [entry.blindId, entry]));
  if (
    rows.length !== 30 ||
    entries.size !== 30 ||
    auditEntries.length !== 30 ||
    new Set(rows.map(({ values }) => values.blind_id)).size !== 30
  ) {
    throw new Error("Repeat preparation requires exactly 30 distinct audit items");
  }
  for (const { values } of rows) {
    const id = requireDefined(values.blind_id, "audit blind ID");
    const entry = requireDefined(entries.get(id), `audit entry ${id}`);
    if (values.quality === "" || values.reason === "") {
      throw new Error("Complete all audit labels before preparing repeat items");
    }
    if (
      descriptionTextHash({
        title: requireDefined(values.title, "audit title"),
        summary: requireDefined(values.description, "audit description"),
      }) !== entry.textHash ||
      !entry.stratumKey.startsWith(`${values.language}:`) ||
      values.content_type !== "article"
    ) {
      throw new Error(`Repeat input text or metadata mismatch for ${id}`);
    }
  }
  const selected = seededShuffle(
    [...rows].sort((a, b) =>
      requireDefined(a.values.blind_id, "audit blind ID").localeCompare(
        requireDefined(b.values.blind_id, "audit blind ID"),
      ),
    ),
    `${seed}:repeat`,
  ).slice(0, 10);
  return {
    design: {
      schemaVersion: 1,
      seed,
      auditLabelsHash,
      completedAt: new Date(completed).toISOString(),
      preparedAt: new Date(prepared).toISOString(),
      blindIds: selected.map(({ values }) => values.blind_id),
    },
    csv: encodeCsv([
      [
        ...descriptionJudgingConfig.displayColumns,
        ...Object.keys(descriptionJudgingConfig.answerColumns),
      ],
      ...selected.map(({ values }) => [
        ...descriptionJudgingConfig.displayColumns.map((column) =>
          requireDefined(values[column], `repeat field ${column}`),
        ),
        "",
        "",
      ]),
    ]),
  };
}

export function createDescriptionAudit(sample: DescriptionSample, testCsv: string) {
  const rows = readConfiguredJudgingCsv(testCsv, descriptionJudgingConfig);
  const entries = new Map(sample.sets.test.map((entry) => [entry.blindId, entry]));
  if (
    rows.length !== entries.size ||
    new Set(rows.map(({ values }) => values.blind_id)).size !== rows.length
  ) {
    throw new Error("Audit input must contain every original test row exactly once");
  }
  const retained = new Set<string>();
  const groups = new Map<string, string[]>();
  const counts = { fi: 0, en: 0 };
  for (const { values } of rows) {
    const id = requireDefined(values.blind_id, "audit blind ID");
    const entry = requireDefined(entries.get(id), `original test entry ${id}`);
    const language = values.language;
    if (
      descriptionTextHash({
        title: requireDefined(values.title, "audit title"),
        summary: requireDefined(values.description, "audit description"),
      }) !== entry.textHash ||
      (language !== "fi" && language !== "en") ||
      !entry.stratumKey.startsWith(`${language}:`) ||
      values.content_type !== "article"
    ) {
      throw new Error(`Audit input text or metadata mismatch for ${id}`);
    }
    if (values.quality !== "" || values.reason !== "") {
      retained.add(id);
      counts[language] += 1;
    } else {
      const key = `${language}:${entry.stratumKey.endsWith(":flagged") ? "flagged" : "not_flagged"}`;
      const ids = groups.get(key) ?? [];
      ids.push(id);
      groups.set(key, ids);
    }
  }
  const quota = 30 - retained.size;
  if (quota < 0 || rows.length < 30) {
    throw new Error("Audit needs 30 test rows and cannot discard more than 30 existing labels");
  }
  const orderedGroups = [...groups].sort(([a], [b]) => a.localeCompare(b));
  if (orderedGroups.length > quota) {
    throw new Error("Not enough audit slots to cover all remaining language/flag groups");
  }
  const allocation = new Map(orderedGroups.map(([key]) => [key, 1]));
  for (const [key] of orderedGroups) {
    if (key.startsWith("fi:")) counts.fi += 1;
    else counts.en += 1;
  }
  for (let remaining = quota - orderedGroups.length; remaining > 0; remaining -= 1) {
    const candidates = orderedGroups.filter(
      ([key, ids]) => (allocation.get(key) ?? 0) < ids.length,
    );
    candidates.sort(([a, aIds], [b, bIds]) => {
      const aLanguage = a.startsWith("fi:") ? "fi" : "en";
      const bLanguage = b.startsWith("fi:") ? "fi" : "en";
      return (
        counts[aLanguage] - counts[bLanguage] ||
        bIds.length / ((allocation.get(b) ?? 0) + 1) -
          aIds.length / ((allocation.get(a) ?? 0) + 1) ||
        a.localeCompare(b)
      );
    });
    const [key] = requireDefined(candidates[0], "available audit group");
    allocation.set(key, (allocation.get(key) ?? 0) + 1);
    if (key.startsWith("fi:")) counts.fi += 1;
    else counts.en += 1;
  }
  const probabilities = new Map([...retained].map((id) => [id, 1]));
  for (const [key, ids] of orderedGroups) {
    const n = requireDefined(allocation.get(key), `audit allocation ${key}`);
    const selected = seededShuffle([...ids].sort(), `${sample.seed}:audit:${key}`).slice(0, n);
    for (const id of selected) probabilities.set(id, n / ids.length);
  }
  const selectedIds = seededShuffle([...probabilities.keys()].sort(), `${sample.seed}:audit:order`);
  const rowById = new Map(rows.map(({ values }) => [values.blind_id, values]));
  const columns = [
    ...descriptionJudgingConfig.displayColumns,
    ...Object.keys(descriptionJudgingConfig.answerColumns),
  ];
  return {
    design: {
      schemaVersion: 1,
      seed: sample.seed,
      sourceLabelsHash: sha256(testCsv),
      retainedCount: retained.size,
      entries: selectedIds.map((id) => {
        const entry = requireDefined(entries.get(id), `audit entry ${id}`);
        const probability = requireDefined(probabilities.get(id), `audit probability ${id}`);
        return {
          ...entry,
          retained: retained.has(id),
          auditInclusionProbability: probability,
          auditWeight: requireDefined(entry.weight, `test weight ${id}`) / probability,
        };
      }),
    },
    csv: encodeCsv([
      columns,
      ...selectedIds.map((id) => {
        const values = requireDefined(rowById.get(id), `audit row ${id}`);
        return columns.map((column) => requireDefined(values[column], `audit field ${column}`));
      }),
    ]),
  };
}
