// M13 fixtures for the real-PostgreSQL crash/race matrix. Candidates (Cloud Run), identities and
// secrets (IAM, Secret Manager) live in fixture tables of the platform database on their own
// connections, so they survive a SIGKILLed worker the way the providers would. The app database
// itself is the real thing: PostgresAppDatabase on the fixture instance as the provisioner role.
import { createRequire } from "node:module";
import { STORAGE_MIGRATIONS, STORAGE_RUNTIME_FUNCTIONS } from "@embody/storage";
import { CandidateSweep, PostgresAppDatabase, ReleaseStages } from "../../dist/index.js";

const { Pool } = createRequire(import.meta.url)("pg");
const quiet = (pool) => {
  pool.on("error", () => undefined);
  return pool;
};
export const PROJECT_NUMBER = "123456789012";
export const platform = {
  prefix: "emt",
  gatewayServiceAccount: "embody-gateway@embody-cloud.iam.gserviceaccount.com",
  controllerServiceAccount: "embody-controller@embody-cloud.iam.gserviceaccount.com",
  jwtIssuer: "https://gateway.example.com",
  jwksUrl: "https://gateway.example.com/.well-known/jwks.json",
  projectNumber: PROJECT_NUMBER,
  region: "us-central1",
};
export const migrations = STORAGE_MIGRATIONS.map((m) => ({
  version: m.version,
  compatibility: m.compatibility,
  postgres: m.postgres,
  ...(m.readerFloor !== undefined ? { readerFloor: m.readerFloor } : {}),
}));

