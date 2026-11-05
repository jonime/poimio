import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type JudgingRow,
  parseCsv,
  type RankingAnswerKey,
  scoreEarlyRanking,
} from "../lib/early-ranking.ts";
import { requireDefined } from "../lib/required.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "evaluation/early-ranking");

async function main(): Promise<void> {
  const csv = await readFile(resolve(directory, "judging.csv"), "utf8");
  const answerKey = JSON.parse(
    await readFile(resolve(directory, ".answer-key.json"), "utf8"),
  ) as RankingAnswerKey;
  const [header, ...records] = parseCsv(csv);
  if (!header) throw new Error("judging.csv is empty");
  const columns = new Map(header.map((name, index) => [name, index]));
  for (const required of ["persona", "blind_id", "relevant"]) {
    if (!columns.has(required)) throw new Error(`judging.csv is missing ${required}`);
  }
  const judgments: JudgingRow[] = records.map((record) => ({
    persona: record[requireDefined(columns.get("persona"), "persona column")] ?? "",
    blind_id: record[requireDefined(columns.get("blind_id"), "blind_id column")] ?? "",
    relevant: record[requireDefined(columns.get("relevant"), "relevant column")] ?? "",
  }));
  const results = scoreEarlyRanking(judgments, answerKey);
  const resultsPath = resolve(directory, "results.json");
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  console.log("Saved evaluation/early-ranking/results.json");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
