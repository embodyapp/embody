// M09 mocked adapter/probe tests. Fake HTTP only: not provider evidence.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import {
  WAKE_QUEUE_LIMITS,
  createWakeQueueProvisioner,
  queueMatchesLimits,
  wakeResourceNames,
} from "../../infra/mvp/provider/cloud-tasks.mjs";
import { claimSummary, createWakeTarget, probeRequest } from "../../infra/mvp/m09/wake-target.mjs";
import {
  IDENTITY_CASES,
  QUEUE_CASES,
  probePlan,
  runQueueProbe,
  validateProbeConfig,
} from "../../infra/mvp/m09/queue-probe.mjs";
const { Response } = globalThis;

const project = "embody-cloud";
const prefix = "embody-test-m09";
const scope = { workspaceId: "ws_m09abcdef12a", appId: "wake" };
const names = wakeResourceNames({ ...scope, project, prefix });
const email = (id) => `${id}@${project}.iam.gserviceaccount.com`;
const agent = "service-123456@gcp-sa-cloudtasks.iam.gserviceaccount.com";

function cloud({ queue, servicePolicy, accountPolicy, queuePolicy } = {}) {
  const values = new Map();
  const calls = [];
  const iam = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`;
  const tasks = `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/us-central1/queues`;
  const run = `https://run.googleapis.com/v2/projects/${project}/locations/us-central1/services`;
  values.set(`https://cloudresourcemanager.googleapis.com/v3/projects/${project}`, {
    projectId: project,
    name: "projects/123456",
  });
  values.set(`${iam}/${email(names.runtime)}`, { email: email(names.runtime) });
  values.set(`${run}/${names.service}`, {
    uri: "https://embody-test-m09-app-x-123456.us-central1.run.app",
    template: { serviceAccount: email(names.runtime) },
  });
  if (queue) values.set(`${tasks}/${names.queue}`, queue);
  const policies = new Map([
    [`${iam}/${email(names.invoker)}:getIamPolicy`, accountPolicy ?? {}],
    [`${tasks}/${names.queue}:getIamPolicy`, queuePolicy ?? {}],
    [
      `${run}/${names.service}:getIamPolicy`,
      servicePolicy ?? {
        bindings: [
          { role: "roles/run.invoker", members: [`serviceAccount:${email(`${prefix}-gateway`)}`] },
        ],
      },
    ],
  ]);
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, "error");
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method, body });
    if (policies.has(url)) return Response.json(policies.get(url));
    if (url.endsWith(":setIamPolicy")) {
      policies.set(url.replace(":setIamPolicy", ":getIamPolicy"), body.policy);
      return Response.json(body.policy);
    }
    if (options.method === "GET")
      return values.has(url) ? Response.json(values.get(url)) : new Response(null, { status: 404 });
    if (options.method === "DELETE") {
      values.delete(url);
      return Response.json({});
    }
    if (url === iam) {
      const account = { ...body.serviceAccount, email: email(body.accountId) };
      values.set(`${iam}/${account.email}`, account);
      return Response.json(account);
    }
    if (url === tasks) {
      values.set(`${tasks}/${names.queue}`, body);
      return Response.json(body);
    }
    if (url.endsWith(":pause")) return Response.json({ state: "PAUSED" });
    return new Response(null, { status: 500 });
  };
  return { fetcher, calls, values, policies, iam, tasks, run };
}
const provisioner = (fake) =>
  createWakeQueueProvisioner({
    project,
    region: "us-central1",
    prefix,
    accessToken: () => Promise.resolve("TOKEN_MUST_NOT_LEAK"),
    fetcher: fake.fetcher,
    sleep: () => Promise.resolve(),
  });

