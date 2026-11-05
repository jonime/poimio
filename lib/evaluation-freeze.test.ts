import { describe, expect, it } from "vitest";
import {
  frozenParametersHash,
  parseFrozenParameters,
  validateTestRun,
  type FrozenEvaluationParameters,
  type TestRunState,
} from "./evaluation-freeze.ts";

const frozen: FrozenEvaluationParameters = {
  schemaVersion: 1,
  parameters: { lambda: 0.5 },
  commitHash: "commit-1",
  snapshotManifestHash: "snapshot-1",
  labelSetId: "labels-1",
  labelSetHash: "label-hash-1",
  nearDuplicateThreshold: 0.9,
  configHash: "config-1",
  seeds: Array.from({ length: 10 }, (_, index) => index),
  kValues: [0, 1, 3, 5, 10, 20],
  createdAt: "2026-11-02T00:00:00.000Z",
};

const cleanState: TestRunState = {
  currentCommit: "commit-1",
  workingTreeClean: true,
  snapshotManifestHash: "snapshot-1",
  labelSetId: "labels-1",
  labelSetHash: "label-hash-1",
  configHash: "config-1",
  paramsProvided: false,
  existingTestResults: [],
};

describe("evaluation test-window freeze", () => {
  it("parses a valid freeze and derives its experiment ID from its hash", () => {
    expect(parseFrozenParameters(JSON.stringify(frozen))).toEqual(frozen);
    expect(frozenParametersHash(frozen)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects invalid freeze schemas", () => {
    expect(() => parseFrozenParameters(JSON.stringify({ ...frozen, schemaVersion: 9 }))).toThrow(
      /schema version/u,
    );
    expect(() => parseFrozenParameters(JSON.stringify({ ...frozen, seeds: [1, 2] }))).toThrow(
      /invalid schema/u,
    );
  });

  it("rejects missing freeze, dirty tree, wrong HEAD, mismatched hashes, and params", () => {
    const cases: Array<[Partial<TestRunState>, RegExp]> = [
      [{ workingTreeClean: false }, /clean working tree/u],
      [{ currentCommit: "other" }, /HEAD/u],
      [{ snapshotManifestHash: "other" }, /snapshot manifest hash/u],
      [{ labelSetHash: "other" }, /label set/u],
      [{ configHash: "other" }, /config hash/u],
      [{ paramsProvided: true }, /--params/u],
    ];
    for (const [changes, error] of cases) {
      expect(() => validateTestRun(frozen, { ...cleanState, ...changes })).toThrow(error);
    }
  });

  it("refuses duplicate experiment results and requires a reason for another run", () => {
    const experimentId = frozenParametersHash(frozen);
    expect(() =>
      validateTestRun(frozen, {
        ...cleanState,
        existingTestResults: [`test-${experimentId}.json`],
      }),
    ).toThrow(/already exists for this experiment/u);
    expect(() =>
      validateTestRun(frozen, {
        ...cleanState,
        existingTestResults: [`test-${experimentId}.csv`],
      }),
    ).toThrow(/already exists for this experiment/u);
    expect(() =>
      validateTestRun(frozen, {
        ...cleanState,
        existingTestResults: ["test-another.json"],
      }),
    ).toThrow(/--new-experiment/u);
    expect(
      validateTestRun(frozen, {
        ...cleanState,
        existingTestResults: ["test-another.json"],
        newExperimentReason: "Approved rerun",
      }).newExperimentReason,
    ).toBe("Approved rerun");
  });
});
