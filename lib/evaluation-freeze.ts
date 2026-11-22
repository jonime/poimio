import { createHash } from "node:crypto";
import { isRankingMethod, resolveRankingParameters } from "./ranking-parameters.ts";

export const EVALUATION_FREEZE_SCHEMA_VERSION = 2;

export interface FrozenEvaluationParameters {
  schemaVersion: number;
  method: string;
  parameters: Record<string, unknown>;
  commitHash: string;
  snapshotManifestHash: string;
  labelSetId: string;
  labelSetHash: string;
  nearDuplicateThreshold: number;
  configHash: string;
  seeds: number[];
  kValues: number[];
  createdAt: string;
}

export interface TestRunState {
  currentCommit: string;
  workingTreeClean: boolean;
  snapshotManifestHash: string;
  labelSetId: string;
  labelSetHash: string;
  configHash: string;
  paramsProvided: boolean;
  existingTestResults: string[];
  newExperimentReason?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function resolveFrozenTreatment(value: unknown): {
  method: string;
  parameters: Record<string, unknown>;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--params must contain a JSON object");
  }
  const treatment = value as Record<string, unknown>;
  const method = treatment.method;
  if (typeof method !== "string" || !isRankingMethod(method)) {
    throw new Error("--params method must be a known ranking method");
  }
  const nestedParameters = treatment.parameters;
  const parameters =
    nestedParameters === undefined
      ? Object.fromEntries(Object.entries(treatment).filter(([key]) => key !== "method"))
      : nestedParameters !== null &&
          typeof nestedParameters === "object" &&
          !Array.isArray(nestedParameters)
        ? (nestedParameters as Record<string, unknown>)
        : (() => {
            throw new Error("--params parameters must be a JSON object");
          })();
  return { method, parameters: resolveRankingParameters(method, parameters) };
}

export function frozenParametersHash(frozen: FrozenEvaluationParameters): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(frozen)))
    .digest("hex");
}

export function parseFrozenParameters(content: string): FrozenEvaluationParameters {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("frozen-params.json is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frozen parameters must be a JSON object");
  }
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== EVALUATION_FREEZE_SCHEMA_VERSION) {
    throw new Error("frozen parameter schema version is unsupported");
  }
  const parameters = value.parameters;
  if (
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    parameters === null ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    typeof (parameters as Record<string, unknown>).diversity !== "number" ||
    !Number.isFinite((parameters as Record<string, unknown>).diversity) ||
    Number((parameters as Record<string, unknown>).diversity) < 0 ||
    Number((parameters as Record<string, unknown>).diversity) > 1 ||
    typeof (parameters as Record<string, unknown>).exploration !== "boolean" ||
    value.parameters === null ||
    typeof value.parameters !== "object" ||
    Array.isArray(value.parameters) ||
    typeof value.commitHash !== "string" ||
    typeof value.snapshotManifestHash !== "string" ||
    typeof value.labelSetId !== "string" ||
    typeof value.labelSetHash !== "string" ||
    typeof value.configHash !== "string" ||
    typeof value.nearDuplicateThreshold !== "number" ||
    !Number.isFinite(value.nearDuplicateThreshold) ||
    !Array.isArray(value.seeds) ||
    value.seeds.length < 10 ||
    value.seeds.some((seed) => !Number.isInteger(seed)) ||
    !Array.isArray(value.kValues) ||
    value.kValues.some((k) => !Number.isInteger(k) || k < 0) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("frozen parameters have an invalid schema");
  }
  return value as unknown as FrozenEvaluationParameters;
}

export function validateTestRun(
  frozen: FrozenEvaluationParameters,
  state: TestRunState,
): { experimentId: string; newExperimentReason: string | null } {
  if (!state.workingTreeClean) {
    throw new Error("test replay requires a clean working tree");
  }
  if (state.currentCommit !== frozen.commitHash) {
    throw new Error("HEAD does not match the frozen commit");
  }
  if (state.snapshotManifestHash !== frozen.snapshotManifestHash) {
    throw new Error("snapshot manifest hash does not match the freeze");
  }
  if (state.labelSetId !== frozen.labelSetId || state.labelSetHash !== frozen.labelSetHash) {
    throw new Error("label set does not match the freeze");
  }
  if (state.configHash !== frozen.configHash) {
    throw new Error("evaluation config hash does not match the freeze");
  }
  if (state.paramsProvided) {
    throw new Error("test replay does not accept --params; use frozen parameters");
  }
  const experimentId = frozenParametersHash(frozen);
  const sameExperimentPrefix = `test-${experimentId}.`;
  if (state.existingTestResults.some((name) => name.startsWith(sameExperimentPrefix))) {
    throw new Error("a test result already exists for this experiment ID");
  }
  const otherResults = state.existingTestResults.filter((name) => name.startsWith("test-"));
  const reason = state.newExperimentReason?.trim();
  if (otherResults.length > 0 && !reason) {
    throw new Error("another test result exists; pass --new-experiment with a reason");
  }
  return {
    experimentId,
    newExperimentReason: otherResults.length > 0 ? (reason ?? null) : null,
  };
}
