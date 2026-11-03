import { parseCsv } from "./early-ranking.ts";

interface CsvField {
  start: number;
  end: number;
}

export function readJudgingCsv(csv: string) {
  const offset = csv.startsWith("\uFEFF") ? 1 : 0;
  const [header, ...records] = parseCsv(csv.slice(offset));
  if (!header) throw new Error("CSV is empty");
  for (const name of [
    "persona_id",
    "persona_description",
    "title",
    "summary",
    "relevant",
  ]) {
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
      if (position === csv.length)
        fields.push({ start: position, end: position });
    } else if (
      delimiter === "\n" ||
      delimiter === "\r" ||
      delimiter === undefined
    ) {
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

  const relevantIndex = header.indexOf("relevant");
  return records.map((record, index) => {
    const spans = rows[index + 1]!;
    if (record.length !== header.length || spans.length !== header.length) {
      throw new Error(
        `CSV record ${index + 1} has the wrong number of columns`,
      );
    }
    const get = (name: string) => record[header.indexOf(name)]!;
    const relevant = get("relevant");
    if (relevant !== "" && relevant !== "0" && relevant !== "1") {
      throw new Error(
        `CSV record ${index + 1}: relevant must be blank, 0, or 1`,
      );
    }
    return {
      persona: get("persona_id"),
      description: get("persona_description"),
      title: get("title"),
      summary: get("summary"),
      relevant,
      field: spans[relevantIndex]!,
    };
  });
}

export function setJudgingRelevance(
  csv: string,
  recordIndex: number,
  relevant: "0" | "1",
): string {
  const record = readJudgingCsv(csv)[recordIndex];
  if (!record) throw new Error("CSV record does not exist");
  const { start, end } = record.field;
  const quoted = csv[start] === '"';
  return (
    csv.slice(0, start) + (quoted ? `"${relevant}"` : relevant) + csv.slice(end)
  );
}
