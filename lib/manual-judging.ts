import { parseCsv } from "./early-ranking.ts";
import { requireDefined } from "./required.ts";

interface CsvField {
  start: number;
  end: number;
}

export interface JudgingCsvConfig {
  displayColumns: readonly string[];
  answerColumns: Readonly<Record<string, readonly string[]>>;
}

export const relevanceConfig: JudgingCsvConfig = {
  displayColumns: ["persona_id", "persona_description", "title", "summary"],
  answerColumns: { relevant: ["0", "1"] },
};

export const descriptionJudgingConfig: JudgingCsvConfig = {
  displayColumns: ["blind_id", "title", "description", "language", "content_type"],
  answerColumns: {
    quality: ["good", "weak", "unusable"],
    reason: [
      "none",
      "boilerplate",
      "placeholder",
      "promotional",
      "teaser",
      "vague",
      "page_structure",
      "off_topic",
      "other",
    ],
  },
};

export const descriptionStyleReviewConfig: JudgingCsvConfig = {
  displayColumns: ["pair_id", "title", "language", "item_url", "description_a", "description_b"],
  answerColumns: {
    preference: ["A", "B", "tie"],
    unsupported: ["A", "B", "both", "neither"],
    wrong_language: ["A", "B", "both", "neither"],
    later_sentence_narration: ["A", "B", "both", "neither"],
  },
};

export function readConfiguredJudgingCsv(csv: string, config: JudgingCsvConfig) {
  const offset = csv.startsWith("\uFEFF") ? 1 : 0;
  const [header, ...records] = parseCsv(csv.slice(offset));
  if (!header) throw new Error("CSV is empty");
  for (const name of [...config.displayColumns, ...Object.keys(config.answerColumns)]) {
    if (header.filter((column) => column === name).length !== 1) {
      throw new Error(`CSV must have exactly one ${name} column`);
    }
  }

  const rows: CsvField[][] = [];
  let fields: CsvField[] = [];
  let position = offset;
  const fieldPattern = /"(?:[^"]|"")*"|[^",\r\n]*/y;
  while (position < csv.length) {
    fieldPattern.lastIndex = position;
    const match = fieldPattern.exec(csv);
    if (!match) throw new Error(`Invalid CSV field at offset ${position}`);
    fields.push({ start: position, end: fieldPattern.lastIndex });
    position = fieldPattern.lastIndex;
    const delimiter = csv[position];
    if (delimiter === ",") {
      position += 1;
      if (position === csv.length) fields.push({ start: position, end: position });
    } else if (delimiter === "\n" || delimiter === "\r" || delimiter === undefined) {
      rows.push(fields);
      fields = [];
      if (delimiter === "\r" && csv[position + 1] !== "\n") {
        throw new Error("Use LF or CRLF line endings");
      }
      position += delimiter === "\r" ? 2 : 1;
    } else {
      throw new Error(`Invalid CSV delimiter at offset ${position}`);
    }
  }
  if (fields.length) rows.push(fields);
  if (rows.length !== records.length + 1) throw new Error("Invalid CSV rows");

  return records.map((record, index) => {
    const spans = requireDefined(rows[index + 1], `CSV row ${index + 1}`);
    if (record.length !== header.length || spans.length !== header.length) {
      throw new Error(`CSV record ${index + 1} has the wrong number of columns`);
    }
    const get = (name: string) =>
      requireDefined(record[header.indexOf(name)], `CSV field ${name} in row ${index + 1}`);
    for (const [column, allowed] of Object.entries(config.answerColumns)) {
      const answer = get(column);
      if (answer !== "" && !allowed.includes(answer)) {
        throw new Error(
          `CSV record ${index + 1}: ${column} must be blank or one of ${allowed.join(", ")}`,
        );
      }
    }
    return {
      values: Object.fromEntries(header.map((column) => [column, get(column)])),
      fields: Object.fromEntries(
        Object.keys(config.answerColumns).map((column) => [
          column,
          requireDefined(spans[header.indexOf(column)], `${column} span in CSV row ${index + 1}`),
        ]),
      ),
    };
  });
}

export function setJudgingAnswer(
  csv: string,
  recordIndex: number,
  column: string,
  answer: string,
  config: JudgingCsvConfig,
): string {
  if (
    !Object.hasOwn(config.answerColumns, column) ||
    !config.answerColumns[column]?.includes(answer)
  ) {
    throw new Error(`Invalid judging answer for ${column}`);
  }
  const record = readConfiguredJudgingCsv(csv, config)[recordIndex];
  if (!record) throw new Error("CSV record does not exist");
  const { start, end } = requireDefined(record.fields[column], `judging field ${column}`);
  const quoted = csv[start] === '"';
  const encoded = quoted || /[",\r\n]/u.test(answer) ? `"${answer.replaceAll('"', '""')}"` : answer;
  return csv.slice(0, start) + encoded + csv.slice(end);
}

export function readJudgingCsv(csv: string) {
  return readConfiguredJudgingCsv(csv, relevanceConfig).map(({ values, fields }) => ({
    persona: requireDefined(values.persona_id, "persona_id"),
    description: requireDefined(values.persona_description, "persona_description"),
    title: requireDefined(values.title, "title"),
    summary: requireDefined(values.summary, "summary"),
    relevant: requireDefined(values.relevant, "relevant"),
    field: requireDefined(fields.relevant, "relevance span"),
  }));
}

export function setJudgingRelevance(csv: string, recordIndex: number, relevant: "0" | "1"): string {
  return setJudgingAnswer(csv, recordIndex, "relevant", relevant, relevanceConfig);
}
