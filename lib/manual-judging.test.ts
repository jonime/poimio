import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  descriptionJudgingConfig,
  readConfiguredJudgingCsv,
  readJudgingCsv,
  setJudgingAnswer,
  setJudgingRelevance,
} from "./manual-judging.ts";

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

  describe("description-quality CSV judging", () => {
    it.each(["\n", "\r\n"])("edits only answer cells with %j endings", (newline) => {
      const csv = [
        "\uFEFFblind_id,title,description,language,content_type,quality,reason,extra",
        'dev-001,"A ""quoted"" title","Finnish: ä' +
          newline +
          'second line",fi,article,"",,unchanged',
      ].join(newline);
      const withQuality = setJudgingAnswer(csv, 0, "quality", "weak", descriptionJudgingConfig);
      const updated = setJudgingAnswer(
        withQuality,
        0,
        "reason",
        "teaser",
        descriptionJudgingConfig,
      );
      expect(updated).toBe(csv.replace('article,"",,unchanged', 'article,"weak",teaser,unchanged'));
      expect(readConfiguredJudgingCsv(updated, descriptionJudgingConfig)[0]?.values).toMatchObject({
        quality: "weak",
        reason: "teaser",
        title: 'A "quoted" title',
        description: `Finnish: ä${newline}second line`,
        extra: "unchanged",
      });
    });

    it("supports partially completed rows and an empty final field without a newline", () => {
      const csv =
        "blind_id,title,description,language,content_type,quality,reason\n" +
        "dev-001,Title,Summary,en,article,good,";
      expect(setJudgingAnswer(csv, 0, "reason", "none", descriptionJudgingConfig)).toBe(
        `${csv}none`,
      );
      expect(() => setJudgingAnswer(csv, 0, "quality", "great", descriptionJudgingConfig)).toThrow(
        /Invalid judging answer/u,
      );
      expect(() => setJudgingAnswer(csv, 0, "title", "changed", descriptionJudgingConfig)).toThrow(
        /Invalid judging answer/u,
      );
      expect(() => setJudgingAnswer(csv, 1, "quality", "good", descriptionJudgingConfig)).toThrow(
        /does not exist/u,
      );
    });

    it.each([
      "blind_id,title,description,language,content_type,quality\nx,t,d,en,article,\n",
      "blind_id,title,description,language,content_type,quality,reason\nx,t,d,en,article,bad,none\n",
      "blind_id,title,description,language,content_type,quality,reason\nx,t,d,en,article,weak,invalid\n",
      "blind_id,title,description,language,content_type,quality,reason,reason\nx,t,d,en,article,weak,,\n",
      "blind_id,title,description,language,content_type,quality,reason\nx,t,d,en,article,\n",
    ])("rejects malformed or invalid description labels", (csv) => {
      expect(() => readConfiguredJudgingCsv(csv, descriptionJudgingConfig)).toThrow();
    });

    it("saves each field, resumes partial labels, skips, and keeps classifier metadata hidden", () => {
      const directory = mkdtempSync(join(tmpdir(), "poimio-description-judge-"));
      const path = join(directory, "labels.csv");
      const csv =
        '"blind_id","title","description","language","content_type","quality","reason","source"\r\n' +
        '"dev-001","First","Summary one","fi","article","","","HIDDEN_SOURCE"\r\n' +
        '"dev-002","Second","Summary two","en","video","","","HIDDEN_SOURCE"\r\n';
      const run = (input: string) =>
        spawnSync(process.execPath, ["scripts/judge-csv.mts", "--description-quality", path], {
          input,
          encoding: "utf8",
          timeout: 10_000,
        });
      try {
        writeFileSync(path, csv);
        const partial = run("invalid\n2\nq\n");
        expect(partial.status, partial.stderr).toBe(0);
        expect(partial.stdout).toContain("Choose a displayed number");
        expect(partial.stdout).toContain("fi | article");
        expect(partial.stdout).toContain("Summary one");
        expect(partial.stdout).not.toContain("HIDDEN_SOURCE");
        expect(readFileSync(path, "utf8")).toBe(
          csv.replace('"article","",""', '"article","weak",""'),
        );
        const resumed = run("teaser\ns\n");
        expect(resumed.status, resumed.stderr).toBe(0);
        expect(resumed.stdout).toContain("quality: weak (already saved)");
        expect(resumed.stdout).toContain("1 unlabeled");
        const completed = run("1\n1\n");
        expect(completed.status, completed.stderr).toBe(0);
        expect(completed.stdout).not.toContain("Title: First");
        expect(completed.stdout).toContain("0 unlabeled");
        expect(readFileSync(path, "utf8")).toBe(
          csv
            .replace('"article","",""', '"article","weak","teaser"')
            .replace('"video","",""', '"video","good","none"'),
        );
        expect(run("").stdout).toContain("All records are already labeled");
        writeFileSync(path, csv);
        expect(run("").status).toBe(0);
        expect(readFileSync(path, "utf8")).toBe(csv);
        const eofAfterQuality = run("3\n");
        expect(eofAfterQuality.status, eofAfterQuality.stderr).toBe(0);
        expect(readFileSync(path, "utf8")).toBe(
          csv.replace('"article","",""', '"article","unusable",""'),
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("preserves unquoted fields, existing labels, and missing final newline", () => {
    const csv = "persona_id,persona_description,title,summary,relevant\np,d,t,s,0\np,d,t,s,";
    const updated = setJudgingRelevance(csv, 1, "1");
    expect(updated).toBe(`${csv}1`);
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
