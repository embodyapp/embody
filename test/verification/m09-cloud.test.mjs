// M09 mocked fail-closed tests. Fakes only: none of this is provider evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const { Response } = globalThis;
import { root, databaseServiceIdentity } from "../../scripts/verification.mjs";
import {
  M09_LIMITS,
  SUITE_PROVIDER_METHODS,
  safeError,
  m09Approval,
  runM09Suite,
  evaluateScaling,
  zeroIntervals,
  evaluateDelayedWake,
  evaluateRetries,
  evaluateOidc,
  evaluateQueueProbe,
  evaluateIsolation,
  evaluateBuilder,
  evaluateCleanup,
} from "../../infra/mvp/m09/qualify.mjs";
import { monthlyWorksheet, qualificationEstimate } from "../../infra/mvp/m09/costs.mjs";
import { IDENTITY_CASES } from "../../infra/mvp/m09/queue-probe.mjs";
import {
  bootstrapStatements,
  evaluateStorm,
  evaluateConnectDenials,
  evaluateRestore,
  latencySummary,
  fixturePasswords,
} from "../../infra/mvp/m09/sql.mjs";

const env = {
  EMBODY_MVP_CLOUD_PROJECT: "embody-test-project",
  EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "embody-test-m09",
  EMBODY_MVP_CLOUD_BUDGET_USD: "25",
  EMBODY_MVP_CLOUD_BUDGET_APPROVED: "true",
  EMBODY_M09_RUN_ID: "a1b2c3d4",
};
function cleanEnv(directory) {
  const value = { ...process.env, EMBODY_TEST_EVIDENCE_DIR: directory };
  for (const key of Object.keys(value))
    if (
      key.startsWith("EMBODY_MVP_CLOUD") ||
      key.startsWith("EMBODY_M09") ||
      key === "EMBODY_CLOUD_SQL_PROXY" ||
      key === "GOOGLE_APPLICATION_CREDENTIALS"
    )
      delete value[key];
  return value;
}
async function gate(extra) {
  const directory = await mkdtemp(join(tmpdir(), "embody-m09-gate-"));
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

test("cloud gate refuses an M09 budget above the one-off $25 before any cloud call", async () => {
  const { result, report } = await gate({ EMBODY_MVP_CLOUD_BUDGET_USD: "30" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most \$25/);
  assert.equal(report.status, "failed");
});
test("cloud gate refuses unimplemented later suites and creates nothing", async () => {
  const { result } = await gate({ EMBODY_MVP_CLOUD_SUITES: "m09,m17" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not implemented yet \(m17\); no resources created/);
});
test("cloud gate requires the M09 baseline, image and proxy before loading provider code", async () => {
  const { result } = await gate({});
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Missing required configuration: EMBODY_M09_BASELINE, EMBODY_M09_IMAGE, EMBODY_CLOUD_SQL_PROXY/,
  );
  assert.doesNotMatch(result.stderr, /credential\.json/);
});
test("approval rejects prefixes the 15-character adapter names cannot hold", () => {
  assert.throws(
    () => m09Approval({ ...env, EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "embody-test-m09-long" }),
    /approved positive budget/,
  );
  assert.deepEqual(m09Approval(env), {
    project: "embody-test-project",
    prefix: "embody-test-m09",
    budgetUsd: 25,
  });
});

// ---- Suite orchestration with a fake provider ----------------------------------------------
const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const iso = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const claims = {
  issuer: "https://accounts.google.com",
  audienceMatches: true,
  hasEmail: true,
  emailMatches: true,
  emailVerified: true,
  lifetimeSeconds: 3600,
};
const due = M09_LIMITS.delaySeconds;
function goodWakes() {
  const wakes = [
    { probe: "own-now", receivedAt: iso(5), status: 200, verified: true, claims, retryCount: 0 },
  ];
  let at = 10;
  for (let retry = 0; retry <= M09_LIMITS.fail503; retry++) {
    wakes.push({
      probe: "own-retry",
      receivedAt: iso(at),
      status: retry < M09_LIMITS.fail503 ? 503 : 200,
      verified: true,
      claims,
      retryCount: retry,
    });
    at += 2 ** retry;
  }
  wakes.push(
    {
      probe: "pause-check",
      receivedAt: iso(900),
      status: 200,
      verified: true,
      claims,
      retryCount: 0,
    },
    {
      probe: "own-delayed",
      receivedAt: iso(due + 4),
      status: 200,
      verified: true,
      claims,
      retryCount: 0,
    },
  );
  return wakes;
}
function fakeProvider(overrides = {}) {
  let clock = T0;
  const calls = [];
  // The pause-check wake is delivered only once the queue is resumed.
  const wakes = () =>
    goodWakes().filter((wake) => wake.probe !== "pause-check" || calls.includes("resume"));
  const points = [];
  for (let minute = 0; minute < 120; minute++)
    points.push({
      start: iso(minute * 60),
      end: iso(minute * 60 + 60),
      value: minute >= 20 && minute < due / 60 ? 0 : 1,
    });
  const provider = {
    calls,
    now: () => new Date(clock),
    wait: async (ms) => {
      clock += ms;
    },
    projectedCostUsd: async () => 4,
    preflight: async () => ({ checks: { sqlRunnable: true }, pass: true }),
    setUp: async ({ runId }) => {
      calls.push("setUp");
      return { runId, settledAt: iso(1), probe: {} };
    },
    runQueueProbe: async () => ({
      pass: true,
      subject: "embody-test-m09-r-x@p.iam.gserviceaccount.com",
      results: [
        "own-now",
        "own-duplicate",
        "own-delayed",
        "own-retry",
        "own-horizon-inside",
        "own-horizon-outside",
        "other-queue",
        "other-invoker",
        "cross-app-target",
        "adapter-created",
        "adapter-duplicate",
        ...IDENTITY_CASES,
      ].map((id) => ({
        case: id,
        status: 200,
        expected: 200,
        pass: true,
        task: `m09-${id}`,
        scheduleAt: id === "own-delayed" ? iso(due) : null,
      })),
    }),
    wakes: async (fixture, which) => (which === "own" ? wakes() : []),
    starts: async (fixture, which) => (which === "own" ? [iso(0), iso(due + 1)] : []),
    requests: async (fixture, which) => (which === "other" ? [{ at: iso(30), status: 403 }] : []),
    instanceSeries: async () => points,
    serviceConfig: async () => ({
      service: { ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" },
      revision: {
        scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
        maxInstanceRequestConcurrency: 4,
        containers: [{ resources: { cpuIdle: true } }],
      },
    }),
    recreateTask: async () => 409,
    pause: async () => calls.push("pause"),
    resume: async () => calls.push("resume"),
    enqueueOperatorTask: async () => undefined,
    externalCalls: async () => ({ anonymous: 404, operator: 404, reachedTarget: 0, pass: true }),
    iamInventory: async () => ({
      builder: "b@p.iam.gserviceaccount.com",
      repository: "repo",
      policies: [
        {
          resource: "repo",
          policy: {
            bindings: [
              {
                role: "roles/artifactregistry.writer",
                members: ["serviceAccount:b@p.iam.gserviceaccount.com"],
              },
            ],
          },
        },
      ],
    }),
    sql: async () => ({ storage: { pass: true }, storm: { pass: true }, restore: { pass: true } }),
    tearDown: async (fixture) => calls.push(`tearDown:${fixture.runId}`),
    inventory: async () => ({ services: [], queues: [] }),
    measuredUsage: async () => ({
      sqlHours: 6,
      serviceActiveSeconds: 7200,
      jobSeconds: 300,
      taskOperations: 100,
    }),
    ...overrides,
  };
  return provider;
}

test("suite passes only when every case passes, and always tears down", async () => {
  const provider = fakeProvider();
  const result = await runM09Suite(env, provider);
  assert.equal(result.error, null);
  for (const [id, value] of Object.entries(result.cases)) assert.equal(value.pass, true, id);
  assert.equal(result.pass, true);
  assert.ok(result.cost.estimatedUpperUsd < 25);
  assert.deepEqual(provider.calls.slice(-1), ["tearDown:a1b2c3d4"]);
  for (const id of [
    "M09.a.baseline",
    "M09.a.teardown",
    "M09.b.cross-app",
    "M09.b.builder",
    "M09.c.storm",
    "M09.d.scaling",
    "M09.d.zero",
    "M09.d.emergency-stop",
    "M09.e.delayed-wake",
    "M09.e.dedup-after-execution",
    "M09.e.retry-503",
    "M09.e.oidc-claims",
    "M09.e.unauthenticated",
  ])
    assert.ok(result.cases[id], id);
});
test("projected cost above the approved budget stops before preflight or any resource", async () => {
  const provider = fakeProvider({
    projectedCostUsd: async () => 26,
    preflight: async () => assert.fail("preflight must not run"),
  });
  await assert.rejects(runM09Suite(env, provider), /exceeds the approved budget; nothing created/);
  assert.deepEqual(provider.calls, []);
});
test("a failed setUp still tears down by run ID and never passes", async () => {
  const provider = fakeProvider({
    setUp: async () => {
      throw new Error("provider said: secret-token-value");
    },
  });
  const result = await runM09Suite(env, provider);
  assert.equal(result.pass, false);
  // Only the step and the error class: the provider's message carried a secret-looking value.
  assert.equal(result.error, "suite aborted at setUp: Error");
  assert.doesNotMatch(JSON.stringify(result), /secret-token-value/);
  assert.deepEqual(provider.calls, ["tearDown:a1b2c3d4"]);
});
test("an accepted duplicate name or leftover resource fails the suite", async () => {
  let result = await runM09Suite(env, fakeProvider({ recreateTask: async () => 200 }));
  assert.equal(result.cases["M09.e.dedup-after-execution"].pass, false);
  assert.equal(result.pass, false);
  result = await runM09Suite(env, fakeProvider({ inventory: async () => ({ queues: ["q"] }) }));
  assert.deepEqual(result.cases["M09.a.teardown"].leftovers, ["queues:q"]);
  assert.equal(result.pass, false);
});
test("a wake delivered while the queue was paused fails the emergency stop", async () => {
  const provider = fakeProvider();
  const wakes = goodWakes();
  provider.wakes = async (fixture, which) => (which === "own" ? wakes : []);
  provider.enqueueOperatorTask = async () => undefined;
  const result = await runM09Suite(env, provider);
  // The fake already holds a pause-check delivery before resume, as if dispatch ignored pause.
  assert.equal(result.cases["M09.d.emergency-stop"].pass, false);
  assert.equal(result.pass, false);
});
test("missing cost measurement means no pass", async () => {
  const result = await runM09Suite(env, fakeProvider({ measuredUsage: async () => null }));
  assert.equal(result.cost, null);
  assert.equal(result.pass, false);
});

// ---- Evaluators -------------------------------------------------------------------------------
test("zero intervals need explicit zero points; gaps are not zero", () => {
  assert.deepEqual(
    zeroIntervals([
      { start: iso(0), end: iso(60), value: 0 },
      { start: iso(120), end: iso(180), value: 0 },
    ]),
    [
      { start: iso(0), end: iso(60) },
      { start: iso(120), end: iso(180) },
    ],
  );
  assert.deepEqual(zeroIntervals([{ start: iso(0), end: iso(30), value: 0 }]), []);
  assert.equal(zeroIntervals([{ start: iso(0), end: iso(600), value: 1 }]).length, 0);
});
test("delayed wake fails if delivered early, without zero, or without a cold start", () => {
  const points = [{ start: iso(0), end: iso(due), value: 0 }];
  const wake = { probe: "own-delayed", receivedAt: iso(due + 2), status: 200, verified: true };
  const good = { scheduleAt: iso(due), wakes: [wake], starts: [iso(due + 1)], points };
  assert.equal(evaluateDelayedWake(good).pass, true);
  assert.equal(
    evaluateDelayedWake({ ...good, wakes: [wake, { ...wake, receivedAt: iso(due - 1) }] }).pass,
    false,
  );
  assert.equal(evaluateDelayedWake({ ...good, points: [] }).pass, false);
  assert.equal(evaluateDelayedWake({ ...good, starts: [iso(10)] }).pass, false);
  assert.equal(evaluateDelayedWake({ ...good, wakes: [{ ...wake, verified: false }] }).pass, false);
});
test("503 retries must all arrive in order with non-shrinking backoff", () => {
  const wakes = goodWakes().filter((wake) => wake.probe === "own-retry");
  assert.equal(evaluateRetries({ wakes, fail503: M09_LIMITS.fail503 }).pass, true);
  assert.equal(
    evaluateRetries({ wakes: wakes.slice(0, -1), fail503: M09_LIMITS.fail503 }).pass,
    false,
  );
  const shrinking = wakes.map((wake, index) => ({
    ...wake,
    receivedAt: iso(index === 5 ? 34 : index * 8),
  }));
  assert.equal(evaluateRetries({ wakes: shrinking, fail503: M09_LIMITS.fail503 }).pass, false);
});
test("OIDC tokens must carry verified invoker email and the exact audience", () => {
  const wake = { verified: true, claims };
  assert.equal(evaluateOidc({ wakes: [wake] }).pass, true);
  assert.equal(evaluateOidc({ wakes: [] }).pass, false);
  for (const change of [
    { emailVerified: false },
    { hasEmail: false },
    { audienceMatches: false },
    { issuer: "https://evil.example" },
    { lifetimeSeconds: 7200 },
  ])
    assert.equal(
      evaluateOidc({ wakes: [{ verified: true, claims: { ...claims, ...change } }] }).pass,
      false,
    );
});
test("queue probe evaluation fails on any missing or failed case", () => {
  assert.equal(evaluateQueueProbe(null).pass, false);
  assert.equal(evaluateQueueProbe({ pass: true, results: [] }).pass, false);
});
test("isolation fails when the other app is woken, allowed or started", () => {
  const base = {
    otherWakes: [],
    otherRequests: [{ at: iso(10), status: 403 }],
    otherStarts: [],
    since: iso(0),
  };
  assert.equal(evaluateIsolation(base).pass, true);
  assert.equal(evaluateIsolation({ ...base, otherWakes: [{ receivedAt: iso(20) }] }).pass, false);
  assert.equal(
    evaluateIsolation({ ...base, otherRequests: [{ at: iso(10), status: 200 }] }).pass,
    false,
  );
  assert.equal(evaluateIsolation({ ...base, otherStarts: [iso(15)] }).pass, false);
  assert.equal(evaluateIsolation({ ...base, otherRequests: [] }).pass, false);
});
test("builder may only write its image repository", () => {
  const member = "serviceAccount:b@p.iam.gserviceaccount.com";
  const repo = {
    resource: "repo",
    policy: { bindings: [{ role: "roles/artifactregistry.writer", members: [member] }] },
  };
  assert.equal(
    evaluateBuilder({
      policies: [repo],
      builder: "b@p.iam.gserviceaccount.com",
      repository: "repo",
    }).pass,
    true,
  );
  const secret = {
    resource: "secret",
    policy: { bindings: [{ role: "roles/secretmanager.secretAccessor", members: [member] }] },
  };
  assert.equal(
    evaluateBuilder({
      policies: [repo, secret],
      builder: "b@p.iam.gserviceaccount.com",
      repository: "repo",
    }).pass,
    false,
  );
});
test("scaling evaluation requires min zero, a bounded max, request billing and private ingress", () => {
  const good = {
    service: { ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" },
    revision: {
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
      maxInstanceRequestConcurrency: 4,
      containers: [{ resources: { cpuIdle: true } }],
    },
  };
  assert.equal(evaluateScaling(good).pass, true);
  assert.equal(
    evaluateScaling({ ...good, service: { ingress: "INGRESS_TRAFFIC_ALL" } }).pass,
    false,
  );
  assert.equal(
    evaluateScaling({
      ...good,
      revision: { ...good.revision, scaling: { minInstanceCount: 1, maxInstanceCount: 1 } },
    }).pass,
    false,
  );
  assert.equal(
    evaluateScaling({
      ...good,
      revision: { ...good.revision, containers: [{ resources: { cpuIdle: false } }] },
    }).pass,
    false,
  );
  assert.equal(evaluateCleanup({ services: [] }).pass, true);
});

// ---- SQL ------------------------------------------------------------------------------------
test("SQL bootstrap limits connections and timeouts, revokes PUBLIC and escapes passwords", () => {
  const passwords = fixturePasswords([
    "embody_migrator",
    "embody_runtime",
    "embody_other",
    "embody_platform_migrator",
    "embody_platform_runtime",
  ]);
  passwords.embody_runtime = "it's";
  const statements = bootstrapStatements(passwords).join(";\n");
  assert.match(
    statements,
    /CREATE ROLE "embody_runtime" LOGIN PASSWORD 'it''s' .*CONNECTION LIMIT 5/,
  );
  assert.match(statements, /ALTER ROLE "embody_runtime" SET statement_timeout = 30000/);
  assert.match(statements, /REVOKE ALL ON DATABASE "embody_platform" FROM PUBLIC/);
  assert.match(statements, /REVOKE "embody_migrator" FROM CURRENT_USER/);
  assert.doesNotMatch(statements, /SUPERUSER(?! )|BYPASSRLS(?! )/);
  assert.throws(() => bootstrapStatements({}), /Missing fixture password/);
});
test("connection storm, denials, latency and restore fail closed", () => {
  const ok = { ok: true };
  const refused = { ok: false, code: "53300" };
  const storm = (results, extra = {}) =>
    evaluateStorm({ results, limit: 2, platformDuringStorm: true, releasedAfter: true, ...extra })
      .pass;
  assert.equal(storm([ok, ok, refused, refused]), true);
  assert.equal(storm([ok, ok, ok, refused]), false);
  assert.equal(storm([ok, ok, { ok: false, code: "08006" }]), false);
  assert.equal(storm([ok, ok, refused], { platformDuringStorm: false }), false);
  assert.equal(storm([ok, ok]), false);
  assert.equal(evaluateConnectDenials([{ target: "embody_other", code: "42501" }]).pass, true);
  assert.equal(evaluateConnectDenials([{ target: "embody_other", code: "28P01" }]).pass, false);
  assert.equal(evaluateConnectDenials([]).pass, false);
  assert.throws(() => latencySummary([1, 2, 3]), /At least 20/);
  assert.equal(latencySummary(Array.from({ length: 20 }, (_, index) => index + 1)).p95Ms, 19);
  assert.equal(
    evaluateRestore({ checksumAtBackup: "a", checksumAfterRestore: "a", markerAfterRestore: false })
      .pass,
    true,
  );
  assert.equal(
    evaluateRestore({ checksumAtBackup: "a", checksumAfterRestore: "a", markerAfterRestore: true })
      .pass,
    false,
  );
  assert.equal(
    evaluateRestore({ checksumAtBackup: "", checksumAfterRestore: "", markerAfterRestore: false })
      .pass,
    false,
  );
});
test("PostgreSQL gates accept a dedicated Cloud SQL instance in place of a container", () => {
  assert.deepEqual(
    databaseServiceIdentity({
      EMBODY_POSTGRES_PROVIDER_INSTANCE: "embody-cloud:us-central1:embody-test-m09-postgres",
    }),
    {
      name: "postgres-service",
      provider: "cloudsql",
      instance: "embody-cloud:us-central1:embody-test-m09-postgres",
    },
  );
  assert.throws(
    () =>
      databaseServiceIdentity({ EMBODY_POSTGRES_PROVIDER_INSTANCE: "prod:us-central1:customers" }),
    /dedicated embody-test/,
  );
  assert.throws(
    () =>
      databaseServiceIdentity({
        EMBODY_POSTGRES_PROVIDER_INSTANCE: "embody-cloud:us-central1:embody-test-m09-postgres",
        EMBODY_POSTGRES_TEST_CONTAINER: "abc",
      }),
    /not both/,
  );
  assert.throws(() => databaseServiceIdentity({}), /EMBODY_POSTGRES_TEST_CONTAINER/);
});

// ---- Costs ----------------------------------------------------------------------------------
test("cost worksheet itemizes the baseline within the $50 ceiling and needs measurements", () => {
  const sheet = monthlyWorksheet();
  assert.equal(sheet.withinCeiling, true);
  assert.ok(sheet.items.some((line) => line.item === "Cloud Tasks"));
  assert.ok(monthlyWorksheet({ tier: "db-g1-small", apps: 50 }).totalUsd > sheet.totalUsd);
  assert.throws(() => monthlyWorksheet({ tier: "db-custom-4-16384" }), /Unsupported/);
  assert.throws(() => qualificationEstimate({ sqlHours: 1 }), /Measured lifetimes required/);
  assert.equal(
    qualificationEstimate({
      sqlHours: 1,
      serviceActiveSeconds: 0,
      jobSeconds: 0,
      taskOperations: 0,
    }).invoiceMeasured,
    false,
  );
});

test("GCP provider module loads and refuses mutable images or other regions", async () => {
  const { createGcpProvider, loadBaseline } = await import("../../infra/mvp/m09/gcp.mjs");
  const baseline = { project: "embody-cloud", region: "us-central1", prefix: "embody-test-m09" };
  const token = () => assert.fail("no token before a call");
  assert.throws(
    () =>
      createGcpProvider({
        baseline,
        image: "us-central1-docker.pkg.dev/p/r/fixture:latest",
        token,
      }),
    /immutable fixture image digest/,
  );
  assert.throws(
    () =>
      createGcpProvider({
        baseline: { ...baseline, region: "europe-west1" },
        image: `us-central1-docker.pkg.dev/p/r/fixture@sha256:${"a".repeat(64)}`,
        token,
      }),
    /immutable fixture image digest/,
  );
  assert.equal(typeof loadBaseline, "function");
  const provider = createGcpProvider({
    baseline,
    image: `us-central1-docker.pkg.dev/p/r/fixture@sha256:${"a".repeat(64)}`,
    token,
  });
  for (const name of SUITE_PROVIDER_METHODS) assert.equal(typeof provider[name], "function", name);
});

test("cloud gate needs a credential file unless the operator gcloud login is chosen", async () => {
  const { result } = await gate({ GOOGLE_APPLICATION_CREDENTIALS: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required configuration: GOOGLE_APPLICATION_CREDENTIALS/);
  const operator = await gate({
    GOOGLE_APPLICATION_CREDENTIALS: "",
    EMBODY_MVP_CLOUD_CREDENTIALS: "gcloud",
  });
  assert.match(operator.result.stderr, /Missing required configuration: EMBODY_M09_BASELINE/);
});

test("suite refuses a provider missing any method before creating anything", async () => {
  const provider = fakeProvider();
  delete provider.wait;
  await assert.rejects(runM09Suite(env, provider), /missing wait; nothing created/);
  assert.deepEqual(provider.calls, []);
});

test("suite errors keep our sanitized provider messages and drop anything else", () => {
  assert.equal(
    safeError(new Error("Provider GET run.googleapis.com failed (503); body suppressed")),
    "Provider GET run.googleapis.com failed (503); body suppressed",
  );
  assert.equal(
    safeError(new Error("Provider GET failed (0); details suppressed")),
    "Provider GET failed (0); details suppressed",
  );
  assert.equal(safeError(new Error("password authentication failed for user x")), "Error");
  assert.equal(safeError(new TypeError("postgresql://u:p@h/db refused")), "TypeError");
});
test("deadline fetch fails a provider call that never answers", async () => {
  const { deadlineFetch } = await import("../../infra/mvp/m09/gcp.mjs");
  const hanging = () => new Promise(() => undefined);
  await assert.rejects(
    deadlineFetch(hanging, 20)("https://run.googleapis.com/v2/x", { method: "GET" }),
    /Provider GET run.googleapis.com failed \(0\); details suppressed/,
  );
  let calls = 0;
  const limited = deadlineFetch(
    async () => (++calls < 3 ? new Response("{}", { status: 429 }) : Response.json({ ok: true })),
    1000,
    1,
  );
  assert.equal((await limited("https://iam.googleapis.com/v1/x", { method: "POST" })).status, 200);
  assert.equal(calls, 3);
  const ok = await deadlineFetch(async () => Response.json({ a: 1 }), 1000)("https://x.example/");
  assert.deepEqual(await ok.json(), { a: 1 });
});
test("gauge-style one-minute zero points merge into an interval", () => {
  const minute = (m, value) => ({ start: iso(m * 60 - 60), end: iso(m * 60), value });
  assert.equal(zeroIntervals([minute(1, 0), minute(2, 0), minute(3, 1)]).length, 1);
});
