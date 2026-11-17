import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import {
  descriptionJudgingConfig,
  readConfiguredJudgingCsv,
  relevanceConfig,
  setJudgingAnswer,
} from "../lib/manual-judging.ts";
import { requireDefined } from "../lib/required.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(
      "Usage: pnpm eval:judge [--description-quality] <file.csv>\nResume blank answer cells; save each answer in place.\nRelevance: 1/y = relevant, 0/n = not relevant.\nDescription quality: 1 = good, 2 = weak, 3 = unusable; then select a reason.\ns = skip item, q = quit (then Enter).",
    );
    return;
  }
  const descriptionQuality = args[0] === "--description-quality";
  const argument = args[descriptionQuality ? 1 : 0];
  if (
    args.length !== (descriptionQuality ? 2 : 1) ||
    argument === undefined ||
    argument.startsWith("-")
  ) {
    throw new Error("Usage: pnpm eval:judge [--description-quality] <file.csv>");
  }
  const config = descriptionQuality ? descriptionJudgingConfig : relevanceConfig;
  const columns = Object.keys(config.answerColumns);
  const path = resolve(argument);
  let csv = await readFile(path, "utf8");
  const records = readConfiguredJudgingCsv(csv, config);
  const incomplete = (record: (typeof records)[number]) =>
    columns.some((column) => record.values[column] === "");
  const pending = records.flatMap((record, index) => (incomplete(record) ? [index] : []));
  if (!pending.length) {
    console.log("All records are already labeled. No changes made.");
    return;
  }

  console.log(
    `${records.length - pending.length}/${records.length} labeled. Answers are saved immediately.`,
  );
  if (descriptionQuality) {
    console.log(
      "\nJudge only the title and description, not factual accuracy against the article.\n" +
        "good: states the specific subject or main point.\n" +
        "weak: some item-specific information, but vague, teaser-like, or incomplete.\n" +
        "unusable: nothing specific; if title and description together do not reveal the topic, choose unusable.\n" +
        "Reasons: none = no problem; boilerplate = generic publisher/site text; placeholder = missing-value marker;\n" +
        "promotional = call to act; teaser = hints without the point; vague = insufficient detail;\n" +
        "page_structure = layout/navigation/format; off_topic = different subject; other = another problem.\n" +
        "Enter a displayed number or the exact label; s skips the item, q quits. Saved answers are kept.",
    );
  }
  const terminal = createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdin.isTTY && stdout.isTTY),
  });
  const answers = terminal[Symbol.asyncIterator]();
  let saved = 0;
  try {
    for (const index of pending) {
      const { values } = requireDefined(records[index], `judging record ${index + 1}`);
      console.log(
        descriptionQuality
          ? `\n${"-".repeat(60)}\nRecord ${index + 1}/${records.length} (${values.blind_id})\n${values.language} | ${values.content_type}\n\nTitle: ${values.title}\n\nDescription:\n${values.description}\n`
          : `\n${"-".repeat(60)}\nRecord ${index + 1}/${records.length}\n\nPersona: ${values.persona_id}\n${values.persona_description}\n\nTitle: ${values.title}\n\nSummary:\n${values.summary}\n`,
      );
      answerColumns: for (const column of columns) {
        if (values[column] !== "") {
          if (descriptionQuality) console.log(`${column}: ${values[column]} (already saved)`);
          continue;
        }
        const allowed = requireDefined(config.answerColumns[column], `answers for ${column}`);
        for (;;) {
          stdout.write(
            descriptionQuality
              ? `${column}? ${allowed.map((label, index) => `[${index + 1}] ${label}`).join("  ")}  [s] skip  [q] quit: `
              : "Relevant? [1/y] yes  [0/n] no  [s] skip  [q] quit: ",
          );
          const answer = await answers.next();
          const choice = answer.value?.trim().toLowerCase();
          if (answer.done || choice === "q") return;
          if (choice === "s") break answerColumns;
          const selected = descriptionQuality
            ? allowed.find((label, index) => choice === label || choice === String(index + 1))
            : choice === "1" || choice === "y"
              ? "1"
              : choice === "0" || choice === "n"
                ? "0"
                : undefined;
          if (selected === undefined) {
            console.log(
              descriptionQuality
                ? "Choose a displayed number or label, s, or q, then press Enter."
                : "Choose 1/y, 0/n, s, or q, then press Enter.",
            );
            continue;
          }
          if ((await readFile(path, "utf8")) !== csv) {
            throw new Error(
              "CSV changed outside this CLI. Stopping without overwriting those changes; rerun to resume.",
            );
          }
          const updated = setJudgingAnswer(csv, index, column, selected, config);
          await writeFile(path, updated, "utf8");
          csv = updated;
          saved += 1;
          console.log("Saved.");
          break;
        }
      }
    }
  } finally {
    terminal.close();
    console.log(
      `\nSaved ${saved} answer(s). ${readConfiguredJudgingCsv(csv, config).filter(incomplete).length} unlabeled; rerun the same command to resume.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
