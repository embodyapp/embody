import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  M14_LIMITS,
  M14_PROVIDER_METHODS,
  m14Approval,
  m14Projection,
  runM14Suite,
} from "../../infra/mvp/m14/qualify.mjs";
import { m14Names } from "../../infra/mvp/m14/gcp.mjs";
import { M14_CASES } from "../../infra/mvp/m14/journey.mjs";

const { URL } = globalThis;

// Mocked: exercises suite guards and teardown only. Never provider evidence.
const root = new URL("../..", import.meta.url).pathname;
const env = {
  EMBODY_MVP_CLOUD_PROJECT: "embody-test-project",
  EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "embody-test-m14",
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
  const directory = await mkdtemp(join(tmpdir(), "embody-m14-gate-"));
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
  for (const method of M14_PROVIDER_METHODS)
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

test("M14 cloud gate refuses budgets above $6, a missing SQL proxy and combined suites before any cloud call", async () => {
  const over = await gate({ EMBODY_MVP_CLOUD_SUITES: "m14", EMBODY_MVP_CLOUD_BUDGET_USD: "7" });
  assert.equal(over.result.status, 1);
  assert.match(over.result.stderr, /at most \$6/);
  assert.equal(over.report.status, "failed");
  const noProxy = await gate({ EMBODY_MVP_CLOUD_SUITES: "m14", EMBODY_CLOUD_SQL_PROXY: "" });
  assert.equal(noProxy.result.status, 1);
  assert.match(noProxy.result.stderr, /EMBODY_CLOUD_SQL_PROXY/);
  const combined = await gate({ EMBODY_MVP_CLOUD_SUITES: "m13,m14" });
  assert.equal(combined.result.status, 1);
  assert.match(combined.result.stderr, /one cloud suite per invocation; no resources created/);
  assert.throws(
    () => m14Approval({ ...env, EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "prod" }),
    /embody-test/,
  );
  assert.throws(() => m14Approval({ ...env, EMBODY_MVP_CLOUD_BUDGET_APPROVED: "yes" }), /approved/);
  // Six builds at their full 600 s timeout, SQL for four hours, $0.60 fixed: the approved
  // projection (≈ $1.05 per run).
  assert.equal(m14Projection(), 1.05);
  assert.ok(m14Projection() <= M14_LIMITS.maxBudgetUsd);
});

test("M14 suite refuses an incomplete provider or an over-budget projection before any provider call", async () => {
  const { provider, calls } = fakeProvider();
  delete provider.storedObjects;
  await assert.rejects(runM14Suite(env, provider, { cases: M14_CASES }), /lacks storedObjects/);
  assert.deepEqual(calls, []);
  const cheap = fakeProvider();
  await assert.rejects(
    runM14Suite({ ...env, EMBODY_MVP_CLOUD_BUDGET_USD: "1" }, cheap.provider, {
      cases: M14_CASES,
    }),
    /projection exceeds the approved budget/,
  );
  assert.deepEqual(cheap.calls, []);
});

test("M14 suite tears down after a failed setup and reports every case", async () => {
  const { provider, calls } = fakeProvider({
    setUp: () => {
      throw new Error("Provider POST iam.googleapis.com failed (403); body suppressed");
    },
  });
  const result = await runM14Suite(env, provider, { cases: M14_CASES });
  assert.equal(result.pass, false);
  assert.ok(calls.includes("tearDown"));
  assert.ok(calls.includes("inventory"));
  assert.equal(result.cases.setUp.pass, false);
  assert.match(result.cases.setUp.error, /body suppressed/);
  assert.equal(result.cases.cleanup.pass, true);
  for (const name of M14_CASES) assert.equal(result.cases[name].pass, false, name);
});

test("M14 resource names stay inside provider limits and the run prefix", () => {
  const n = m14Names("embody-test-project", "embody-test-m14", "a1b2c3");
  assert.ok(n.uploader.id.length <= 30);
  assert.ok(n.uploader.id.startsWith("embody-test-m14-"));
  assert.ok(n.uploader.email.endsWith("@embody-test-project.iam.gserviceaccount.com"));
});
