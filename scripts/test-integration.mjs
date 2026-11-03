import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const localApiUrl = "http://127.0.0.1:55321";

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

const statusResult = run("supabase", ["status", "-o", "json"]);
assert.equal(
  statusResult.status,
  0,
  "Local Supabase must be running; start it with `supabase start`.",
);

let localStatus;
try {
  localStatus = JSON.parse(statusResult.stdout);
} catch {
  throw new Error(
    "Could not read local Supabase status; refusing to run integration tests.",
  );
}

assert.equal(
  localStatus.API_URL,
  localApiUrl,
  "Integration tests only run against this repository's local Supabase API at http://127.0.0.1:55321.",
);

const databaseUrl = new URL(localStatus.DB_URL);
assert.equal(databaseUrl.hostname, "127.0.0.1", "Database must be local.");
assert.equal(
  databaseUrl.port,
  "55322",
  "Database must use this project's local port.",
);
assert.ok(localStatus.ANON_KEY, "Local Supabase anon key is unavailable.");
assert.ok(
  localStatus.SERVICE_ROLE_KEY,
  "Local Supabase service-role key is unavailable.",
);

if (existsSync(".env.local")) {
  const envFile = readFileSync(".env.local", "utf8");
  const appUrl = envFile.match(/^NEXT_PUBLIC_SUPABASE_URL=(.*)$/m)?.[1]?.trim();
  if (appUrl) {
    assert.equal(
      appUrl,
      localApiUrl,
      "The .env.local Supabase URL is not the local project; refusing to run integration tests.",
    );
  }
}

const reportDirectory = mkdtempSync(join(tmpdir(), "poimio-integration-"));
const reportPath = join(reportDirectory, "vitest.json");

try {
  const testResult = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "lib/db.integration.test.ts",
      "lib/rls.integration.test.ts",
      "lib/feedback.integration.test.ts",
      "lib/feed.integration.test.ts",
      "lib/guest-feed.integration.test.ts",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    {
      encoding: "utf8",
      stdio: "inherit",
      env: {
        ...process.env,
        SUPABASE_INTEGRATION: "1",
        SUPABASE_URL: localApiUrl,
        NEXT_PUBLIC_SUPABASE_URL: localApiUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: localStatus.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: localStatus.SERVICE_ROLE_KEY,
      },
    },
  );

  assert.equal(
    testResult.status,
    0,
    "One or more local integration tests failed.",
  );

  let report;
  try {
    const output = readFileSync(reportPath, "utf8");
    report = JSON.parse(output.slice(output.indexOf("{")));
  } catch {
    throw new Error(
      "Vitest did not produce a readable JSON report; cannot verify skipped tests.",
    );
  }

  assert.equal(
    report.numPendingTests,
    0,
    `Expected 0 skipped integration tests, found ${report.numPendingTests} pending tests.`,
  );
  assert.equal(
    report.numTodoTests,
    0,
    "Integration tests must not be left as todo.",
  );
  assert.ok(report.numTotalTests > 0, "No integration tests were discovered.");
  console.log(
    `Local integration tests passed: ${report.numPassedTests} passed, 0 skipped.`,
  );
} finally {
  rmSync(reportDirectory, { recursive: true, force: true });
}
