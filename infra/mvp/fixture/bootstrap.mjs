// Operator only. Random credentials stay in a mode-0600 /tmp file, never state/logs/Git.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { createCloudRunAppProvisioner } from "../provider/cloud-run.mjs";
import { PostgresGatewayStore } from "../../../packages/gateway/dist/index.js";
import { PostgresStorage } from "../../../packages/storage/dist/index.js";
const { fetch, AbortSignal } = globalThis;
const exec = promisify(execFile);
const project = "embody-cloud",
  prefix = "embody-test-m05",
  region = "us-central1";
const path = "/tmp/embody-m05-private/fixture.json";
export async function operator() {
  const token = (await exec("gcloud", ["auth", "print-access-token"])).stdout.trim();
  const api = async (url, method = "GET", body) => {
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error(
        JSON.stringify({
          operatorApiFailure: response.status,
          service: new URL(url).host,
          fields: (error.error?.details ?? []).flatMap((detail) =>
            (detail.fieldViolations ?? []).map((value) => value.field),
          ),
        }),
      );
      throw new Error(`Operator API failed ${response.status}; body suppressed`);
    }
    return response.status === 204 ? {} : response.json();
  };
  return { api, token };
}
export async function loadPrivate() {
  return JSON.parse(await readFile(path, "utf8"));
}
export async function savePrivate(data) {
  await mkdir("/tmp/embody-m05-private", { recursive: true, mode: 0o700 });
  await chmod("/tmp/embody-m05-private", 0o700);
  await writeFile(path, JSON.stringify(data), { mode: 0o600 });
}
const password = () => randomBytes(32).toString("base64url");
async function main() {
  if (
    process.env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true" ||
    process.env.EMBODY_MVP_CLOUD_PROJECT !== project ||
    process.env.EMBODY_MVP_CLOUD_BUDGET_USD !== "10"
  )
    throw new Error("Approval required");
  const { api, token } = await operator();
  let data;
  try {
    data = await loadPrivate();
  } catch {
    const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const one = key(),
      two = key();
    data = {
      project,
      prefix,
      region,
      admin: password(),
      passwords: Object.fromEntries(
        ["runtime", "migrator", "other", "other_mig", "platform", "platform_mig"].map((name) => [
          name,
          password(),
        ]),
      ),
      privateKeys: [
        one.privateKey.export({ type: "pkcs8", format: "pem" }),
        two.privateKey.export({ type: "pkcs8", format: "pem" }),
      ],
      publicKeys: [one, two].map((pair, i) => ({
        ...pair.publicKey.export({ format: "jwk" }),
        alg: "ES256",
        use: "sig",
        kid: `m05-key-${i + 1}`,
      })),
    };
    await savePrivate(data);
  }
  let passwordOperation = await api(
    `https://sqladmin.googleapis.com/sql/v1beta4/projects/${project}/instances/${prefix}-postgres/users?name=postgres`,
    "PUT",
    { name: "postgres", password: data.admin },
  );
  for (let attempt = 0; passwordOperation.status !== "DONE" && attempt < 30; attempt++) {
    await delay(1000);
    passwordOperation = await api(
      `https://sqladmin.googleapis.com/sql/v1beta4/projects/${project}/operations/${passwordOperation.name}`,
    );
  }
  if (passwordOperation.status !== "DONE" || passwordOperation.error)
    throw new Error("Admin credential setup failed");
  const provisioner = createCloudRunAppProvisioner({
    project,
    region,
    prefix,
    gatewayEmail: `${prefix}-gateway@${project}.iam.gserviceaccount.com`,
    accessToken: () => Promise.resolve(token),
  });
  data.apps = [];
  for (const scope of [
    { workspaceId: "ws_m05fixture01", appId: "kanban" },
    { workspaceId: "ws_m05fixture02", appId: "email" },
  ])
    data.apps.push({ ...scope, ...(await provisioner.prepare(scope)) });
  const { Client } = createRequire(
    new URL("../../../packages/gateway/package.json", import.meta.url),
  )("pg");
  const admin = new Client({
    host: "127.0.0.1",
    port: 15432,
    database: "postgres",
    user: "postgres",
    password: data.admin,
    connectionTimeoutMillis: 10000,
  });
  await admin.connect();
  try {
    for (const [suffix, pwd] of Object.entries(data.passwords)) {
      const role = `embody_test_${suffix}`;
      if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount)
        await admin.query(
          `CREATE ROLE ${role} LOGIN PASSWORD '${pwd}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`,
        );
    }
    await admin.query("REVOKE CONNECT ON DATABASE postgres, template1, template0 FROM PUBLIC");
    for (const [db, mig, runtime] of [
      ["embody_test_app", "migrator", "runtime"],
      ["embody_test_other_db", "other_mig", "other"],
      ["embody_test_platform_db", "platform_mig", "platform"],
    ]) {
      await admin.query(`GRANT embody_test_${mig} TO postgres`);
      if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [db])).rowCount)
        await admin.query(`CREATE DATABASE ${db} OWNER embody_test_${mig}`);
      await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${db} TO embody_test_${runtime}`);
      const scoped = new Client({
        host: "127.0.0.1",
        port: 15432,
        database: db,
        user: "postgres",
        password: data.admin,
      });
      await scoped.connect();
      try {
        await scoped.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
        await scoped.query(`GRANT USAGE,CREATE ON SCHEMA public TO embody_test_${mig}`);
        await scoped.query(`GRANT USAGE ON SCHEMA public TO embody_test_${runtime}`);
      } finally {
        await scoped.end();
      }
      await admin.query(`REVOKE embody_test_${mig} FROM postgres`);
    }
  } finally {
    await admin.end();
  }
  const dsn = (suffix, db, port = 5432) =>
    `postgresql://embody_test_${suffix}:${data.passwords[suffix]}@127.0.0.1:${port}/${db}`;
  data.dsns = {
    runtime: dsn("runtime", "embody_test_app"),
    other: dsn("other", "embody_test_other_db"),
    platform: dsn("platform", "embody_test_platform_db"),
  };
  for (const [db, mig, runtime, storageType] of [
    ["embody_test_app", "migrator", "runtime", "app"],
    ["embody_test_other_db", "other_mig", "other", "app"],
    ["embody_test_platform_db", "platform_mig", "platform", "platform"],
  ]) {
    const connectionString = dsn(mig, db, 15432);
    if (storageType === "app") {
      const storage = new PostgresStorage({ connectionString });
      await storage.ensureSchema();
      await storage.close();
    } else {
      const store = new PostgresGatewayStore(connectionString);
      await store.migrate();
      await store.close();
    }
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const tables = (
        await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'embody_%'",
        )
      ).rows;
      for (const { tablename } of tables)
        await client.query(
          `GRANT ${tablename === "embody_schema_migrations" ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE"} ON TABLE public.${tablename} TO embody_test_${runtime}`,
        );
    } finally {
      await client.end();
    }
  }
  const add = async (name, value) =>
    api(
      `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}:addVersion`,
      "POST",
      { payload: { data: Buffer.from(value).toString("base64") } },
    );
  if (!data.secretVersions) {
    data.secretVersions = {};
    data.secretVersions.signer1 = (await add(`${prefix}-signer`, data.privateKeys[0])).name;
    data.secretVersions.signer2 = (await add(`${prefix}-signer`, data.privateKeys[1])).name;
    data.secretVersions.platform = (await add(`${prefix}-platform-db`, data.dsns.platform)).name;
    data.secretVersions.runtime = (await add(data.apps[0].databaseSecret, data.dsns.runtime)).name;
    data.secretVersions.other = (await add(data.apps[1].databaseSecret, data.dsns.other)).name;
  }
  await savePrivate(data);
  console.log(
    JSON.stringify({
      bootstrap: "passed",
      databaseCount: 3,
      runtimeRoles: 3,
      secretPayloadsLogged: false,
    }),
  );
}
if (process.argv[1]?.endsWith("/bootstrap.mjs"))
  main().catch(() => {
    console.error("Fixture bootstrap failed; credential/driver details suppressed");
    process.exitCode = 1;
  });