export async function createM13Tables(migrationUrl, runtimeRole) {
  const pool = quiet(new Pool({ connectionString: migrationUrl, max: 1 }));
  const role = `"${runtimeRole.replaceAll('"', '""')}"`;
  try {
    await pool.query("SELECT pg_advisory_lock(6240413)");
    await pool.query(`CREATE TABLE IF NOT EXISTS m13_fixture_candidates (name text PRIMARY KEY, spec jsonb NOT NULL, gets integer NOT NULL DEFAULT 0, invokers jsonb NOT NULL DEFAULT '[]', created integer NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS m13_fixture_accounts (id text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS m13_fixture_secrets (secret text NOT NULL, version serial, payload text NOT NULL, PRIMARY KEY (secret, version));
      CREATE TABLE IF NOT EXISTS m13_fixture_secret_acl (secret text PRIMARY KEY, accessor text NOT NULL);`);
    for (const table of ["m13_fixture_candidates", "m13_fixture_accounts", "m13_fixture_secrets", "m13_fixture_secret_acl"])
      await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${table} TO ${role}`);
    await pool.query(`GRANT USAGE ON SEQUENCE m13_fixture_secrets_version_seq TO ${role}`);
  } finally {
    await pool.query("SELECT pg_advisory_unlock(6240413)").catch(() => undefined);
    await pool.end();
  }
}

const endpointOf = (name) => `https://${name}-${PROJECT_NUMBER}.us-central1.run.app`;
/** Cloud Run semantics: unique names, asynchronous readiness (ready from the second read). */
export function createTableCandidates(connectionString, afterCreate = async () => undefined) {
  const pool = quiet(new Pool({ connectionString, max: 2 }));
  const state = (row) => ({
    name: row.name,
    endpoint: endpointOf(row.name),
    image: row.spec.image,
    status: row.gets > 1 ? "ready" : "pending",
    labels: row.spec.labels,
    annotations: row.spec.annotations,
  });
  return {
    async get(name) {
      const row = (
        await pool.query(
          "UPDATE m13_fixture_candidates SET gets = gets + 1 WHERE name = $1 RETURNING *",
          [name],
        )
      ).rows[0];
      return row ? state(row) : null;
    },
    async create(spec) {
      const created = await pool.query(
        "INSERT INTO m13_fixture_candidates (name, spec) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING",
        [spec.name, JSON.stringify(spec)],
      );
      if (created.rowCount === 1) await afterCreate();
    },
    async setInvokers(name, members) {
      await pool.query("UPDATE m13_fixture_candidates SET invokers = $2::jsonb WHERE name = $1", [
        name,
        JSON.stringify(members),
      ]);
    },
    async remove(name) {
      await pool.query("DELETE FROM m13_fixture_candidates WHERE name = $1", [name]);
    },
    async list() {
      return (await pool.query("SELECT * FROM m13_fixture_candidates")).rows
        .map(state)
        .filter((candidate) => candidate.labels["embody-platform"] === platform.prefix);
    },
    async forWorkspace(workspaceId) {
      return (
        await pool.query(
          "SELECT name, spec, invokers FROM m13_fixture_candidates WHERE spec->'annotations'->>'embody.dev/workspace' = $1 ORDER BY name",
          [workspaceId],
        )
      ).rows;
    },
    close: () => pool.end(),
  };
}

/** IAM and Secret Manager semantics; `afterAddVersion` is the crash point before the role update. */
export function createTableIdentities(connectionString, afterAddVersion = async () => undefined) {
  const pool = quiet(new Pool({ connectionString, max: 2 }));
  const email = (id) => `${id}@embody-cloud.iam.gserviceaccount.com`;
  return {
    async ensureAccount(id) {
      await pool.query("INSERT INTO m13_fixture_accounts (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
      return { email: email(id) };
    },
    async ensureSecret(secret, accessor) {
      await pool.query(
        "INSERT INTO m13_fixture_secret_acl (secret, accessor) VALUES ($1,$2) ON CONFLICT (secret) DO UPDATE SET accessor = EXCLUDED.accessor",
        [secret, accessor],
      );
    },
    async latestSecretVersion(secret) {
      const row = (
        await pool.query("SELECT max(version)::text AS v FROM m13_fixture_secrets WHERE secret = $1", [secret])
      ).rows[0];
      return row?.v ?? null;
    },
    async addSecretVersion(secret, payload) {
      const row = (
        await pool.query(
          "INSERT INTO m13_fixture_secrets (secret, payload) VALUES ($1,$2) RETURNING version::text AS v",
          [secret, payload],
        )
      ).rows[0];
      await afterAddVersion();
      return row.v;
    },
    async payload(secret) {
      return (
        await pool.query(
          "SELECT payload FROM m13_fixture_secrets WHERE secret = $1 ORDER BY version DESC LIMIT 1",
          [secret],
        )
      ).rows[0]?.payload;
    },
    async versions(secret) {
      return Number(
        (await pool.query("SELECT count(*)::int AS n FROM m13_fixture_secrets WHERE secret = $1", [secret]))
          .rows[0].n,
      );
    },
    async ensureWakeQueue(queue, invoker) {
      return { queue: `projects/embody-cloud/locations/us-central1/queues/${queue}`, invokerEmail: email(invoker) };
    },
    close: () => pool.end(),
  };
}

/** The real per-app database on the fixture instance, through the provisioner role. */
export function appDatabase(provisionerUrl, afterMigration = async () => undefined) {
  const url = new URL(provisionerUrl);
  const database = new PostgresAppDatabase({
    provisionerUrl,
    runtimeHost: url.host,
    migrations,
    runtimeFunctions: STORAGE_RUNTIME_FUNCTIONS,
  });
  const apply = database.applyNextMigration.bind(database);
  database.applyNextMigration = async (names, target) => {
    const result = await apply(names, target);
    if (result === "applied") await afterMigration();
    return result;
  };
  return database;
}

export function releaseStages({ store, candidates, identities, database, outputs }) {
  return new ReleaseStages({
    platform,
    candidates,
    identities,
    database,
    health: { ready: async () => true },
    outputs,
    store,
    migrations,
  });
}
export function candidateSweep(store, candidates) {
  return new CandidateSweep({ prefix: platform.prefix, candidates, store });
}
