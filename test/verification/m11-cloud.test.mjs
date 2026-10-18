import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  M11_PROVIDER_METHODS,
  evaluateBuilderBindings,
  m11Approval,
  m11Projection,
  runM11Suite,
} from "../../infra/mvp/m11/qualify.mjs";
import {
  evaluateProbe,
  evaluateRedaction,
  probeReport,
  CANARIES,
} from "../../infra/mvp/m11/suite.mjs";
import { m11Names } from "../../infra/mvp/m11/gcp.mjs";

const { URL } = globalThis;

// Mocked: exercises suite guards, evaluators and teardown only. Never provider evidence.
const root = new URL("../..", import.meta.url).pathname;
const env = {
  EMBODY_MVP_CLOUD_PROJECT: "embody-test-project",
  EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "embody-test-m11",
  EMBODY_MVP_CLOUD_BUDGET_USD: "5",
  EMBODY_MVP_CLOUD_BUDGET_APPROVED: "true",
};
function cleanEnv(directory) {
  const value = { ...process.env, EMBODY_TEST_EVIDENCE_DIR: directory };
  for (const key of Object.keys(value))
    if (key.startsWith("EMBODY_") && key !== "EMBODY_TEST_EVIDENCE_DIR") delete value[key];
  delete value.GOOGLE_APPLICATION_CREDENTIALS;
  return value;
}
async function gate(extra) {
  const directory = await mkdtemp(join(tmpdir(), "embody-m11-gate-"));
  const credential = join(directory, "credential.json");
  await writeFile(credential, "{}");
  try {
    const result = spawnSync(process.execPath, ["scripts/test-mvp-cloud.mjs"], {
      cwd: root,
      env: { ...cleanEnv(directory), ...env, GOOGLE_APPLICATION_CREDENTIALS: credential, ...extra },
      encoding: "utf8",
    });
    const report = JSON.parse(await readFile(join(directory, "mvp-cloud.json"), "utf8"));
    return { result, report };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("M11 cloud gate refuses budgets above $5 and combined suites before any cloud call", async () => {
  const { result, report } = await gate({
    EMBODY_MVP_CLOUD_SUITES: "m11",
    EMBODY_MVP_CLOUD_BUDGET_USD: "6",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most \$5/);
  assert.equal(report.status, "failed");
  const combined = await gate({
    EMBODY_MVP_CLOUD_SUITES: "m10,m11",
    EMBODY_MVP_CLOUD_BUDGET_USD: "2",
  });
  assert.equal(combined.result.status, 1);
  assert.match(combined.result.stderr, /one cloud suite per invocation; no resources created/);
  assert.throws(
    () => m11Approval({ ...env, EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "prod" }),
    /embody-test/,
  );
  assert.throws(() => m11Approval({ ...env, EMBODY_MVP_CLOUD_BUDGET_APPROVED: "yes" }), /approved/);
  assert.deepEqual(m11Approval(env), {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: "embody-test-m11",
    budgetUsd: 5,
  });
  // Every build charged at its full 600 s timeout.
  assert.equal(m11Projection(16), 1.21);
});

test("builder IAM must be exactly push, recipe read and output create", () => {
  const exact = [
    "buildsRepo:roles/artifactregistry.writer",
    "logsBucket:roles/storage.legacyBucketReader",
    "logsBucket:roles/storage.objectUser",
    "outputBucket:roles/storage.objectCreator",
    "recipeRepo:roles/artifactregistry.reader",
  ];
  assert.equal(evaluateBuilderBindings(exact).pass, true);
  for (const extra of [
    "project:roles/editor",
    "project:roles/logging.logWriter",
    "sourceBucket:roles/storage.objectViewer",
    "builderSelf:roles/iam.serviceAccountTokenCreator",
    "runtimeSa:roles/iam.serviceAccountUser",
    "outputBucket:roles/storage.objectAdmin",
  ])
    assert.equal(evaluateBuilderBindings([...exact, extra]).pass, false, extra);
  assert.equal(evaluateBuilderBindings(exact.slice(1)).pass, false);
});

test("sandbox probe and redaction evaluators fail closed", () => {
  const report = {
    uid: 1000,
    metadataIp: "blocked",
    metadataHost: "blocked",
    publicRegistry: "blocked",
    storageApi: "blocked",
    cloudRunApi: "blocked",
    otherSource: "blocked",
    dockerSocket: false,
    workspaceVisible: false,
    builderOutputsVisible: false,
    platformEnv: [],
    canWriteRecipe: false,
    processesStarted: 480,
  };
  assert.equal(evaluateProbe(report, 512).pass, true);
  for (const [key, value] of [
    ["metadataIp", "status-200"],
    ["otherSource", "status-200"],
    ["publicRegistry", "status-200"],
    ["dockerSocket", true],
    ["uid", 0],
    ["platformEnv", ["EMBODY_SOURCE_URL"]],
    ["processesStarted", 700],
    ["canWriteRecipe", true],
  ])
    assert.equal(evaluateProbe({ ...report, [key]: value }, 512).pass, false, key);
  assert.equal(evaluateProbe(null, 512).pass, false);
  assert.deepEqual(
    probeReport(`Step #1 - "sandbox": EMBODY_PROBE ${JSON.stringify(report)}\n`),
    report,
  );
  assert.equal(probeReport("no report"), null);
  const raw = CANARIES.join("\n");
  assert.equal(evaluateRedaction(raw, "[REDACTED]").pass, true);
  assert.equal(evaluateRedaction(raw, `[REDACTED] ${CANARIES[1]}`).pass, false);
  assert.equal(evaluateRedaction("nothing injected", "[REDACTED]").pass, false);
});

test("run-scoped names stay inside the approved prefix and provider limits", () => {
  const n = m11Names("embody-test-project", "embody-test-m11", "a1b2c3");
  for (const account of [n.builder, n.reader, n.runtime])
    assert.ok(account.id.length <= 30, account.id);
  for (const value of [n.recipeRepo, n.buildsRepo, n.sourceBucket, n.outputBucket, n.job])
    assert.ok(value.startsWith("embody-test-m11-"), value);
});

function fakeProvider(overrides = {}) {
  const calls = [];
  const provider = {};
  for (const method of M11_PROVIDER_METHODS)
    provider[method] = async (...args) => {
      calls.push(method);
      if (overrides[method]) return overrides[method](...args);
      if (method === "projectIam") return "[]";
      if (method === "inventory") return [];
      if (method === "tearDown") return { pass: true, removed: [] };
      if (method === "preflight") return { disabledServices: [] };
      if (method === "buildMinutes") return 0;
      return {};
    };
  provider.wait = async () => calls.push("wait");
  return { provider, calls };
}

test("M11 suite refuses a projection above the budget before touching the provider", async () => {
  const { provider, calls } = fakeProvider();
  await assert.rejects(
    runM11Suite({ ...env, EMBODY_MVP_CLOUD_BUDGET_USD: "0.5" }, provider, {}),
    /projection exceeds/,
  );
  assert.deepEqual(calls, []);
});

test("M11 suite tears down and fails when setup or the recipe push fails", async () => {
  for (const failing of ["setUp", "pushRecipe"]) {
    const { provider, calls } = fakeProvider({
      setUp: failing === "setUp" ? () => Promise.reject(new Error("boom")) : () => ({}),
      pushRecipe: () => Promise.reject(new Error("push failed")),
    });
    const result = await runM11Suite(env, provider, {
      stageRecipe: async () => [],
      startFrameworkRegistry: async () => ({ url: "http://127.0.0.1:1/", close: async () => {} }),
    });
    assert.equal(result.pass, false);
    assert.equal(result.cases.setUp.pass, false);
    assert.ok(calls.includes("tearDown"), failing);
    assert.equal(result.cases.cleanup.pass, true);
  }
});

test("M11 suite reports leftovers and project IAM drift as cleanup failures", async () => {
  let iam = 0;
  const { provider } = fakeProvider({
    setUp: () => Promise.reject(new Error("boom")),
    inventory: () => ["bucket:embody-test-m11-src-a1b2c3"],
    projectIam: () => (iam++ < 2 ? "[]" : '["roles/editor|user:x|"]'),
  });
  const result = await runM11Suite(env, provider, {});
  assert.equal(result.cases.cleanup.pass, false);
  assert.equal(result.cases.cleanup.projectIamUnchanged, false);
  assert.deepEqual(result.cases.cleanup.leftovers, ["bucket:embody-test-m11-src-a1b2c3"]);
});
