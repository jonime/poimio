import { access, appendFile, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DescriptionClassifier,
  parseDescriptionJudgeCache,
  runDescriptionJudges,
  validateFrozenDescriptionProtocol,
} from "../lib/evaluation-description-judges.ts";
import {
  createDescriptionAudit,
  createDescriptionRepeat,
  createDescriptionSample,
  type DescriptionSample,
  type DescriptionSampleEntry,
  descriptionBlindCsv,
  descriptionTextHash,
  parseDescriptionQualityItems,
  readDescriptionSnapshot,
  validateDescriptionSample,
} from "../lib/evaluation-description-quality.ts";
import { hashSnapshotRow, parseJsonLines, sha256 } from "../lib/evaluation-snapshot.ts";
import { descriptionJudgingConfig, readConfiguredJudgingCsv } from "../lib/manual-judging.ts";
import { requireDefined } from "../lib/required.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function workspacePath(value: string): string {
  const path = resolve(root, value);
  const local = relative(root, path);
  if (local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error("Description-quality paths must stay inside this worktree");
  }
  return path;
}

function parseArguments(args: string[]) {
  const command = args[0];
  if (command !== "sample" && command !== "audit" && command !== "repeat" && command !== "run") {
    throw new Error(
      "usage: pnpm eval:description-quality sample|audit|repeat|run [--snapshot <directory>] [--output <directory>]; run --set dev [--classifier both|jev|llm] [--run <positive integer>]; repeat requires --completed-at <timestamp> --audit-hash <sha256>; test runs, probe, and report are not implemented yet",
    );
  }
  let snapshot = workspacePath("evaluation/snapshot");
  let output = workspacePath("evaluation/description-quality");
  let seed = 9112026;
  let completedAt: string | undefined;
  let auditHash: string | undefined;
  let set: string | undefined;
  let classifier: "both" | DescriptionClassifier = "both";
  let run = 1;
  for (let index = 1; index < args.length; index += 1) {
    const option = requireDefined(args[index], "CLI option");
    if (
      option !== "--snapshot" &&
      option !== "--output" &&
      option !== "--seed" &&
      !(command === "repeat" && (option === "--completed-at" || option === "--audit-hash")) &&
      !(
        command === "run" &&
        (option === "--set" || option === "--classifier" || option === "--run")
      )
    ) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = requireDefined(args[++index], `value for ${option}`);
    if (option === "--snapshot") snapshot = workspacePath(value);
    if (option === "--output") output = workspacePath(value);
    if (option === "--completed-at") completedAt = value;
    if (option === "--audit-hash") auditHash = value;
    if (option === "--set") set = value;
    if (option === "--classifier") {
      if (value !== "both" && value !== "jev" && value !== "llm") {
        throw new Error("--classifier must be both, jev, or llm");
      }
      classifier = value;
    }
    if (option === "--run") {
      if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("--run must be a positive safe integer");
      }
      run = Number(value);
    }
    if (option === "--seed") {
      if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("--seed must be a safe integer");
      }
      seed = Number(value);
    }
  }
  if (command === "repeat" && (!completedAt || !auditHash)) {
    throw new Error("repeat requires --completed-at <timestamp> and --audit-hash <sha256>");
  }
  if (command === "run" && set !== "dev") {
    throw new Error(
      "Only --set dev is supported; test runs require frozen configuration in task 7",
    );
  }
  return { command, snapshot, output, seed, completedAt, auditHash, classifier, run };
}

