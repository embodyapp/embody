import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import {
  countsFromVitest,
  evidence,
  postgresConfiguration,
  redact,
  requireVariables,
  root,
  runVitest,
} from "../../scripts/verification.mjs";

const fixture = {
  EMBODY_POSTGRES_URL: "postgresql://runtime:runtime-fixture-password@localhost:5432/app_a",
  EMBODY_POSTGRES_MIGRATION_URL:
    "postgresql://maintenance:maintenance-fixture-password@localhost:5432/app_a",
  EMBODY_POSTGRES_OTHER_URL: "postgresql://other:other-fixture-password@localhost:5432/app_b",
};
function cleanEnv(directory) {
  const env = { ...process.env, EMBODY_TEST_EVIDENCE_DIR: directory };
  for (const key of Object.keys(env))
    if (
      key.startsWith("EMBODY_POSTGRES") ||
      key.startsWith("EMBODY_MVP_CLOUD") ||
      key === "GOOGLE_APPLICATION_CREDENTIALS"
    )
      delete env[key];
  return env;
}
for (const script of ["test-postgres.mjs", "postgres-prerequisites.mjs", "test-mvp.mjs"]) {
  test(`M03.a ${script} fails when DB configuration is intentionally omitted`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "embody-gate-negative-"));
    try {
      const result = spawnSync(process.execPath, [`scripts/${script}`], {
        cwd: root,
        env: cleanEnv(directory),
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Missing required configuration: EMBODY_POSTGRES_URL/);
      assert.doesNotMatch(result.stdout, /vitest|Build succeeded|passed/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
test("rejects whitespace config and invalid URLs without exposing values", () => {
  assert.throws(() => requireVariables(["REQUIRED"], { REQUIRED: " " }), /REQUIRED/);
  assert.throws(
    () => postgresConfiguration({ ...fixture, EMBODY_POSTGRES_URL: "secret-invalid-value" }),
    /value redacted/,
  );
});
test("rejects same-role migrations and same-database isolation fixtures", () => {
  assert.throws(
    () =>
      postgresConfiguration({
        ...fixture,
        EMBODY_POSTGRES_MIGRATION_URL: fixture.EMBODY_POSTGRES_URL,
      }),
    /roles must differ/,
  );
  assert.throws(
    () =>
      postgresConfiguration({ ...fixture, EMBODY_POSTGRES_OTHER_URL: fixture.EMBODY_POSTGRES_URL }),
    /must be distinct/,
  );
  assert.equal(postgresConfiguration(fixture).runtime.pathname, "/app_a");
});
test("redacts connection strings and decoded passwords from child output", () => {
  const message = `${fixture.EMBODY_POSTGRES_URL} runtime-fixture-password token-value`;
  assert.equal(
    redact(message, { ...fixture, API_TOKEN: "token-value" }),
    "[REDACTED] [REDACTED] [REDACTED]",
  );
});
test("redacts normalized, padded, encoded and decoded PostgreSQL credentials", () => {
  const padded = "  postgresql://runtime:p%40ss@localhost:5432/app_a  ";
  const env = { EMBODY_POSTGRES_URL: padded };
  for (const value of [padded, padded.trim(), new URL(padded).href, "p%40ss", "p@ss"]) {
    assert.doesNotMatch(redact(value, env), /p%40ss|p@ss|postgresql:/);
  }
  assert.throws(
    () =>
      postgresConfiguration({
        ...fixture,
        EMBODY_POSTGRES_MIGRATION_URL: "postgresql://%72untime:other@localhost:5432/app_a",
      }),
    /roles must differ/,
  );
});
test("zero-skip evidence uses individual assertion counts, not green suite summaries", () => {
  const report = {
    success: true,
    testResults: [{ assertionResults: [{ status: "passed" }, { status: "passed" }] }],
  };
  assert.deepEqual(countsFromVitest(report), { passed: 2, failed: 0, skipped: 0 });
  for (const status of ["pending", "skipped", "todo", "failed"]) {
    assert.throws(
      () =>
        countsFromVitest({
          success: true,
          testResults: [{ assertionResults: [{ status: "passed" }, { status }] }],
        }),
      /without skips/,
    );
  }
  assert.throws(() => countsFromVitest({ success: true, testResults: [] }), /without skips/);
  assert.throws(() => countsFromVitest({ ...report, success: false }), /without skips/);
});
test("a nonzero test command cannot pass even when its JSON report says success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embody-false-green-"));
  const reportFile = join(directory, "tests.json");
  try {
    await writeFile(
      reportFile,
      JSON.stringify({
        success: true,
        testResults: [{ assertionResults: [{ status: "passed" }] }],
      }),
    );
    await assert.rejects(
      runVitest(process.execPath, ["--eval", "process.exit(1)"], reportFile),
      (error) => {
        assert.deepEqual(error.counts, { passed: 1, failed: 0, skipped: 0 });
        return /Verification command failed/.test(error.message);
      },
    );
    await writeFile(
      reportFile,
      JSON.stringify({
        success: false,
        testResults: [{ assertionResults: [{ status: "failed" }, { status: "skipped" }] }],
      }),
    );
    await assert.rejects(
      runVitest(process.execPath, ["--eval", "process.exit(1)"], reportFile),
      (error) => {
        assert.deepEqual(error.counts, { passed: 0, failed: 1, skipped: 1 });
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("cloud gate fails without explicit project, credentials and approved budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embody-cloud-negative-"));
  try {
    const result = spawnSync(process.execPath, ["scripts/test-mvp-cloud.mjs"], {
      cwd: root,
      env: cleanEnv(directory),
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing required configuration: EMBODY_MVP_CLOUD_PROJECT/);
    const report = JSON.parse(await readFile(join(directory, "mvp-cloud.json"), "utf8"));
    assert.equal(report.status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("cloud gate rejects unapproved budget and never returns a placeholder success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embody-cloud-budget-"));
  const credential = join(directory, "fixture.json");
  await writeFile(credential, "{}");
  try {
    const env = {
      ...cleanEnv(directory),
      EMBODY_MVP_CLOUD_PROJECT: "embody-test-project",
      EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "embody-test-m03",
      EMBODY_MVP_CLOUD_BUDGET_USD: "10",
      EMBODY_MVP_CLOUD_BUDGET_APPROVED: "false",
      GOOGLE_APPLICATION_CREDENTIALS: credential,
    };
    const run = () =>
      spawnSync(process.execPath, ["scripts/test-mvp-cloud.mjs"], {
        cwd: root,
        env,
        encoding: "utf8",
      });
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /approved positive budget/);
    env.EMBODY_MVP_CLOUD_BUDGET_APPROVED = "true";
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not implemented yet.*no resources created/);
    assert.doesNotMatch(result.stderr, /fixture.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("evidence contains revision hashes and counts but no credentials or test payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embody-evidence-"));
  const prior = process.env.EMBODY_TEST_EVIDENCE_DIR;
  process.env.EMBODY_TEST_EVIDENCE_DIR = directory;
  try {
    await evidence("fixture", "passed", { passed: 1, failed: 0, skipped: 0 });
    const text = await readFile(join(directory, "fixture.json"), "utf8");
    const report = JSON.parse(text);
    assert.match(report.commit, /^[a-f0-9]{40}$/u);
    assert.match(report.lockfileSha256, /^[a-f0-9]{64}$/u);
    assert.match(report.schemaSourceSha256, /^[a-f0-9]{64}$/u);
    assert.equal(report.counts.skipped, 0);
    assert.doesNotMatch(text, /postgresql:|PASSWORD|TOKEN|runtime-fixture-password/);
  } finally {
    if (prior === undefined) delete process.env.EMBODY_TEST_EVIDENCE_DIR;
    else process.env.EMBODY_TEST_EVIDENCE_DIR = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
