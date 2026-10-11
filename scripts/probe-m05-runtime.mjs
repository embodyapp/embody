// Run only inside a disposable Cloud Run fixture under the APP runtime identity.
// Never run using operator ADC/impersonation: the actual metadata identity is the subject.
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL, URL } from "node:url";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";

const { fetch, AbortSignal } = globalThis;
const metadata =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/";
export function validateRuntimeProbe(config) {
  if (
    !config ||
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.project ?? "") ||
    !/^embody-test-[a-z0-9-]+$/.test(config.prefix ?? "") ||
    !/^[a-f0-9]{40}$/.test(config.candidateSha ?? "")
  )
    throw new Error("Runtime probe requires a dedicated test project/prefix and candidate SHA");
  for (const name of ["runtime", "gateway"]) {
    if (
      typeof config[name] !== "string" ||
      !config[name].startsWith(`${config.prefix}-`) ||
      !config[name].endsWith(`@${config.project}.iam.gserviceaccount.com`)
    )
      throw new Error("Runtime probe service accounts must be dedicated project fixtures");
  }
  if (config.runtime === config.gateway)
    throw new Error("Runtime and gateway identities must differ");
  if (!/^[a-z]+-[a-z]+[0-9]{1,2}$/.test(config.region ?? ""))
    throw new Error("Runtime probe requires a fixture region");
  const services = [config.ownService, config.gatewayService, config.otherService];
  if (
    new Set(services).size !== 3 ||
    services.some(
      (name) =>
        typeof name !== "string" ||
        !name.startsWith(`${config.prefix}-`) ||
        !/^[a-z0-9-]+$/.test(name),
    )
  )
    throw new Error("Runtime probe requires distinct fixture service resources");
  if (!/^ws_[a-z0-9]{8,64}$/.test(config.workspaceId ?? ""))
    throw new Error("Runtime probe requires the provisioned fixture workspace");
  const secrets = [
    config.ownDatabaseSecret,
    config.platformDatabaseSecret,
    config.otherAppSecret,
    config.signingSecret,
  ];
  if (
    new Set(secrets).size !== 4 ||
    secrets.some(
      (name) =>
        typeof name !== "string" ||
        !name.startsWith(`${config.prefix}-`) ||
        !/^[a-zA-Z0-9_-]+$/.test(name),
    )
  )
    throw new Error("Runtime probe needs distinct fixture-only own/platform/other/signing secrets");
  const databases = [config.ownDatabase, config.platformDatabase, config.otherDatabase];
  if (
    new Set(databases).size !== 3 ||
    databases.some((name) => typeof name !== "string" || !/^embody_test_[a-z0-9_]+$/.test(name))
  )
    throw new Error("Runtime probe needs distinct fixture-only databases on the same server");
  if (!/^embody_test_[a-z0-9_]+$/.test(config.databaseRole ?? ""))
    throw new Error("Runtime probe requires the provisioned fixture SQL role");
  return config;
}

export function assertRuntimeSqlRole(row, role) {
  if (
    !row ||
    row.name !== role ||
    row.rolsuper !== false ||
    row.rolbypassrls !== false ||
    row.rolcreatedb !== false ||
    row.rolcreaterole !== false ||
    row.can_create_database_objects !== false ||
    row.can_create_public_objects !== false ||
    row.owns_objects !== false ||
    !Array.isArray(row.memberships) ||
    row.memberships.length !== 0
  )
    throw new Error("Runtime SQL identity is elevated or mismatched");
}