async function requireNewFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Refusing to overwrite frozen sample or labels: ${relative(root, path)}`);
}

async function main(): Promise<void> {
  if (process.env.CI === "true") {
    throw new Error("Description-quality experiments must not run in CI");
  }
  const { command, snapshot, output, seed, completedAt, auditHash, classifier, run } =
    parseArguments(process.argv.slice(2));
  if (command === "repeat") {
    const [auditText, auditCsv, sampleText] = await Promise.all([
      readFile(resolve(output, "audit.json"), "utf8"),
      readFile(resolve(output, "labels-audit.csv"), "utf8"),
      readFile(resolve(output, "sample.json"), "utf8"),
    ]);
    const audit: { sampleHash: string; entries: DescriptionSampleEntry[] } = JSON.parse(auditText);
    if (audit.sampleHash !== sha256(sampleText)) {
      throw new Error("Audit sample hash mismatch");
    }
    const repeat = createDescriptionRepeat({
      auditEntries: audit.entries,
      auditCsv,
      auditLabelsHash: requireDefined(auditHash, "audit completion hash"),
      completedAt: requireDefined(completedAt, "audit completion timestamp"),
      preparedAt: new Date().toISOString(),
      seed,
    });
    const files = [
      [
        "repeat.json",
        `${JSON.stringify({ ...repeat.design, auditDesignHash: sha256(auditText) }, null, 2)}\n`,
      ],
      ["labels-repeat.csv", repeat.csv],
    ] as const;
    await Promise.all(files.map(([name]) => requireNewFile(resolve(output, name))));
    for (const [name, content] of files) {
      await writeFile(resolve(output, name), content, { flag: "wx" });
    }
    console.log(
      "Prepared 10 blind repeat items with blank answers. Original audit labels are unchanged.",
    );
    return;
  }
  const [manifestText, itemText] = await Promise.all([
    readFile(resolve(snapshot, "manifest.json"), "utf8"),
    readFile(resolve(snapshot, "items.jsonl"), "utf8"),
  ]);
  const inputs = readDescriptionSnapshot(manifestText, itemText);
  if (command === "run") {
    const [sampleText, frozenText, labelsText] = await Promise.all([
      readFile(resolve(output, "sample.json"), "utf8"),
      readFile(resolve(output, "items.jsonl"), "utf8"),
      readFile(resolve(output, "labels-dev.csv"), "utf8"),
    ]);
    const sample: DescriptionSample = JSON.parse(sampleText);
    let configText: string | null = null;
    try {
      configText = await readFile(resolve(output, "config.json"), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (configText !== null) {
      const config: unknown = JSON.parse(configText);
      validateFrozenDescriptionProtocol(config);
      if (
        config === null ||
        typeof config !== "object" ||
        !("sampleHash" in config) ||
        config.sampleHash !== sha256(sampleText) ||
        !("snapshotManifestHash" in config) ||
        config.snapshotManifestHash !== inputs.snapshotManifestHash ||
        !("labelCsvHashes" in config) ||
        config.labelCsvHashes === null ||
        typeof config.labelCsvHashes !== "object" ||
        !("dev" in config.labelCsvHashes) ||
        config.labelCsvHashes.dev !== sha256(labelsText)
      ) {
        throw new Error("Frozen description input or dev-label hash mismatch");
      }
    }
    validateDescriptionSample(
      sample,
      inputs.snapshotManifestHash,
      parseDescriptionQualityItems(frozenText),
    );
    const originals = new Map(inputs.items.map((item) => [item.id, item]));
    for (const frozen of parseJsonLines<unknown>(frozenText, "frozen description items")) {
      if (
        frozen === null ||
        typeof frozen !== "object" ||
        !("id" in frozen) ||
        typeof frozen.id !== "string"
      ) {
        throw new Error("Invalid frozen description input");
      }
      const original = requireDefined(originals.get(frozen.id), `original item ${frozen.id}`);
      if (hashSnapshotRow({ ...original }) !== hashSnapshotRow({ ...frozen })) {
        throw new Error(`Frozen item metadata mismatch for ${frozen.id}`);
      }
    }
    const devEntries = new Map(sample.sets.dev.map((entry) => [entry.blindId, entry]));
    const labels = readConfiguredJudgingCsv(labelsText, descriptionJudgingConfig);
    if (
      labels.length !== devEntries.size ||
      new Set(labels.map(({ values }) => values.blind_id)).size !== labels.length
    )
      throw new Error("Dev labels must contain each sampled dev item exactly once");
    for (const { values } of labels) {
      const entry = requireDefined(devEntries.get(values.blind_id ?? ""), "sampled dev label");
      const item = requireDefined(originals.get(entry.itemId), `dev item ${entry.itemId}`);
      if (
        values.quality === "" ||
        values.reason === "" ||
        descriptionTextHash({ title: values.title ?? "", summary: values.description ?? "" }) !==
          entry.textHash ||
        values.language !== item.language ||
        values.content_type !== item.type
      )
        throw new Error("Dev labels are incomplete or differ from the frozen inputs");
    }
    const lockPath = resolve(output, ".judge-cache.lock");
    const lock = await open(lockPath, "wx");
    try {
      await lock.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      const cachePath = resolve(output, "judge-cache.jsonl");
      let cacheText = "";
      try {
        cacheText = await readFile(cachePath, "utf8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const cache = parseDescriptionJudgeCache(cacheText);
      if (cacheText !== "" && !cacheText.endsWith("\n")) {
        throw new Error("Judge cache must end with a newline before appending");
      }
      const classifiers: DescriptionClassifier[] =
        classifier === "both" ? ["jev", "llm"] : [classifier];
      const totals = await runDescriptionJudges({
        items: sample.sets.dev.map((entry) =>
          requireDefined(originals.get(entry.itemId), `dev item ${entry.itemId}`),
        ),
        classifiers,
        run,
        keys: { jev: process.env.TYPESAFE_API_KEY ?? "", llm: process.env.OPENAI_API_KEY ?? "" },
        cache,
        append: async (row) => {
          await appendFile(cachePath, `${JSON.stringify(row)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          console.log(`${row.classifier} ${row.itemId}: ${row.result.status}`);
        },
      });
      console.log(JSON.stringify({ set: "dev", run, ...totals }));
      if (totals.errors > 0) process.exitCode = 1;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
    return;
  }
  if (command === "audit") {
    const [sampleText, frozenText, testCsv] = await Promise.all([
      readFile(resolve(output, "sample.json"), "utf8"),
      readFile(resolve(output, "items.jsonl"), "utf8"),
      readFile(resolve(output, "labels-test.csv"), "utf8"),
    ]);
    const sample: DescriptionSample = JSON.parse(sampleText);
    validateDescriptionSample(
      sample,
      inputs.snapshotManifestHash,
      parseDescriptionQualityItems(frozenText),
    );
    const audit = createDescriptionAudit(sample, testCsv);
    const files = [
      [
        "audit.json",
        `${JSON.stringify({ ...audit.design, sampleHash: sha256(sampleText) }, null, 2)}\n`,
      ],
      ["labels-audit.csv", audit.csv],
    ] as const;
    await Promise.all(files.map(([name]) => requireNewFile(resolve(output, name))));
    for (const [name, content] of files) {
      await writeFile(resolve(output, name), content, { flag: "wx" });
    }
    console.log(
      `Prepared 30 audit items; preserved ${audit.design.retainedCount} started rows. Original labels are unchanged.`,
    );
    return;
  }
  const sample = createDescriptionSample({ ...inputs, seed });
  const entries = [...sample.sets.dev, ...sample.sets.test, ...sample.sets.videos];
  const ids = new Set(entries.map((entry) => entry.itemId));
  const copiedItems = inputs.items.filter((item) => ids.has(item.id));
  validateDescriptionSample(sample, inputs.snapshotManifestHash, copiedItems);
  const files = [
    ["items.jsonl", `${copiedItems.map((item) => JSON.stringify(item)).join("\n")}\n`],
    ["labels-dev.csv", descriptionBlindCsv(sample.sets.dev, copiedItems)],
    ["labels-test.csv", descriptionBlindCsv(sample.sets.test, copiedItems)],
    ["labels-videos.csv", descriptionBlindCsv(sample.sets.videos, copiedItems)],
    ["sample.json", `${JSON.stringify(sample, null, 2)}\n`],
  ] as const;
  await Promise.all(files.map(([name]) => requireNewFile(resolve(output, name))));
  await mkdir(output, { recursive: true });
  for (const [name, content] of files) {
    await writeFile(resolve(output, name), content, { flag: "wx" });
  }
  function counts(field: "source_id" | "language" | "summary_origin") {
    const result: Record<string, number> = {};
    for (const item of copiedItems) result[item[field]] = (result[item[field]] ?? 0) + 1;
    return result;
  }
  console.log(
    JSON.stringify(
      {
        output: relative(root, output),
        counts: {
          dev: sample.sets.dev.length,
          test: sample.sets.test.length,
          videos: sample.sets.videos.length,
          bySource: counts("source_id"),
          byLanguage: counts("language"),
          byOrigin: counts("summary_origin"),
        },
        strata: sample.strata,
      },
      null,
      2,
    ),
  );
  console.log(
    "Blind labels are blank. Poor-item language coverage can only be checked after human labelling.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Description-quality sampling failed");
  process.exitCode = 1;
});
