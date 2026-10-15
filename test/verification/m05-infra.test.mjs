import { test } from "node:test";
import assert from "node:assert/strict";
import { URL } from "node:url";
const { Response } = globalThis;
import { bootstrapState } from "../../scripts/bootstrap-m05-state.mjs";
import {
  appResourceNames,
  createCloudRunAppProvisioner,
} from "../../infra/mvp/provider/cloud-run.mjs";
const scope = { workspaceId: "ws_abcdefgh1234", appId: "kanban" };
const config = {
  project: "embody-cloud",
  region: "us-central1",
  prefix: "embody-test-m05",
  gatewayEmail: "embody-test-m05-gateway@embody-cloud.iam.gserviceaccount.com",
  accessToken: () => Promise.resolve("TOKEN_MUST_NOT_LEAK"),
  sleep: () => Promise.resolve(),
};
function fixture() {
  const values = new Map(),
    calls = [];
  values.set(
    `https://run.googleapis.com/v2/projects/${config.project}/locations/${config.region}/services/${config.prefix}-gateway`,
    {
      uri: "https://embody-test-m05-gateway-123.us-central1.run.app",
      template: {
        serviceAccount: config.gatewayEmail,
        containers: [{ env: [{ name: "GATEWAY_JWT_ISSUER", value: "https://gateway.example" }] }],
      },
    },
  );
  values.set(`https://cloudresourcemanager.googleapis.com/v3/projects/${config.project}`, {
    projectId: config.project,
    name: "projects/123456",
  });
  const fetcher = async (url, options) => {
    calls.push({
      url,
      method: options.method,
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    assert.equal(options.redirect, "error");
    if (options.method === "GET")
      return values.has(url) ? Response.json(values.get(url)) : new Response(null, { status: 404 });
    if (options.method === "DELETE") {
      values.delete(url.split("?")[0]);
      return Response.json(
        url.startsWith("https://run.googleapis.com/") ? { done: true, response: {} } : {},
      );
    }
    const body = JSON.parse(options.body);
    if (url.startsWith("https://iam.googleapis.com/")) {
      const account = {
        ...body.serviceAccount,
        email: `${body.accountId}@${config.project}.iam.gserviceaccount.com`,
      };
      values.set(`${url}/${account.email}`, account);
      return Response.json(account);
    }
    if (url.includes(":setIamPolicy")) {
      values.set(url.replace(":setIamPolicy", ":getIamPolicy"), body.policy);
      return Response.json(body.policy);
    }
    if (url.includes("secretId=")) {
      const key = url.split("?")[0] + "/" + new URL(url).searchParams.get("secretId");
      values.set(key, body);
      values.set(`${key}:getIamPolicy`, {});
      return Response.json(body);
    }
    if (options.method === "PATCH") {
      const key = url.split("?")[0];
      values.set(key, { ...values.get(key), ...body });
      return Response.json({ done: true, response: {} });
    }
    if (url.includes("serviceId=")) {
      const service = new URL(url).searchParams.get("serviceId");
      const key = url.split("?")[0] + "/" + service;
      values.set(key, { ...body, uri: `https://${service}-123.us-central1.run.app` });
      values.set(`${key}:getIamPolicy`, {});
      return Response.json({ done: true, response: {} });
    }
    throw new Error("Unexpected mock mutation");
  };
  return { values, calls, fetcher, provider: createCloudRunAppProvisioner({ ...config, fetcher }) };
}
const candidate = {
  image: `us-central1-docker.pkg.dev/embody-cloud/embody-test-m05-images/app@sha256:${"a".repeat(64)}`,
  issuer: "https://gateway.example",
  jwksUrl: "https://embody-test-m05-gateway-123.us-central1.run.app/.well-known/jwks.json",
  secretVersion: "1",
};
async function prepared() {
  const f = fixture();
  await f.provider.prepare(scope);
  const names = appResourceNames({ ...config, ...scope });
  f.values.set(
    `https://secretmanager.googleapis.com/v1/projects/${config.project}/secrets/${names.databaseSecret}/versions/1`,
    { state: "ENABLED" },
  );
  return { ...f, names };
}
test("M05 app names are deterministic, scoped and within SA bounds", () => {
  const names = appResourceNames({ ...config, ...scope });
  assert.equal(names.runtime.length, 30);
  assert.deepEqual(names, appResourceNames({ ...config, ...scope }));
  assert.notEqual(
    names.service,
    appResourceNames({ ...config, ...scope, workspaceId: "ws_other123456" }).service,
  );
  assert.throws(() => appResourceNames({ ...config, ...scope, prefix: "production" }));
});
test("M05 adapter prepares app resources idempotently, never secret contents or project grants", async () => {
  const f = fixture();
  await f.provider.prepare({ ...scope, prefix: "embody-test-x" });
  const first = f.calls.filter(
    (call) => call.method === "POST" && !call.url.includes("IamPolicy"),
  ).length;
  await f.provider.prepare(scope);
  assert.equal(
    f.calls.filter((call) => call.method === "POST" && !call.url.includes("IamPolicy")).length,
    first,
  );
  assert.equal(first, 4);
  assert(f.calls.every((call) => !call.url.includes("embody-test-x")));
  assert(!JSON.stringify(f.calls).includes("TOKEN_MUST_NOT_LEAK"));
  assert(!f.calls.some((call) => call.url.includes(":addVersion")));
});
test("M05 adapter deploys pinned hosted private service with only public auth and secret references", async () => {
  const f = await prepared();
  const result = await f.provider.deploy(scope, candidate);
  const create = f.calls.find((call) => call.url.includes("serviceId="));
  assert.equal(create.body.invokerIamDisabled, false);
  assert.equal(create.body.template.scaling.minInstanceCount, 0);
  assert.equal(create.body.template.scaling.maxInstanceCount, 1);
  assert.equal(
    create.body.template.serviceAccount,
    `${f.names.runtime}@${config.project}.iam.gserviceaccount.com`,
  );
  assert.equal(
    create.body.template.containers[0].env.find((item) => item.name === "DATABASE_URL").value,
    undefined,
  );
  assert.equal(result.image, candidate.image);
  const policy = f.calls.at(-2).body.policy;
  assert.deepEqual(policy.bindings, [
    { role: "roles/run.invoker", members: [`serviceAccount:${config.gatewayEmail}`] },
  ]);
  await f.provider.deploy(scope, candidate);
  const update = f.calls.find((call) => call.method === "PATCH");
  assert(update.url.includes("updateMask="));
  assert.equal(update.body.template.containers[0].image, candidate.image);
});
test("M05 adapter refuses unowned/public services before mutation and never accepts mutable images", async () => {
  for (const ownership of ["foreign", "public"]) {
    const f = await prepared();
    await f.provider.deploy(scope, candidate);
    const url = `https://run.googleapis.com/v2/projects/${config.project}/locations/${config.region}/services/${f.names.service}`;
    if (ownership === "foreign") f.values.get(url).labels.workspace = "ws_foreign1234";
    else
      f.values.set(`${url}:getIamPolicy`, {
        bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }],
      });
    const before = f.calls.length;
    await assert.rejects(f.provider.deploy(scope, candidate));
    assert(f.calls.slice(before).every((call) => call.method === "GET"));
  }
  const f = await prepared();
  const before = f.calls.length;
  await assert.rejects(
    f.provider.deploy(scope, { ...candidate, image: candidate.image.split("@")[0] + ":latest" }),
  );
  assert.equal(f.calls.length, before);
});
test("M05 adapter suppresses provider credential/secret error bodies", async () => {
  const provider = createCloudRunAppProvisioner({
    ...config,
    fetcher: () =>
      Promise.resolve(Response.json({ error: "TOKEN_MUST_NOT_LEAK" }, { status: 403 })),
  });
  await assert.rejects(
    provider.prepare(scope),
    (error) => !error.message.includes("TOKEN_MUST_NOT_LEAK"),
  );
});
const command = async (_bin, args) => ({
  stdout:
    args[0] === "projects"
      ? JSON.stringify({ projectId: "embody-cloud", projectNumber: "123456" })
      : "TOKEN_MUST_NOT_LEAK",
});
const bucket = {
  projectNumber: "123456",
  location: "US-CENTRAL1",
  labels: { managed_by: "embody-state-bootstrap" },
  iamConfiguration: {
    uniformBucketLevelAccess: { enabled: true },
    publicAccessPrevention: "enforced",
  },
  versioning: { enabled: true },
};
const approval = { project: "embody-cloud", budget: "10", approved: "true" };
test("M05 state bootstrap requires approval before commands and refuses foreign/unsafe buckets", async () => {
  await assert.rejects(
    bootstrapState(
      { ...approval, approved: "false" },
      {
        command: () => {
          throw new Error("Must not run");
        },
      },
    ),
  );
  for (const value of [
    { ...bucket, projectNumber: "999" },
    { ...bucket, versioning: {} },
    { ...bucket, labels: {} },
  ])
    await assert.rejects(
      bootstrapState(approval, { command, fetcher: () => Promise.resolve(Response.json(value)) }),
    );
});
test("M05 state bootstrap creates private versioned GCS bucket and emits no credentials", async () => {
  const calls = [];
  const result = await bootstrapState(approval, {
    command,
    fetcher: (url, options) => {
      calls.push({ url, options });
      return Promise.resolve(
        calls.length === 1
          ? new Response(null, { status: 404 })
          : Response.json({ ...JSON.parse(options.body), projectNumber: "123456" }),
      );
    },
  });
  assert.equal(result.bucket, "embody-cloud-tfstate-123456");
  assert.equal(result.prefix, "mvp/m05/foundation");
  assert(!JSON.stringify(result).includes("TOKEN_MUST_NOT_LEAK"));
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.iamConfiguration.publicAccessPrevention, "enforced");
  assert.equal(body.versioning.enabled, true);
});
test("M05 app cleanup removes only owned deterministic resources, is repeatable and rejects adoption", async () => {
  const f = await prepared();
  await f.provider.deploy(scope, candidate);
  await f.provider.remove(scope);
  const deletes = f.calls.filter((call) => call.method === "DELETE");
  assert.equal(deletes.length, 5);
  assert(deletes.every((call) => !call.url.includes(`${config.prefix}-gateway`)));
  await f.provider.remove(scope);
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 5);
  const foreign = await prepared();
  await foreign.provider.deploy(scope, candidate);
  foreign.values.get(
    `https://secretmanager.googleapis.com/v1/projects/${config.project}/secrets/${foreign.names.databaseSecret}`,
  ).labels.fixture = "other";
  await assert.rejects(foreign.provider.remove(scope), /ownership mismatch/);
  assert(!foreign.calls.some((call) => call.method === "DELETE"));
});
test("M05 adapter pins actual project gateway authority, not a hostname prefix", async () => {
  const f = await prepared();
  const before = f.calls.length;
  await assert.rejects(
    f.provider.deploy(scope, {
      ...candidate,
      jwksUrl: "https://embody-test-m05-gateway-evil.us-central1.run.app/.well-known/jwks.json",
    }),
  );
  assert(f.calls.slice(before).every((call) => call.method === "GET"));
  await assert.rejects(f.provider.deploy(scope, { ...candidate, issuer: "attacker" }));
});
test("M05 adapter supports max-length workspace IDs using bounded ownership hashes", async () => {
  const f = fixture();
  await f.provider.prepare({ ...scope, workspaceId: "ws_" + "a".repeat(64) });
  const create = f.calls.find((call) => call.url.includes("secretId="));
  assert(create.body.labels.workspace.length <= 63);
});
test("M05 adapter retries only account propagation and fails closed on tombstoned bindings", async () => {
  const f = fixture();
  let attempts = 0;
  const provider = createCloudRunAppProvisioner({
    ...config,
    fetcher: (url, options) => {
      if (url.includes(":setIamPolicy") && attempts++ < 2)
        return Promise.resolve(
          Response.json(
            { error: { message: "Service account x does not exist" } },
            { status: 400 },
          ),
        );
      return f.fetcher(url, options);
    },
  });
  await provider.prepare(scope);
  assert.equal(attempts, 4);
  const names = appResourceNames({ ...config, ...scope });
  f.values.set(
    `https://secretmanager.googleapis.com/v1/projects/${config.project}/secrets/${names.databaseSecret}:getIamPolicy`,
    {
      bindings: [
        {
          role: "roles/secretmanager.secretAccessor",
          members: [
            `deleted:serviceAccount:${names.runtime}@${config.project}.iam.gserviceaccount.com?uid=123`,
          ],
        },
      ],
    },
  );
  await assert.rejects(provider.prepare(scope), /Unexpected app secret policy/);
});
test("M05 adapter bounds and confines asynchronous operation polling", async () => {
  for (const badScope of [false, true, "numeric"]) {
    const f = await prepared();
    const operationName = `projects/${badScope === "numeric" ? "123456" : badScope ? "other-project" : config.project}/locations/${config.region}/operations/operation1`;
    const provider = createCloudRunAppProvisioner({
      ...config,
      fetcher: async (url, options) => {
        if (url.includes("/operations/")) return Response.json({ done: true, response: {} });
        const response = await f.fetcher(url, options);
        return url.includes("serviceId=")
          ? Response.json({ name: operationName, done: false })
          : response;
      },
    });
    if (badScope === true)
      await assert.rejects(provider.deploy(scope, candidate), /Unexpected operation scope/);
    else await assert.doesNotReject(provider.deploy(scope, candidate));
  }
});
test("M05 state bootstrap fails closed on inaccessible buckets and create conflicts", async () => {
  for (const code of [403, 409]) {
    let calls = 0;
    await assert.rejects(
      bootstrapState(approval, {
        command,
        fetcher: () =>
          Promise.resolve(
            ++calls === 1 && code === 409
              ? new Response(null, { status: 404 })
              : Response.json({ error: "TOKEN_MUST_NOT_LEAK" }, { status: code }),
          ),
      }),
      (error) => !error.message.includes("TOKEN_MUST_NOT_LEAK"),
    );
  }
});
test("M09 reuses the state bucket under its own prefix with the $25 qualification ceiling", async () => {
  const never = {
    command: () => {
      throw new Error("Must not run");
    },
  };
  await assert.rejects(bootstrapState({ ...approval, budget: "25" }, never), /at most \$10/);
  await assert.rejects(
    bootstrapState({ ...approval, budget: "26", statePrefix: "mvp/m09/baseline" }, never),
    /at most \$25/,
  );
  await assert.rejects(bootstrapState({ ...approval, statePrefix: "other" }, never), /Unknown/);
  const result = await bootstrapState(
    { ...approval, budget: "25", statePrefix: "mvp/m09/baseline" },
    { command, fetcher: () => Promise.resolve(Response.json(bucket)) },
  );
  assert.equal(result.prefix, "mvp/m09/baseline");
  assert.equal(result.bucket, "embody-cloud-tfstate-123456");
});
