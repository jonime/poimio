import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CenteredJudgingRow,
  type CenteredRankingAnswerKey,
  parseCsv,
  scoreCenteredEarlyRanking,
} from "../lib/early-ranking.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "evaluation/early-ranking");

function parseJudgments(csv: string, path: string): CenteredJudgingRow[] {
  const [header, ...records] = parseCsv(csv);
  if (!header) throw new Error(`${path} is empty`);
  const columns = new Map(header.map((name, index) => [name, index]));
  for (const required of ["persona", "url", "relevant"]) {
    if (!columns.has(required)) throw new Error(`${path} is missing ${required}`);
  }
  return records.map((record) => ({
    persona: record[columns.get("persona")!] ?? "",
    url: record[columns.get("url")!] ?? "",
    relevant: record[columns.get("relevant")!] ?? "",
  }));
}

async function main(): Promise<void> {
  const previousJudgments = parseJudgments(
    await readFile(resolve(directory, "judging.csv"), "utf8"),
    "judging.csv",
  );
  const newJudgments = parseJudgments(
    await readFile(resolve(directory, "centered-judging.csv"), "utf8"),
    "centered-judging.csv",
  );
  const answerKey = JSON.parse(
    await readFile(resolve(directory, ".centered-answer-key.json"), "utf8"),
  ) as CenteredRankingAnswerKey;
  const results = scoreCenteredEarlyRanking([...previousJudgments, ...newJudgments], answerKey);
  const resultsPath = resolve(directory, "centered-results.json");
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  console.log("Saved evaluation/early-ranking/centered-results.json");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