test("wake names are per app, fit IAM limits and match the M05 app hash", () => {
  assert.equal(names.queue, `${prefix}-wake-${names.service.split("-").at(-1)}`);
  assert.ok(names.invoker.length <= 30);
  const other = wakeResourceNames({ ...scope, workspaceId: "ws_m09abcdef12b", project, prefix });
  assert.notEqual(other.queue, names.queue);
  assert.notEqual(other.invoker, names.invoker);
});
test("prepare binds exactly runtime enqueue, runtime+agent actAs and invoker run.invoker", async () => {
  const fake = cloud();
  const result = await provisioner(fake).prepare(scope);
  assert.equal(result.invokerEmail, email(names.invoker));
  const queue = fake.values.get(`${fake.tasks}/${names.queue}`);
  assert.ok(queueMatchesLimits(queue));
  assert.equal(queue.retryConfig.maxAttempts, -1);
  assert.deepEqual(fake.policies.get(`${fake.tasks}/${names.queue}:getIamPolicy`).bindings, [
    { role: "roles/cloudtasks.enqueuer", members: [`serviceAccount:${email(names.runtime)}`] },
  ]);
  assert.deepEqual(fake.policies.get(`${fake.iam}/${email(names.invoker)}:getIamPolicy`).bindings, [
    {
      role: "roles/iam.serviceAccountUser",
      members: [`serviceAccount:${email(names.runtime)}`, `serviceAccount:${agent}`],
    },
  ]);
  assert.deepEqual(fake.policies.get(`${fake.run}/${names.service}:getIamPolicy`).bindings, [
    {
      role: "roles/run.invoker",
      members: [
        `serviceAccount:${email(`${prefix}-gateway`)}`,
        `serviceAccount:${email(names.invoker)}`,
      ],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(fake.calls), /TOKEN_MUST_NOT_LEAK/);
});
test("prepare refuses foreign queue settings and unowned IAM bindings", async () => {
  await assert.rejects(
    provisioner(cloud({ queue: { name: "x", retryConfig: { maxAttempts: 3 } } })).prepare(scope),
    /approved limits/,
  );
  await assert.rejects(
    provisioner(
      cloud({
        queuePolicy: { bindings: [{ role: "roles/cloudtasks.admin", members: ["user:a@b.c"] }] },
      }),
    ).prepare(scope),
    /Unexpected IAM binding/,
  );
  await assert.rejects(
    provisioner(
      cloud({
        servicePolicy: { bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] },
      }),
    ).prepare(scope),
    /Unexpected IAM binding/,
  );
  await assert.rejects(
    provisioner(
      cloud({
        accountPolicy: {
          bindings: [{ role: "roles/iam.serviceAccountTokenCreator", members: ["user:a@b.c"] }],
        },
      }),
    ).prepare(scope),
    /Unexpected IAM binding/,
  );
});
test("prepare requires the app's own runtime and service identity", async () => {
  const fake = cloud();
  fake.values.get(`${fake.run}/${names.service}`).template.serviceAccount =
    "x@y.iam.gserviceaccount.com";
  await assert.rejects(provisioner(fake).prepare(scope), /does not run as the app runtime/);
  const missing = cloud();
  missing.values.delete(`${missing.iam}/${email(names.runtime)}`);
  await assert.rejects(provisioner(missing).prepare(scope), /runtime identity first/);
});
test("remove deletes only owned queue/invoker and unbinds the invoker; repeatable", async () => {
  const fake = cloud();
  const wake = provisioner(fake);
  await wake.prepare(scope);
  assert.deepEqual(await wake.pause(scope), {
    queue: `projects/${project}/locations/us-central1/queues/${names.queue}`,
    state: "PAUSED",
  });
  await wake.remove(scope);
  assert.equal(fake.values.has(`${fake.tasks}/${names.queue}`), false);
  assert.equal(fake.values.has(`${fake.iam}/${email(names.invoker)}`), false);
  assert.doesNotMatch(
    JSON.stringify(fake.policies.get(`${fake.run}/${names.service}:getIamPolicy`)),
    new RegExp(names.invoker),
  );
  await wake.remove(scope);
  const foreign = cloud();
  foreign.values.set(`${foreign.iam}/${email(names.invoker)}`, {
    email: email(names.invoker),
    description: "x",
  });
  await assert.rejects(provisioner(foreign).remove(scope), /ownership mismatch/);
});
test("provisioner rejects other regions, long prefixes and provider errors without bodies", async () => {
  assert.throws(
    () =>
      createWakeQueueProvisioner({
        project,
        region: "europe-west1",
        prefix,
        accessToken: () => "",
      }),
    /Invalid provider authority/,
  );
  const failing = createWakeQueueProvisioner({
    project,
    region: "us-central1",
    prefix,
    accessToken: () => Promise.resolve("TOKEN_MUST_NOT_LEAK"),
    fetcher: async () => Response.json({ error: { message: "secret body" } }, { status: 403 }),
  });
  await assert.rejects(failing.prepare(scope), (error) => {
    assert.doesNotMatch(error.message, /secret body|TOKEN/);
    return true;
  });
  assert.equal(WAKE_QUEUE_LIMITS.retryConfig.minBackoff, "1s");
});

// ---- Wake target ----------------------------------------------------------------------------
const audience = "https://embody-test-m09-app-x-123456.us-central1.run.app";
const invokerEmail = email(names.invoker);
const jwt = (payload) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
async function call(handle, { token, body, retry }) {
  const logs = [];
  let status;
  const request = {
    method: "POST",
    url: "/_embody/drain",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(retry === undefined ? {} : { "x-cloudtasks-taskretrycount": String(retry) }),
      "x-cloudtasks-taskname": "m09-run-retry-abc",
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
  const response = {
    writeHead: (value) => {
      status = value;
    },
    end: () => undefined,
  };
  await handle(request, response);
  return { status, logs };
}
test("wake target authenticates every request, answers 503 per retry count and never logs tokens", async () => {
  const logs = [];
  const token = jwt({
    iss: "https://accounts.google.com",
    aud: audience,
    email: invokerEmail,
    email_verified: true,
    iat: 1,
    exp: 3601,
  });
  const verifier = { verify: async (value) => assert.equal(value, token) };
  const handle = createWakeTarget({
    verifier,
    audience,
    invokerEmail,
    log: (line) => logs.push(line),
  });
  assert.equal(
    (await call(handle, { token, body: { probe: "own-retry", fail503: 2 }, retry: 0 })).status,
    503,
  );
  assert.equal(
    (await call(handle, { token, body: { probe: "own-retry", fail503: 2 }, retry: 2 })).status,
    200,
  );
  const denied = createWakeTarget({
    verifier: { verify: async () => assert.fail("bad token") },
    audience,
    invokerEmail,
    log: (line) => logs.push(line),
  });
  assert.equal((await call(denied, { token: "forged", body: { probe: "x" } })).status, 401);
  for (const line of logs) assert.doesNotMatch(line, /signature|forged|eyJ/);
  const entry = JSON.parse(logs[0]);
  assert.deepEqual(entry.claims, {
    issuer: "https://accounts.google.com",
    audienceMatches: true,
    hasEmail: true,
    emailMatches: true,
    emailVerified: true,
    lifetimeSeconds: 3600,
  });
  assert.equal(JSON.parse(logs.at(-1)).verified, false);
});
test("wake target probe parsing and claim summary reject malformed input", () => {
  assert.equal(probeRequest("{"), null);
  assert.equal(probeRequest(JSON.stringify({ probe: "UPPER" })), null);
  assert.deepEqual(probeRequest(JSON.stringify({ probe: "a", fail503: 99 })), {
    probe: "a",
    fail503: 0,
  });
  assert.equal(claimSummary("garbage", { audience, invokerEmail }), null);
  assert.equal(
    claimSummary(jwt({ aud: "other" }), { audience, invokerEmail }).audienceMatches,
    false,
  );
});

// ---- Queue probe ----------------------------------------------------------------------------
const config = {
  ownQueue: `projects/${project}/locations/us-central1/queues/${prefix}-wake-aaaaaaaaaaaa`,
  otherQueue: `projects/${project}/locations/us-central1/queues/${prefix}-wake-bbbbbbbbbbbb`,
  ownInvoker: email(`${prefix}-w-aaaaaaaaaaaa`),
  otherInvoker: email(`${prefix}-w-bbbbbbbbbbbb`),
  ownUrl: `https://${prefix}-app-aaaaaaaaaaaa-123456.us-central1.run.app`,
  otherUrl: `https://${prefix}-app-bbbbbbbbbbbb-123456.us-central1.run.app`,
  runId: "a1b2c3d4",
  delaySeconds: 2400,
  fail503: 5,
  platformDbSecret: `projects/${project}/secrets/${prefix}-platform-db`,
  signerSecret: `projects/${project}/secrets/${prefix}-signer`,
  otherAppSecret: `projects/${project}/secrets/${prefix}-db-bbbbbbbbbbbb`,
  gatewayEmail: email(`${prefix}-gateway`),
  sqlInstance: `projects/${project}/instances/${prefix}-postgres`,
};
test("queue probe config needs two distinct queues, invokers and services", () => {
  assert.equal(validateProbeConfig(config), config);
  for (const change of [
    { otherQueue: config.ownQueue },
    { otherInvoker: config.ownInvoker },
    { otherUrl: config.ownUrl },
    { delaySeconds: 60 },
    { ownQueue: "projects/prod/locations/us-central1/queues/customers" },
  ])
    assert.throws(() => validateProbeConfig({ ...config, ...change }), /two distinct/);
  for (const change of [
    { signerSecret: config.platformDbSecret },
    { otherAppSecret: "projects/prod/secrets/customer-db" },
    { gatewayEmail: "someone@example.com" },
    { sqlInstance: "projects/prod/instances/customers" },
  ])
    assert.throws(() => validateProbeConfig({ ...config, ...change }), /platform\/other secrets/);
});
test("queue probe plan covers every case with hashed names and the 30-day horizon", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const plan = probePlan(config, now);
  assert.deepEqual(
    plan.map((step) => step.id),
    Object.keys(QUEUE_CASES),
  );
  assert.equal(plan[0].name, plan[1].name);
  const day = 86_400_000;
  const inside = plan.find((step) => step.id === "own-horizon-inside");
  const outside = plan.find((step) => step.id === "own-horizon-outside");
  assert.ok(Date.parse(inside.scheduleAt) - +now < 30 * day);
  assert.ok(Date.parse(outside.scheduleAt) - +now > 30 * day);
  assert.equal(plan.find((step) => step.id === "other-invoker").invoker, config.otherInvoker);
  assert.equal(plan.find((step) => step.id === "cross-app-target").url, config.otherUrl);
});
test("queue probe reports statuses only and fails on any unexpected status", async () => {
  const fetcher = async (url, options) => {
    if (url.endsWith("/token"))
      return Response.json({ access_token: "TOKEN_MUST_NOT_LEAK", expires_in: 3600 });
    if (url.endsWith("/email")) return new Response(email(`${prefix}-r-aaaaaaaaaaaa`));
    if (!url.startsWith("https://cloudtasks.")) return new Response("{}", { status: 403 });
    const body = JSON.parse(options.body);
    const id = Object.entries(QUEUE_CASES).find(([key]) =>
      body.task.name.includes(`-${key.split("-")[1]}`),
    )?.[0];
    if (url.includes(config.otherQueue)) return new Response("{}", { status: 403 });
    if (body.task.httpRequest.oidcToken.serviceAccountEmail === config.otherInvoker)
      return new Response("{}", { status: 403 });
    if (Date.parse(body.task.scheduleTime ?? 0) - Date.now() > 30 * 86_400_000)
      return new Response("{}", { status: 400 });
    return new Response("{}", { status: id === "own-duplicate" ? 409 : 200 });
  };
  const seen = new Set();
  const dedupFetcher = async (url, options) => {
    if (url.startsWith("https://cloudtasks.")) {
      const name = JSON.parse(options.body).task.name;
      if (seen.has(name)) return new Response("{}", { status: 409 });
      seen.add(name);
    }
    return fetcher(url, options);
  };
  const adapter = {
    names: new Set(),
    async enqueue(task) {
      if (this.names.has(task.name)) return "duplicate";
      this.names.add(task.name);
      return "created";
    },
  };
  const report = await runQueueProbe(config, { fetcher: dedupFetcher, adapter });
  assert.equal(report.pass, true, JSON.stringify(report.results));
  assert.equal(report.results.length, Object.keys(QUEUE_CASES).length + IDENTITY_CASES.length + 2);
  for (const id of IDENTITY_CASES)
    assert.equal(report.results.find((result) => result.case === id).status, 403);
  assert.doesNotMatch(JSON.stringify(report), /TOKEN_MUST_NOT_LEAK/);
  const permissive = await runQueueProbe(config, {
    fetcher: async (url) =>
      url.endsWith("/token")
        ? Response.json({ access_token: "t" })
        : new Response("{}", { status: 200 }),
  });
  assert.equal(permissive.pass, false);
  assert.equal(permissive.results.find((result) => result.case === "other-queue").pass, false);
  assert.equal(
    permissive.results.find((result) => result.case === "identity-secret-signer").pass,
    false,
  );
});
