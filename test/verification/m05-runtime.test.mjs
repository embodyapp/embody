import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  probeRuntimeIsolation,
  validateRuntimeProbe,
  assertRuntimeSqlRole,
} from "../../scripts/probe-m05-runtime.mjs";
import { probePrivateInvocation } from "../../scripts/probe-m05-invocation.mjs";

const { Response } = globalThis;
const config = {
  project: "embody-fixture-project",
  prefix: "embody-test-m05",
  region: "us-central1",
  candidateSha: "a".repeat(40),
  workspaceId: "ws_m05fixture01",
  appOrigin: "https://embody-test-m05-own-fixture.a.run.app",
  appAudience: "kanban",
  runtime: "embody-test-m05-runtime@embody-fixture-project.iam.gserviceaccount.com",
  gateway: "embody-test-m05-gateway@embody-fixture-project.iam.gserviceaccount.com",
  ownService: "embody-test-m05-own",
  gatewayService: "embody-test-m05-gateway",
  otherService: "embody-test-m05-other",
  ownDatabaseSecret: "embody-test-m05-own-db",
  platformDatabaseSecret: "embody-test-m05-platform-db",
  otherAppSecret: "embody-test-m05-other-secret",
  signingSecret: "embody-test-m05-signing",
  ownDatabase: "embody_test_own",
  platformDatabase: "embody_test_platform",
  otherDatabase: "embody_test_other",
  databaseRole: "embody_test_runtime",
};
const ownDsn =
  "postgresql://embody_test_runtime:DO_NOT_OUTPUT_PASSWORD@fixture.example/embody_test_own";
function fixture(override = () => undefined) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const replacement = override(String(url), init);
    if (replacement) return replacement;
    if (String(url).endsWith("/email"))
      return new Response(config.runtime, { headers: { "Metadata-Flavor": "Google" } });
    if (String(url).endsWith("/token"))
      return Response.json(
        { access_token: "DO_NOT_OUTPUT_TOKEN" },
        { headers: { "Metadata-Flavor": "Google" } },
      );
    if (String(url).includes(`/secrets/${config.ownDatabaseSecret}/`))
      return Response.json({ payload: { data: Buffer.from(ownDsn).toString("base64") } });
    if (String(url).includes(":testIamPermissions")) return Response.json({ permissions: [] });
    return new Response("DO_NOT_OUTPUT_PROVIDER_BODY", { status: 403 });
  };
  const sql = async (dsn, role) => {
    assert.equal(role, config.databaseRole);
    if (new URL(dsn).pathname !== `/${config.ownDatabase}`)
      throw Object.assign(new Error("DSN SECRET"), { code: "42501" });
  };
  return { fetch, sql, calls };
}

test("M05 runtime probe checks real metadata subject, positive controls and every required denial without leaking credentials", async () => {
  const deps = fixture();
  const report = await probeRuntimeIsolation(config, deps);
  assert.equal(report.status, "passed");
  assert.equal(report.checks.length, 11);
  assert.equal(report.runtimeIdentity, config.runtime);
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_OUTPUT|DSN SECRET/);
  assert(deps.calls.every(({ init }) => init.redirect === "error"));
  assert.equal(deps.calls.filter(({ url }) => url.includes(":testIamPermissions")).length, 4);
});

test("M05 runtime probe rejects accidental production/mismatched fixtures and elevated resource bindings", async () => {
  const sqlRole = {
    name: config.databaseRole,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    can_create_database_objects: false,
    can_create_public_objects: false,
    owns_objects: false,
    memberships: [],
  };
  assert.doesNotThrow(() => assertRuntimeSqlRole(sqlRole, config.databaseRole));
  for (const override of [
    { memberships: ["platform_migrator"] },
    { rolsuper: true },
    { rolbypassrls: true },
    { owns_objects: true },
    { can_create_public_objects: true },
    { can_create_database_objects: true },
    { rolsuper: undefined },
  ])
    assert.throws(() => assertRuntimeSqlRole({ ...sqlRole, ...override }, config.databaseRole));
  for (const override of [
    { prefix: "production" },
    { runtime: config.gateway },
    { signingSecret: config.ownDatabaseSecret },
    { ownDatabase: "customer_data" },
    { gatewayService: config.ownService },
    { candidateSha: "unknown" },
  ])
    assert.throws(() => validateRuntimeProbe({ ...config, ...override }));
  for (const override of [
    (url) =>
      url.endsWith("/email")
        ? new Response(config.gateway, { headers: { "Metadata-Flavor": "Google" } })
        : undefined,
    (url) =>
      url.includes(`/secrets/${config.signingSecret}/`) ? new Response("STOLEN_SECRET") : undefined,
    (url) =>
      url.includes(":testIamPermissions")
        ? Response.json({ permissions: ["run.services.update"] })
        : undefined,
    (url) =>
      url.includes(`/services/${config.otherService}:testIamPermissions`)
        ? Response.json({ permissions: ["run.services.setIamPolicy"] })
        : undefined,
    (url) =>
      url.endsWith(":generateAccessToken")
        ? Response.json({ accessToken: "STOLEN_TOKEN" })
        : undefined,
  ])
    await assert.rejects(probeRuntimeIsolation(config, fixture(override)));
});

