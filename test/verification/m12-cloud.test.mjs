import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  M12_LIMITS,
  M12_PROVIDER_METHODS,
  evaluateDeployment,
  evaluateIngress,
  evaluateWorkerBindings,
  m12Approval,
  m12Projection,
  runM12Suite,
} from "../../infra/mvp/m12/qualify.mjs";
import { m12Names } from "../../infra/mvp/m12/gcp.mjs";

const { URL } = globalThis;

// Mocked: exercises suite guards, evaluators and teardown only. Never provider evidence.
const root = new URL("../..", import.meta.url).pathname;
const env = {
  EMBODY_MVP_CLOUD_PROJECT: "embody-test-project",
  EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "embody-test-m12",
  EMBODY_MVP_CLOUD_BUDGET_USD: "6",
  EMBODY_MVP_CLOUD_BUDGET_APPROVED: "true",
  EMBODY_CLOUD_SQL_PROXY: "/usr/local/bin/cloud-sql-proxy",
};
function cleanEnv(directory) {
  const value = { ...process.env, EMBODY_TEST_EVIDENCE_DIR: directory };
  for (const key of Object.keys(value))
    if (key.startsWith("EMBODY_") && key !== "EMBODY_TEST_EVIDENCE_DIR") delete value[key];
  delete value.GOOGLE_APPLICATION_CREDENTIALS;
  return value;
}
async function gate(extra) {
  const directory = await mkdtemp(join(tmpdir(), "embody-m12-gate-"));
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

test("M12 cloud gate refuses budgets above $6, a missing SQL proxy and combined suites before any cloud call", async () => {
  const over = await gate({ EMBODY_MVP_CLOUD_SUITES: "m12", EMBODY_MVP_CLOUD_BUDGET_USD: "7" });
  assert.equal(over.result.status, 1);
  assert.match(over.result.stderr, /at most \$6/);
  assert.equal(over.report.status, "failed");
  const noProxy = await gate({ EMBODY_MVP_CLOUD_SUITES: "m12", EMBODY_CLOUD_SQL_PROXY: "" });
  assert.equal(noProxy.result.status, 1);
  assert.match(noProxy.result.stderr, /EMBODY_CLOUD_SQL_PROXY/);
  const combined = await gate({
    EMBODY_MVP_CLOUD_SUITES: "m11,m12",
    EMBODY_MVP_CLOUD_BUDGET_USD: "5",
  });
  assert.equal(combined.result.status, 1);
  assert.match(combined.result.stderr, /one cloud suite per invocation; no resources created/);
  assert.throws(
    () => m12Approval({ ...env, EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "prod" }),
    /embody-test/,
  );
  assert.throws(() => m12Approval({ ...env, EMBODY_MVP_CLOUD_BUDGET_APPROVED: "yes" }), /approved/);
  assert.deepEqual(m12Approval(env), {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: "embody-test-m12",
    budgetUsd: 6,
    proxy: env.EMBODY_CLOUD_SQL_PROXY,
  });
  // Six builds at their full 600 s timeout, SQL for four hours, $0.40 fixed.
  assert.equal(m12Projection(), 0.85);
  assert.ok(m12Projection() < M12_LIMITS.maxBudgetUsd);
});

test("worker identity must hold exactly the controller grants; the invoker only invokes", () => {
  const worker = [
    "builder:roles/iam.serviceAccountUser",
    "buildsRepo:roles/artifactregistry.repoAdmin",
    "invoker:roles/iam.serviceAccountUser",
    "logsBucket:roles/storage.objectAdmin",
    "outputBucket:roles/storage.objectAdmin",
    "project:roles/cloudbuild.builds.editor",
    "project:roles/cloudsql.client",
    "queue:roles/cloudtasks.enqueuer",
    "reader:roles/iam.serviceAccountTokenCreator",
    "secret:roles/secretmanager.secretAccessor",
  ].map((b) => `worker|${b}`);
  const exact = [...worker, "invoker|service:roles/run.invoker"];
  assert.equal(evaluateWorkerBindings(exact).pass, true);
  for (const extra of [
    "worker|project:roles/editor",
    "worker|sourceBucket:roles/storage.objectViewer",
    "worker|runtime:roles/iam.serviceAccountUser",
    "invoker|project:roles/run.invoker",
    "invoker|queue:roles/cloudtasks.enqueuer",
  ])
    assert.equal(evaluateWorkerBindings([...exact, extra]).pass, false, extra);
  assert.equal(evaluateWorkerBindings(exact.slice(1)).pass, false);
});

test("deployment and ingress evaluators fail closed", () => {
  const facts = {
    state: "active",
    builds: 1,
    candidates: 1,
    generationBefore: 1,
    generationAfter: 2,
    faultsFired: 3,
    releaseId: "rel_x",
    elapsedMs: 1000,
  };
  const expect = {
    state: "active",
    builds: 1,
    candidates: 1,
    generationStep: 1,
    faults: 3,
    release: true,
  };
  assert.equal(evaluateDeployment(facts, expect).pass, true);
  for (const [key, value] of [
    ["state", "failed"],
    ["builds", 2],
    ["candidates", 2],
    ["generationAfter", 3],
    ["faultsFired", 2],
    ["releaseId", undefined],
    ["elapsedMs", M12_LIMITS.deploymentWaitMs + 1],
  ])
    assert.equal(evaluateDeployment({ ...facts, [key]: value }, expect).pass, false, key);
  const ingress = {
    anonymous: 403,
    operatorToken: 401,
    wrongAudience: 401,
    otherIdentity: 403,
    maliciousBody: 400,
    foreignWorkspace: { status: 200, outcome: "missing" },
    invoker: 200,
    epochBefore: 9,
    epochAfter: 9,
  };
  assert.equal(evaluateIngress(ingress).pass, true);
  for (const [key, value] of [
    ["anonymous", 200],
    ["operatorToken", 200],
    ["wrongAudience", 503],
    ["otherIdentity", 200],
    ["maliciousBody", 200],
    ["foreignWorkspace", { status: 200, outcome: "advance:validating" }],
    ["invoker", 401],
    ["epochAfter", 10],
  ])
    assert.equal(evaluateIngress({ ...ingress, [key]: value }).pass, false, key);
});

test("run-scoped names stay inside the approved prefix and provider limits", () => {
  const n = m12Names("embody-test-project", "embody-test-m12", "a1b2c3");
  for (const account of [n.worker, n.invoker, n.builder, n.reader, n.runtime])
    assert.ok(account.id.length <= 30, account.id);
  for (const value of [n.sql, n.queue, n.service, n.secret, n.buildsRepo, n.sourceBucket])
    assert.ok(value.startsWith("embody-test-m12-"), value);
  assert.ok(n.service.length <= 49);
});

function fakeProvider(overrides = {}) {
  const calls = [];
  const provider = {};
  for (const method of M12_PROVIDER_METHODS)
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

test("M12 suite refuses a projection above the budget before touching the provider", async () => {
  const { provider, calls } = fakeProvider();
  await assert.rejects(
    runM12Suite({ ...env, EMBODY_MVP_CLOUD_BUDGET_USD: "0.5" }, provider, {}),
    /projection exceeds/,
  );
  assert.deepEqual(calls, []);
  const { provider: partial } = fakeProvider();
  delete partial.pauseQueue;
  await assert.rejects(runM12Suite(env, partial, {}), /lacks pauseQueue/);
});

test("M12 suite tears down and fails when setup, the worker push or the database fails", async () => {
  for (const failing of ["setUp", "pushWorker", "prepareDatabase"]) {
    const { provider, calls } = fakeProvider({
      [failing]: () => Promise.reject(new Error("boom")),
      pushRecipe: () => ({ builderImage: "b", runtimeImage: "r" }),
      setUp:
        failing === "setUp" ? () => Promise.reject(new Error("boom")) : () => ({ builder: {} }),
    });
    const result = await runM12Suite(env, provider, {
      stageRecipe: async () => [],
      startFrameworkRegistry: async () => ({ url: "http://127.0.0.1:1/", close: async () => {} }),
    });
    assert.equal(result.pass, false, failing);
    assert.equal(result.cases.setUp.pass, false, failing);
    assert.ok(calls.includes("tearDown"), failing);
    assert.equal(result.cases.cleanup.pass, true);
    // Unrun cases are failures, never silent passes.
    assert.equal(result.cases["M12.a.c.chain-zero-gateway"].pass, false);
    assert.equal(result.cases["M12.d.ingress"].pass, false);
  }
});

test("M12 suite reports leftovers and project IAM drift as cleanup failures", async () => {
  let iam = 0;
  const { provider } = fakeProvider({
    setUp: () => Promise.reject(new Error("boom")),
    inventory: () => ["sql:embody-test-m12-sql-a1b2c3"],
    projectIam: () => (iam++ < 2 ? "[]" : '["roles/cloudsql.client|serviceAccount:x|"]'),
  });
  const result = await runM12Suite(env, provider, {});
  assert.equal(result.cases.cleanup.pass, false);
  assert.equal(result.cases.cleanup.projectIamUnchanged, false);
  assert.deepEqual(result.cases.cleanup.leftovers, ["sql:embody-test-m12-sql-a1b2c3"]);
});
