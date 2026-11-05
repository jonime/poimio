import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { readJudgingCsv, setJudgingRelevance } from "../lib/manual-judging.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(
      "Usage: pnpm eval:judge <file.csv>\nResume blank relevant cells; save each answer in place.\n1/y = relevant, 0/n = not relevant, s = skip, q = quit (then Enter).",
    );
    return;
  }
  if (args.length !== 1 || args[0]!.startsWith("-")) {
    throw new Error("Usage: pnpm eval:judge <file.csv>");
  }
  const path = resolve(args[0]!);
  let csv = await readFile(path, "utf8");
  const records = readJudgingCsv(csv);
  const pending = records.flatMap((record, index) => (record.relevant === "" ? [index] : []));
  if (!pending.length) {
    console.log("All records are already labeled. No changes made.");
    return;
  }

  console.log(
    `${records.length - pending.length}/${records.length} labeled. Answers are saved immediately.`,
  );
  const terminal = createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdin.isTTY && stdout.isTTY),
  });
  const answers = terminal[Symbol.asyncIterator]();
  let saved = 0;
  try {
    for (const index of pending) {
      const record = records[index]!;
      console.log(
        `\n${"-".repeat(60)}\nRecord ${index + 1}/${records.length}\n\nPersona: ${record.persona}\n${record.description}\n\nTitle: ${record.title}\n\nSummary:\n${record.summary}\n`,
      );
      while (true) {
        stdout.write("Relevant? [1/y] yes  [0/n] no  [s] skip  [q] quit: ");
        const answer = await answers.next();
        const choice = answer.value?.trim().toLowerCase();
        if (answer.done || choice === "q") return;
        if (choice === "s") break;
        const relevant =
          choice === "1" || choice === "y" ? "1" : choice === "0" || choice === "n" ? "0" : null;
        if (relevant === null) {
          console.log("Choose 1/y, 0/n, s, or q, then press Enter.");
          continue;
        }
        if ((await readFile(path, "utf8")) !== csv) {
          throw new Error(
            "CSV changed outside this CLI. Stopping without overwriting those changes; rerun to resume.",
          );
        }
        const updated = setJudgingRelevance(csv, index, relevant);
        await writeFile(path, updated, "utf8");
        csv = updated;
        saved += 1;
        console.log("Saved.");
        break;
      }
    }
  } finally {
    terminal.close();
    console.log(
      `\nSaved ${saved} answer(s). ${readJudgingCsv(csv).filter((record) => record.relevant === "").length} unlabeled; rerun the same command to resume.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
