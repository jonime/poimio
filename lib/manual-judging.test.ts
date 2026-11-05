import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJudgingCsv, setJudgingRelevance } from "./manual-judging.ts";

describe("manual CSV judging", () => {
  it.each(["\n", "\r\n"])("changes only the relevant value with %j endings", (newline) => {
    const csv =
      '\uFEFF"persona_id",persona_description,"relevant",title,summary,extra' +
      newline +
      'ai,"Software, AI","","A ""quoted"" title","Finnish: ä' +
      newline +
      'second line",untouched' +
      newline;
    const updated = setJudgingRelevance(csv, 0, "1");
    expect(Buffer.from(updated)).toEqual(Buffer.from(csv.replace(',"",', ',"1",')));
    expect(readJudgingCsv(updated)[0]).toMatchObject({
      persona: "ai",
      title: 'A "quoted" title',
      summary: `Finnish: ä${newline}second line`,
      relevant: "1",
    });
  });

  it("preserves unquoted fields, existing labels, and missing final newline", () => {
    const csv = "persona_id,persona_description,title,summary,relevant\np,d,t,s,0\np,d,t,s,";
    const updated = setJudgingRelevance(csv, 1, "1");
    expect(updated).toBe(csv + "1");
    expect(setJudgingRelevance(updated, 0, "1")).toBe(updated.replace("s,0", "s,1"));
  });

  it("handles an empty relevance field before other columns", () => {
    const csv = "persona_id,persona_description,relevant,title,summary\np,d,,t,s\n";
    expect(setJudgingRelevance(csv, 0, "0")).toBe(csv.replace("d,,t", "d,0,t"));
  });

  it.each([
    "persona_id,persona_description,title,summary\np,d,t,s\n",
    "persona_id,persona_description,title,summary,relevant\np,d,t,s,yes\n",
    "persona_id,persona_description,title,summary,relevant\np,d,t\n",
    'persona_id,persona_description,title,summary,relevant\np,d,"unfinished,s,\n',
    'persona_id,persona_description,title,summary,relevant\np,d,"title"junk,s,\n',
  ])("rejects invalid CSV without producing an edit", (csv) => {
    expect(() => setJudgingRelevance(csv, 0, "1")).toThrow();
  });

  it("saves, skips, quits, and resumes through the actual CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "poimio-judge-"));
    const path = join(directory, "sample.csv");
    const csv =
      '"persona_id","persona_description","title","summary","relevant"\r\n' +
      '"ai","AI tools","First","Summary one",""\r\n' +
      '"cars","Engineering","Second","Summary two",""\r\n' +
      '"science","Space","Third","Summary three",""\r\n';
    const run = (input: string) =>
      spawnSync(
        process.execPath,
        [
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          "--experimental-strip-types",
          "scripts/judge-csv.mts",
          path,
        ],
        { input, encoding: "utf8", timeout: 10_000 },
      );
    try {
      writeFileSync(path, csv);
      const first = run("invalid\ny\ns\nq\n");
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("Persona: ai\nAI tools");
      expect(first.stdout).toContain("Summary one");
      expect(first.stdout).toContain("Choose 1/y");
      expect(readFileSync(path, "utf8")).toBe(csv.replace('"Summary one",""', '"Summary one","1"'));

      const resumed = run("n\n1\n");
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).not.toContain("Title: First");
      const expected = csv
        .replace('"Summary one",""', '"Summary one","1"')
        .replace('"Summary two",""', '"Summary two","0"')
        .replace('"Summary three",""', '"Summary three","1"');
      expect(readFileSync(path)).toEqual(Buffer.from(expected));
      expect(run("").stdout).toContain("All records are already labeled");

      writeFileSync(path, csv);
      expect(run("").status).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(csv);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
