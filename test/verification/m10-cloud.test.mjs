import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  M10_PROVIDER_METHODS,
  evaluateBucketPolicy,
  m10Approval,
  runM10Suite,
} from "../../infra/mvp/m10/qualify.mjs";

const { URL } = globalThis;

// Mocked: exercises suite logic, guards and teardown only. Never provider evidence.
const root = new URL("../..", import.meta.url).pathname;
const env = {
  EMBODY_MVP_CLOUD_PROJECT: "embody-test-project",
  EMBODY_MVP_CLOUD_RESOURCE_PREFIX: "embody-test-m10",
  EMBODY_MVP_CLOUD_BUDGET_USD: "2",
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
  const directory = await mkdtemp(join(tmpdir(), "embody-m10-gate-"));
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

test("M10 cloud gate refuses budgets above the approved $2 before any cloud call", async () => {
  const { result, report } = await gate({
    EMBODY_MVP_CLOUD_SUITES: "m10",
    EMBODY_MVP_CLOUD_BUDGET_USD: "3",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most \$2/);
  assert.equal(report.status, "failed");
  const combined = await gate({ EMBODY_MVP_CLOUD_SUITES: "m09,m10" });
  assert.equal(combined.result.status, 1);
  assert.match(combined.result.stderr, /one cloud suite per invocation; no resources created/);
  assert.throws(
    () => m10Approval({ ...env, EMBODY_MVP_CLOUD_BUDGET_APPROVED: "false" }),
    /approved positive budget/,
  );
  assert.deepEqual(m10Approval(env), {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: "embody-test-m10",
    budgetUsd: 2,
  });
});

test("bucket policy evaluation rejects public members, extra signer roles and wrong regions", () => {
  const good = {
    uniformBucketLevelAccess: true,
    publicAccessPrevention: "enforced",
    location: "US-CENTRAL1",
    versioning: false,
    bindings: [
      { role: "roles/storage.legacyBucketOwner", members: ["projectOwner:p"] },
      {
        role: "roles/storage.objectCreator",
        members: ["serviceAccount:s@p.iam.gserviceaccount.com"],
      },
    ],
  };
  const expected = { signer: "s@p.iam.gserviceaccount.com", location: "US-CENTRAL1" };
  assert.equal(evaluateBucketPolicy(good, expected).pass, true);
  for (const bad of [
    { ...good, publicAccessPrevention: "inherited" },
    { ...good, uniformBucketLevelAccess: false },
    { ...good, location: "US" },
    {
      ...good,
      bindings: [...good.bindings, { role: "roles/storage.objectViewer", members: ["allUsers"] }],
    },
    {
      ...good,
      bindings: [
        ...good.bindings,
        {
          role: "roles/storage.objectViewer",
          members: ["serviceAccount:s@p.iam.gserviceaccount.com"],
        },
      ],
    },
  ])
    assert.equal(evaluateBucketPolicy(bad, expected).pass, false);
});

async function fakeProvider(overrides = {}) {
  const gateway = await import("../../packages/gateway/dist/index.js");
  let offset = 0;
  const clock = { now: () => new Date(Date.now() + offset) };
  const origin = "https://storage.googleapis.com";
  const memory = new gateway.MemorySourceObjectStore({ origin, clock });
  const calls = [];
  // Present the fake's signature as X-Goog-Signature so URL tampering mirrors GCS.
  const objects = {
    async createUploadAccess(request) {
      const access = await memory.createUploadAccess(request);
      const url = new URL(access.url);
      url.searchParams.set("X-Goog-Signature", url.searchParams.get("sig"));
      url.searchParams.delete("sig");
      return { ...access, url: url.href };
    },
    stat: (key) => memory.stat(key),
    read: (key, options) => memory.read(key, options),
    delete: (key) => memory.delete(key),
  };
  const provider = {
    preflight: async () => calls.push("preflight"),
    setUp: async (_approval, runId) => {
      calls.push("setUp");
      return {
        bucket: `b-${runId}`,
        signer: "s@p.iam.gserviceaccount.com",
        publicObjectUrl: (key) => `${origin}/upload/${key}`,
        publicListUrl: `${origin}/upload/list`,
      };
    },
    objects: () => objects,
    rawFetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.searchParams.has("X-Goog-Signature")) {
        url.searchParams.set("sig", url.searchParams.get("X-Goog-Signature"));
        url.searchParams.delete("X-Goog-Signature");
      }
      const { signal, ...rest } = init;
      const handled = memory.fetch(url.href, rest);
      if (!signal) return handled;
      return Promise.race([
        handled,
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
      ]);
    },
    bucketPolicy: async () => ({
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
      location: "US-CENTRAL1",
      versioning: false,
      bindings: [
        {
          role: "roles/storage.objectCreator",
          members: ["serviceAccount:s@p.iam.gserviceaccount.com"],
        },
      ],
    }),
    projectIam: async () => "[]",
    wait: async (ms) => {
      offset += ms;
    },
    tearDown: async () => {
      calls.push("tearDown");
      return { pass: true, removed: ["bucket", "signer"] };
    },
    inventory: async () => [],
    operations: () => ({ classA: 40, classB: 30 }),
    ...overrides,
  };
  const contracts = await import("../../packages/cloud-contracts/dist/index.js");
  return { provider, calls, deps: { gateway, contracts } };
}

test("mocked M10 suite passes every case against GCS-like semantics and tears down", async () => {
  const { provider, calls, deps } = await fakeProvider();
  assert.deepEqual(
    M10_PROVIDER_METHODS.filter((m) => typeof provider[m] !== "function"),
    [],
  );
  const result = await runM10Suite(env, provider, deps);
  const failed = Object.entries(result.cases).filter(([, value]) => !value.pass);
  assert.deepEqual(failed, []);
  assert.equal(result.pass, true);
  assert.deepEqual(calls, ["preflight", "setUp", "tearDown"]);
  assert.ok(result.estimatedUsd <= 2);
  assert.doesNotMatch(JSON.stringify(result), /X-Goog-Signature|sig=|Bearer/);
});

test("mocked M10 suite fails closed and still tears down on setup failure, leftovers or IAM drift", async () => {
  const failing = await fakeProvider({
    setUp: async () => {
      throw new Error("Provider POST storage.googleapis.com failed (403); body suppressed");
    },
  });
  const broken = await runM10Suite(env, failing.provider, failing.deps);
  assert.equal(broken.pass, false);
  assert.equal(broken.cases.setUp.pass, false);
  assert.deepEqual(failing.calls, ["preflight", "tearDown"]);

  const leftover = await fakeProvider({ inventory: async () => ["bucket:embody-test-m10-src-x"] });
  assert.equal(
    (await runM10Suite(env, leftover.provider, leftover.deps)).cases.cleanup.pass,
    false,
  );

  let reads = 0;
  const drift = await fakeProvider({
    projectIam: async () => (reads++ === 0 ? "[]" : '["roles/editor|user:x|"]'),
  });
  const drifted = await runM10Suite(env, drift.provider, drift.deps);
  assert.equal(drifted.pass, false);
  assert.equal(drifted.cases.cleanup.projectIamUnchanged, false);

  const loose = await fakeProvider({
    bucketPolicy: async () => ({
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "inherited",
      location: "US-CENTRAL1",
      versioning: false,
      bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"] }],
    }),
  });
  assert.equal(
    (await runM10Suite(env, loose.provider, loose.deps)).cases.bucketPrivacy.pass,
    false,
  );
});
