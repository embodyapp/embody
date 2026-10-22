import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  M13_CASES,
  M13_LIMITS,
  M13_PROVIDER_METHODS,
  evaluateReleaseBindings,
  evaluateRollback,
  evaluateSwitch,
  m13Approval,
  m13Projection,
  runM13Suite,
} from "../../infra/mvp/m13/qualify.mjs";
import { M13_WORKER_ROLES, m13Conditions, m13Names } from "../../infra/mvp/m13/gcp.mjs";

const { URL } = globalThis;

// Mocked: exercises suite guards, evaluators and teardown only. Never provider evidence.
const root = new URL("../..", import.meta.url).pathname;
const env = {
  EMBODY_MVP_CLOUD_PROJECT: "embody-test-project",
  EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "embody-test-m13",
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
  const directory = await mkdtemp(join(tmpdir(), "embody-m13-gate-"));
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
function fakeProvider(overrides = {}) {
  const calls = [];
  const provider = {};
  for (const method of M13_PROVIDER_METHODS)
    provider[method] = (...args) => {
      calls.push(method);
      if (overrides[method]) return overrides[method](...args);
      if (method === "projectIam") return "[]";
      if (method === "inventory") return [];
      if (method === "tearDown") return { pass: true, removed: [] };
      if (method === "buildMinutes") return 0;
      return undefined;
    };
  return { provider, calls };
}

test("M13 cloud gate refuses budgets above $6, a missing SQL proxy and combined suites before any cloud call", async () => {
  const over = await gate({ EMBODY_MVP_CLOUD_SUITES: "m13", EMBODY_MVP_CLOUD_BUDGET_USD: "7" });
  assert.equal(over.result.status, 1);
  assert.match(over.result.stderr, /at most \$6/);
  assert.equal(over.report.status, "failed");
  const noProxy = await gate({ EMBODY_MVP_CLOUD_SUITES: "m13", EMBODY_CLOUD_SQL_PROXY: "" });
  assert.equal(noProxy.result.status, 1);
  assert.match(noProxy.result.stderr, /EMBODY_CLOUD_SQL_PROXY/);
  const combined = await gate({ EMBODY_MVP_CLOUD_SUITES: "m12,m13" });
  assert.equal(combined.result.status, 1);
  assert.match(combined.result.stderr, /one cloud suite per invocation; no resources created/);
  assert.throws(
    () => m13Approval({ ...env, EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "prod" }),
    /embody-test/,
  );
  assert.throws(() => m13Approval({ ...env, EMBODY_MVP_CLOUD_BUDGET_APPROVED: "yes" }), /approved/);
  assert.deepEqual(m13Approval(env), {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: "embody-test-m13",
    budgetUsd: 6,
    proxy: env.EMBODY_CLOUD_SQL_PROXY,
  });
  // Seven builds at their full 600 s timeout, SQL for four hours, $0.60 fixed.
  assert.equal(m13Projection(), 1.11);
  assert.ok(m13Projection() <= M13_LIMITS.maxBudgetUsd);
});

test("release grants must be exact: every resource-touching worker role is prefix-conditioned (review B3)", () => {
  const groups = ["candidates", "wakeRoute", "secrets", "queues", "invokers"];
  const good = [
    "worker|project:custom/base",
    ...groups.map((g) => `worker|project:custom/${g}?prefixed`),
    "worker|project:roles/resourcemanager.projectIamAdmin?onlyGrants=roles/cloudsql.client",
    "worker|project:roles/iam.serviceAccountUser?runtimesOnly",
    "worker|project:roles/cloudsql.client",
    "runtime|project:roles/cloudsql.client",
    "runtime|secret:roles/secretmanager.secretAccessor",
    "candidate|run.invoker:gateway",
    "candidate|run.invoker:worker",
    "candidate|run.invoker:wake-invoker",
    "gateway|project:roles/cloudsql.client",
  ];
  assert.equal(evaluateReleaseBindings(good).pass, true);
  for (const bad of [
    // The a561eaf posture: one unconditioned custom role.
    [...good.filter((b) => !b.includes("?prefixed")), "worker|project:custom/secrets"],
    [...good, "worker|project:custom/secrets"],
    good.filter((b) => b !== "worker|project:custom/invokers?prefixed"),
    good.map((b) => b.replace("?onlyGrants=roles/cloudsql.client", "")),
    [...good, "runtime|project:roles/storage.admin"],
    [...good, "candidate|roles/run.invoker:other"],
    [...good, "gateway|project:custom/base"],
    [...good, "worker|project:roles/editor"],
    good.filter((b) => !b.startsWith("candidate|")),
  ])
    assert.equal(evaluateReleaseBindings(bad).pass, false, JSON.stringify(bad));
  // Unconditioned permissions are read, list and create only; nothing touches an existing
  // resource's data or IAM, and no role can read a secret payload.
  for (const permission of M13_WORKER_ROLES.base)
    assert.match(permission, /\.(list|get|create)$|operations\.get$/);
  assert.ok(!Object.values(M13_WORKER_ROLES).flat().includes("secretmanager.versions.access"));
  assert.ok(!Object.values(M13_WORKER_ROLES).flat().includes("iam.serviceAccounts.actAs"));
  // Every conditioned group is bound to this run's platform prefix (or the exact worker service).
  const n = m13Names("embody-test-project", "embody-test-m13", "a1b2c3");
  const conditions = m13Conditions(
    "embody-test-project",
    "123456789012",
    n,
    "embody-test-m13-worker-a1b2c3",
  );
  for (const group of groups)
    assert.ok(
      conditions[group].includes(n.platformPrefix) || conditions[group].includes("worker-a1b2c3"),
      group,
    );
  assert.match(conditions.secrets, /projects\/123456789012\/secrets\/ta1b2c3-a/);
  assert.match(
    conditions.candidates,
    /projects\/123456789012\/locations\/us-central1\/services\/ta1b2c3-c/,
  );
  assert.match(
    conditions.wakeRoute,
    /== "projects\/embody-test-project\/locations\/us-central1\/services\/embody-test-m13-worker-a1b2c3"/,
  );
});

test("switch and rollback evaluators fail closed", () => {
  const before = { generation: 2, pong: false, endpoint: "https://a" };
  const after = { generation: 3, pong: true, endpoint: "https://b" };
  const ok = [
    { ...before, call: 200 },
    { ...before, call: 200 },
    { ...after, call: 200 },
  ];
  assert.equal(evaluateSwitch(ok, before, after).pass, true);
  // A mixed pair (new manifest, old generation or route) fails.
  assert.equal(
    evaluateSwitch([...ok, { ...before, pong: true, call: 200 }], before, after).pass,
    false,
  );
  assert.equal(
    evaluateSwitch([...ok, { ...after, endpoint: "https://a", call: 200 }], before, after).pass,
    false,
  );
  assert.equal(
    evaluateSwitch(
      [
        { ...after, call: 200 },
        { ...before, call: 200 },
        { ...after, call: 200 },
      ],
      before,
      after,
    ).pass,
    false,
  );
  assert.equal(
    evaluateSwitch([...ok.slice(0, 2), { ...after, call: 503 }], before, after).pass,
    false,
  );
  assert.equal(evaluateSwitch(ok.slice(0, 2), before, after).pass, false);
  const facts = {
    state: "active",
    releaseId: "rel_new00000001",
    targetReleaseId: "rel_old00000001",
    rollbackOf: "rel_old00000001",
    pong: false,
    endpoint: "https://c",
    targetEndpoint: "https://a",
    checksumBefore: "x",
    checksumAfter: "x",
    call: 200,
    toActive: 409,
    toActiveCode: "ROLLBACK_INCOMPATIBLE",
  };
  assert.equal(evaluateRollback(facts).pass, true);
  for (const change of [
    { checksumAfter: "y" },
    { pong: true },
    { endpoint: "https://a" },
    { toActive: 202 },
    { releaseId: "rel_old00000001" },
    { state: "failed" },
  ])
    assert.equal(evaluateRollback({ ...facts, ...change }).pass, false, JSON.stringify(change));
});

test("run-scoped names stay inside the approved prefix and provider limits", () => {
  const n = m13Names("embody-test-project", "embody-test-m13", "a1b2c3");
  for (const account of [n.gatewayAccount]) {
    assert.ok(account.id.startsWith("embody-test-m13-"));
    assert.ok(account.id.length <= 30);
  }
  for (const name of [n.gatewayService, n.gatewayKey, n.provisionerSecret])
    assert.ok(name.startsWith("embody-test-m13-"));
  assert.match(n.platformPrefix, /^[a-z][a-z0-9]{1,7}$/);
  assert.match(n.role, /^[a-zA-Z0-9_.]{3,64}$/);
});

test("M13 suite refuses a projection above the budget, or a partial provider, before touching it", async () => {
  const { provider, calls } = fakeProvider();
  await assert.rejects(
    runM13Suite({ ...env, EMBODY_MVP_CLOUD_BUDGET_USD: "0.5" }, provider, {}),
    /projection exceeds/,
  );
  assert.deepEqual(calls, []);
  const { provider: partial } = fakeProvider();
  delete partial.deployGateway;
  await assert.rejects(runM13Suite(env, partial, {}), /lacks deployGateway/);
});

test("M13 suite tears down and fails every case when setup, the gateway or the database fails", async () => {
  for (const failing of [
    "setUp",
    "pushWorker",
    "prepareDatabase",
    "deployGateway",
    "deployM13Worker",
  ]) {
    const { provider, calls } = fakeProvider({
      [failing]: () => Promise.reject(new Error("boom")),
      pushRecipe: () => ({ builderImage: "b", runtimeImage: "r" }),
      setUp:
        failing === "setUp" ? () => Promise.reject(new Error("boom")) : () => ({ builder: {} }),
      prepareDatabase:
        failing === "prepareDatabase"
          ? () => Promise.reject(new Error("boom"))
          : () => ({ runtimeUrl: "postgresql://x@127.0.0.1:1/db" }),
    });
    const result = await runM13Suite(env, provider, {
      stageRecipe: async () => [],
      startFrameworkRegistry: async () => ({ url: "http://127.0.0.1:1/", close: async () => {} }),
      signingKey: async () => ({ kid: "k", privateKeyPem: "", publicJwks: { keys: [] } }),
    });
    assert.equal(result.pass, false, failing);
    assert.equal(result.cases.setUp.pass, false, failing);
    assert.ok(calls.includes("tearDown"), failing);
    assert.equal(result.cases.cleanup.pass, true, failing);
    // Every case of the fixed set is recorded; unrun cases are failures, never silent passes.
    assert.deepEqual(Object.keys(result.cases).sort(), [...M13_CASES].sort());
    for (const name of M13_CASES.filter((c) => c !== "cleanup"))
      assert.equal(result.cases[name].pass, false, `${failing}:${name}`);
  }
});

test("M13 suite reports leftovers and project IAM drift as cleanup failures", async () => {
  let iam = 0;
  const { provider } = fakeProvider({
    setUp: () => Promise.reject(new Error("boom")),
    inventory: () => ["service:tabc123-c0001"],
    projectIam: () => (iam++ < 2 ? "[]" : '["roles/cloudsql.client|serviceAccount:tabc123-a1|"]'),
  });
  const result = await runM13Suite(env, provider, {});
  assert.equal(result.cases.cleanup.pass, false);
  assert.equal(result.cases.cleanup.projectIamUnchanged, false);
  assert.deepEqual(result.cases.cleanup.leftovers, ["service:tabc123-c0001"]);
});
