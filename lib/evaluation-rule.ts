import { posix } from "node:path";

export function normalizeEvaluationRulePath(value: string | undefined): string {
  const path = value ?? "evaluation/tuning-rule.json";
  if (path.startsWith("/") || path.split(/[\\/]/u).includes("..") || !path.endsWith(".json")) {
    throw new Error("--rule must name a JSON file inside the repository");
  }
  return posix.normalize(path.replaceAll("\\", "/"));
}

export function assertEvaluationRuleHash(
  actual: string | null,
  expected: string,
  rulePath: string,
): void {
  if (actual !== expected) {
    throw new Error(`Result was not produced with ${rulePath}`);
  }
}