/** Only status/permission outcomes are retained. Never emit a token, secret or DSN. */
export async function probeRuntimeIsolation(config, { fetch: fetcher = fetch, sql } = {}) {
  validateRuntimeProbe(config);
  const checks = [];
  const request = (url, init = {}) =>
    fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5000) });
  const metadataRequest = async (path) => {
    const response = await request(`${metadata}${path}`, {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (response.status !== 200 || response.headers.get("metadata-flavor") !== "Google")
      throw new Error("Runtime metadata identity unavailable");
    return response;
  };
  const identity = (await (await metadataRequest("email")).text()).trim();
  if (identity !== config.runtime)
    throw new Error("Probe is not running as the provisioned app runtime");
  checks.push("actual-runtime-metadata-identity");
  const credential = await (await metadataRequest("token")).json();
  if (
    typeof credential.access_token !== "string" ||
    !credential.access_token ||
    /\s/.test(credential.access_token)
  )
    throw new Error("Runtime metadata access token unavailable");
  const headers = {
    authorization: `Bearer ${credential.access_token}`,
    "content-type": "application/json",
  };
  const secretUrl = (name) =>
    `https://secretmanager.googleapis.com/v1/projects/${config.project}/secrets/${name}/versions/latest:access`;
  const own = await request(secretUrl(config.ownDatabaseSecret), { headers });
  if (own.status !== 200) throw new Error("Own fixture database secret is not accessible");
  const data = await own.json();
  if (typeof data.payload?.data !== "string")
    throw new Error("Own fixture secret response invalid");
  const ownDsn = Buffer.from(data.payload.data, "base64").toString("utf8");
  let database;
  try {
    database = new URL(ownDsn);
  } catch {
    throw new Error("Own fixture database secret invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    decodeURIComponent(database.pathname.slice(1)) !== config.ownDatabase ||
    decodeURIComponent(database.username) !== config.databaseRole
  )
    throw new Error("Own fixture database secret does not match approved fixture");
  checks.push("own-secret-access-positive-control");
  for (const [label, name] of [
    ["platform-database-secret-denied", config.platformDatabaseSecret],
    ["other-app-secret-denied", config.otherAppSecret],
    ["gateway-signing-secret-denied", config.signingSecret],
  ]) {
    const response = await request(secretUrl(name), { headers });
    // 404/500/timeouts are not permission-denial evidence.
    if (response.status !== 403) throw new Error(`${label}: expected permission denial`);
    checks.push(label);
  }
  const permissions = ["run.services.create", "run.services.update", "cloudbuild.builds.create"];
  const policy = await request(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${config.project}:testIamPermissions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ permissions }),
    },
  );
  if (policy.status !== 200) throw new Error("Deployment/build effective-permission query failed");
  const result = await policy.json();
  if (
    result.permissions !== undefined &&
    (!Array.isArray(result.permissions) || result.permissions.length !== 0)
  )
    throw new Error("Runtime has deployment/build permissions");
  checks.push("deployment-and-build-denied");
  for (const service of [config.ownService, config.gatewayService, config.otherService]) {
    const response = await request(
      `https://run.googleapis.com/v2/projects/${config.project}/locations/${config.region}/services/${service}:testIamPermissions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ permissions: ["run.services.update", "run.services.setIamPolicy"] }),
      },
    );
    if (response.status !== 200) throw new Error("Service effective-permission query failed");
    const result = await response.json();
    if (
      result.permissions !== undefined &&
      (!Array.isArray(result.permissions) || result.permissions.length !== 0)
    )
      throw new Error("Runtime has service-scoped deployment/IAM permissions");
  }
  checks.push("service-scoped-deployment-and-iam-denied");
  const impersonation = await request(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.gateway}:generateAccessToken`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        scope: ["https://www.googleapis.com/auth/cloud-platform"],
        lifetime: "60s",
      }),
    },
  );
  if (impersonation.status !== 403)
    throw new Error("Gateway impersonation: expected permission denial");
  checks.push("gateway-impersonation-denied");
  if (typeof sql !== "function") throw new Error("Real SQL probe dependency required");
  await sql(ownDsn, config.databaseRole);
  checks.push("own-database-least-privilege-positive-control");
  for (const [label, name] of [
    ["platform-database-connect-denied", config.platformDatabase],
    ["other-database-connect-denied", config.otherDatabase],
  ]) {
    const target = new URL(ownDsn);
    target.pathname = `/${name}`;
    try {
      await sql(target.href, config.databaseRole);
    } catch (error) {
      if (error?.code !== "42501") throw new Error(`${label}: not a PostgreSQL permission denial`);
      checks.push(label);
      continue;
    }
    throw new Error(`${label}: runtime connected successfully`);
  }
  return {
    gate: "m05-runtime-isolation",
    status: "passed",
    candidateSha: config.candidateSha,
    project: config.project,
    resourcePrefix: config.prefix,
    runtimeIdentity: identity,
    checks,
  };
}

async function main() {
  const path = resolve(
    process.env.EMBODY_TEST_EVIDENCE_DIR ?? ".artifacts/verification",
    "m05-runtime-isolation.json",
  );
  await rm(path, { force: true });
  // Read-only tests still need explicit authorization and fixture boundaries.
  if (
    process.env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true" ||
    !Number.isFinite(Number(process.env.EMBODY_MVP_CLOUD_BUDGET_USD)) ||
    !(Number(process.env.EMBODY_MVP_CLOUD_BUDGET_USD) > 0) ||
    !process.env.EMBODY_M05_RUNTIME_PROBE_CONFIG
  )
    throw new Error("Approved fixture budget and EMBODY_M05_RUNTIME_PROBE_CONFIG required");
  const config = validateRuntimeProbe(
    JSON.parse(await readFile(process.env.EMBODY_M05_RUNTIME_PROBE_CONFIG, "utf8")),
  );
  if (
    config.project !== process.env.EMBODY_MVP_CLOUD_PROJECT ||
    config.prefix !== process.env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX
  )
    throw new Error("Runtime probe config does not match approved project/prefix");
  const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
  const { Client } = require("pg");
  const sql = async (connectionString, role) => {
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    try {
      await client.connect();
      const result = await client.query(`
        SELECT current_user AS name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
          has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database_objects,
          has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public_objects,
          (EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid) OR
           EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid)) AS owns_objects,
          ARRAY(SELECT granted.rolname FROM pg_roles granted
                WHERE granted.rolname <> current_user AND pg_has_role(current_user, granted.oid, 'MEMBER')) AS memberships
        FROM pg_roles r WHERE rolname = current_user
      `);
      assertRuntimeSqlRole(result.rows[0], role);
    } finally {
      await client.end();
    }
  };
  const report = await probeRuntimeIsolation(config, { sql });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...report, timestamp: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Untrusted provider/driver errors can contain connection strings or response bodies.
    console.error("M05 runtime isolation probe failed; no success evidence recorded");
    process.exitCode = 1;
  });
}