test("M05 runtime probe never treats outages/404s/wrong DB errors as IAM denial or success", async () => {
  for (const status of [200, 404, 500])
    await assert.rejects(
      probeRuntimeIsolation(
        config,
        fixture((url) =>
          url.includes(`/secrets/${config.otherAppSecret}/`)
            ? new Response("untrusted", { status })
            : undefined,
        ),
      ),
    );
  await assert.rejects(
    probeRuntimeIsolation(config, { ...fixture(), sql: () => Promise.resolve() }),
    /connected successfully/,
  );
  await assert.rejects(
    probeRuntimeIsolation(config, {
      ...fixture(),
      sql: (dsn) => {
        if (new URL(dsn).pathname === `/${config.ownDatabase}`) return Promise.resolve();
        return Promise.reject(
          Object.assign(new Error("password leaked by driver"), { code: "ECONNREFUSED" }),
        );
      },
    }),
    /not a PostgreSQL permission denial/,
  );
  await assert.rejects(
    probeRuntimeIsolation(
      config,
      fixture((url) =>
        url.endsWith("/token") ? Response.json({ access_token: "token" }) : undefined,
      ),
    ),
    /metadata identity unavailable/,
  );
});

test("M05 private invocation requires provider denial even for leaked principal tokens and a genuine app positive control", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, "/health");
    assert.equal(init.redirect, "error");
    assert.equal(init.method, "GET");
    calls.push(init.headers);
    if (!init.headers.authorization) return new Response("provider-denied", { status: 403 });
    return Response.json({ appId: "kanban", live: true, ready: true });
  };
  const report = await probePrivateInvocation(config, {
    fetch,
    invocationToken: (origin) => {
      assert.equal(origin, config.appOrigin);
      return Promise.resolve("PROVIDER_TOKEN");
    },
    principalToken: "PRINCIPAL_TOKEN",
  });
  assert.equal(report.checks.length, 3);
  assert.deepEqual(calls, [
    {},
    { "x-gateway-auth": "Bearer PRINCIPAL_TOKEN" },
    { authorization: "Bearer PROVIDER_TOKEN", "x-gateway-auth": "Bearer PRINCIPAL_TOKEN" },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /PROVIDER_TOKEN|PRINCIPAL_TOKEN/);
});

test("M05 private invocation never accepts public apps, nonexistent/unready targets or redirect failures", async () => {
  for (const status of [200, 401, 404, 500])
    await assert.rejects(
      probePrivateInvocation(config, {
        fetch: () => Promise.resolve(new Response("unexpected", { status })),
        invocationToken: () => Promise.resolve("provider"),
        principalToken: "principal",
      }),
    );
  for (const result of [
    { appId: "other", live: true, ready: true },
    { appId: "kanban", live: true, ready: false },
  ])
    await assert.rejects(
      probePrivateInvocation(config, {
        fetch: (_url, init) =>
          Promise.resolve(
            init.headers.authorization
              ? Response.json(result)
              : new Response("denied", { status: 403 }),
          ),
        invocationToken: () => Promise.resolve("provider"),
        principalToken: "principal",
      }),
    );
  await assert.rejects(
    probePrivateInvocation(config, {
      fetch: () => Promise.reject(new Error("redirect")),
      invocationToken: () => Promise.resolve("provider"),
      principalToken: "principal",
    }),
  );
});

test("M05 runtime CLI fails before cloud access on missing approval and removes stale success evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embody-m05-negative-"));
  const report = join(directory, "m05-runtime-isolation.json");
  try {
    await writeFile(report, '{"status":"passed"}');
    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/probe-m05-runtime.mjs"], {
          cwd: new URL("../../", import.meta.url),
          env: { PATH: process.env.PATH, EMBODY_TEST_EVIDENCE_DIR: directory },
          encoding: "utf8",
          stdio: "pipe",
        }),
      (error) => error.status === 1 && /probe failed/.test(error.stderr) && !error.stdout,
    );
    await assert.rejects(access(report));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
