// Shared M12 fixtures for the real-PostgreSQL crash matrix. Every fake keeps its state in fixture
// tables of the platform database, on its own connection and outside the store's transactions,
// so it survives a SIGKILLed process the way Cloud Tasks, Cloud Build and Cloud Run would.
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { compileManifest, definePlugin, z } from "@embody/core";
import { BUILD_RECIPE } from "@embody/cloud-contracts";

const { Pool } = createRequire(import.meta.url)("pg");
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const pin = (n) => sha(n);

export const recipe = {
  project: "embody-cloud",
  region: "us-central1",
  builderServiceAccount: "embody-builder@embody-cloud.iam.gserviceaccount.com",
  builderImage: `us-central1-docker.pkg.dev/embody-cloud/platform/builder@${pin("builder")}`,
  dockerImage: `gcr.io/cloud-builders/docker@${pin("docker")}`,
  runtimeImage: `docker.io/library/node:24-bookworm-slim@${pin("node")}`,
  imageRepository: "us-central1-docker.pkg.dev/embody-cloud/builds",
  outputBucket: "embody-build-outputs",
  logsBucket: "embody-build-logs",
};

/** Fixture tables, created by the maintenance role; the platform runtime gets DML only. */
export async function createFixtureTables(migrationUrl, runtimeRole) {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const role = `"${runtimeRole.replaceAll('"', '""')}"`;
  try {
    await pool.query("SELECT pg_advisory_lock(6240412)");
    await pool.query(`CREATE TABLE IF NOT EXISTS m12_fixture_tasks (name text PRIMARY KEY, schedule_at timestamptz NOT NULL, body jsonb NOT NULL, delivered boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE IF NOT EXISTS m12_fixture_builds (id text PRIMARY KEY, tag text NOT NULL, config jsonb NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE IF NOT EXISTS m12_fixture_outputs (path text PRIMARY KEY, bytes bytea NOT NULL);
      CREATE TABLE IF NOT EXISTS m12_fixture_resources (name text PRIMARY KEY, labels jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());`);
    for (const table of [
      "m12_fixture_tasks",
      "m12_fixture_builds",
      "m12_fixture_outputs",
      "m12_fixture_resources",
    ])
      await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${table} TO ${role}`);
  } finally {
    await pool.query("SELECT pg_advisory_unlock(6240412)").catch(() => undefined);
    await pool.end();
  }
}

/** Cloud Tasks semantics: a task is a row written on its own connection; names are unique. */
export function createTableQueue(connectionString) {
  const pool = new Pool({ connectionString, max: 2 });
  return {
    outage: false,
    async enqueue(task) {
      if (this.outage) throw new Error("Task queue unavailable");
      const result = await pool.query(
        "INSERT INTO m12_fixture_tasks (name, schedule_at, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING",
        [task.name, task.scheduleAt, JSON.stringify(task.body)],
      );
      return result.rowCount === 1 ? "created" : "duplicate";
    },
    async due(workspaceId, now) {
      const result = await pool.query(
        "SELECT name, schedule_at, body FROM m12_fixture_tasks WHERE NOT delivered AND body->>'workspaceId' = $1 AND schedule_at <= $2 ORDER BY schedule_at, created_at",
        [workspaceId, now.toISOString()],
      );
      return result.rows.map((row) => ({
        name: row.name,
        scheduleAt: row.schedule_at.toISOString(),
        body: row.body,
      }));
    },
    async pending(workspaceId) {
      const result = await pool.query(
        "SELECT name, schedule_at, body FROM m12_fixture_tasks WHERE NOT delivered AND body->>'workspaceId' = $1 ORDER BY schedule_at",
        [workspaceId],
      );
      return result.rows.map((row) => ({
        name: row.name,
        scheduleAt: row.schedule_at.toISOString(),
        body: row.body,
      }));
    },
    async acknowledge(name) {
      await pool.query("UPDATE m12_fixture_tasks SET delivered = TRUE WHERE name = $1", [name]);
    },
    async lose(workspaceId) {
      await pool.query(
        "UPDATE m12_fixture_tasks SET delivered = TRUE WHERE body->>'workspaceId' = $1",
        [workspaceId],
      );
    },
    close: () => pool.end(),
  };
}

const plugins = [
  definePlugin({
    id: "app",
    version: "0.1.0",
    entities: { card: { schema: z.object({ title: z.string() }) } },
    actions: { ping: { effect: "read", input: z.object({}), handler: () => ({ ok: true }) } },
  }),
];
/** Echo of a Cloud Build record: the honest recipe's outputs for a request-only scaffold. */
function honest(config) {
  const prefix = config.artifacts.objects.location.replace(/^gs:\/\/[^/]+\//, "");
  const manifest = Buffer.from(
    JSON.stringify({
      format: "embody-build-output-v1",
      recipe: BUILD_RECIPE.id,
      nodeVersion: "v24.22.0",
      appId: "my-app",
      appVersion: "0.1.0",
      preflight: { requestOnly: true, durable: true },
      publishes: [],
      catalog: compileManifest(plugins),
    }),
  );
  const sbom = Buffer.from('{"bomFormat":"CycloneDX"}\n');
  const source = config.steps[0].env
    .find((e) => e.startsWith("EMBODY_SOURCE_DIGEST="))
    .split("=")[1];
  return {
    outputs: { [`${prefix}manifest.json`]: manifest, [`${prefix}sbom.json`]: sbom },
    stepOutputs: [
      JSON.stringify({
        recipe: BUILD_RECIPE.id,
        sourceDigest: source,
        treeDigest: pin("tree"),
        lockfileDigest: pin("lock"),
        sbomDigest: sha(sbom),
        packages: 200,
        audit: { critical: 0, high: 0, moderate: 0, low: 0 },
      }),
      "",
      JSON.stringify({ manifestDigest: sha(manifest), outputBytes: 1234 }),
    ],
    images: [{ name: config.images[0], digest: pin(`image-${config.images[0]}`) }],
  };
}

/**
 * A Cloud Build stand-in whose builds finish successfully at once. `afterSubmit` runs after the
 * provider accepted a build and before the caller records it: the crash point between creating
 * a resource and its receipt.
 */
export function createTableBuildProvider(connectionString, afterSubmit = async () => undefined) {
  const pool = new Pool({ connectionString, max: 2 });
  const executed = (value, url) =>
    value.split("$$").join("\u0000").replaceAll("$_SOURCE_URL", url).split("\u0000").join("$");
  return {
    async submit(config) {
      const id = randomUUID();
      const built = honest(config);
      for (const [path, bytes] of Object.entries(built.outputs))
        await pool.query(
          "INSERT INTO m12_fixture_outputs (path, bytes) VALUES ($1, $2) ON CONFLICT (path) DO UPDATE SET bytes = EXCLUDED.bytes",
          [path, bytes],
        );
      await pool.query(
        "INSERT INTO m12_fixture_builds (id, tag, config, status) VALUES ($1, $2, $3::jsonb, 'SUCCESS')",
        [id, config.tags[1], JSON.stringify(config)],
      );
      await afterSubmit();
      return { buildId: id };
    },
    async find(tag) {
      const result = await pool.query(
        "SELECT id FROM m12_fixture_builds WHERE tag = $1 ORDER BY created_at LIMIT 1",
        [tag],
      );
      return result.rows[0]?.id ?? null;
    },
    async get(buildId) {
      const row = (
        await pool.query("SELECT config, status FROM m12_fixture_builds WHERE id = $1", [buildId])
      ).rows[0];
      if (!row) throw new Error("Build not found");
      const { substitutions, ...planned } = row.config;
      const built = honest(row.config);
      return {
        id: buildId,
        status: row.status,
        config: {
          ...planned,
          steps: planned.steps.map((s) => ({
            ...s,
            args: s.args.map((a) => executed(a, substitutions._SOURCE_URL)),
            env: s.env.map((e) => executed(e, substitutions._SOURCE_URL)),
          })),
        },
        images: row.status === "SUCCESS" ? built.images : [],
        stepOutputs: row.status === "SUCCESS" ? built.stepOutputs : [],
      };
    },
    async cancel(buildId) {
      await pool.query(
        "UPDATE m12_fixture_builds SET status = 'CANCELLED' WHERE id = $1 AND status NOT IN ('SUCCESS','FAILURE')",
        [buildId],
      );
    },
    async readOutput(path) {
      const row = (
        await pool.query("SELECT bytes FROM m12_fixture_outputs WHERE path = $1", [path])
      ).rows[0];
      return row ? new Uint8Array(row.bytes) : null;
    },
    async deleteOutputs(prefix) {
      await pool.query("DELETE FROM m12_fixture_outputs WHERE starts_with(path, $1)", [prefix]);
    },
    async readLog() {
      return "";
    },
    async deleteLogs() {},
    async deleteImage() {},
    async listImages() {
      return [];
    },
    async builds(tagPrefix) {
      const result = await pool.query(
        "SELECT id, tag, status FROM m12_fixture_builds WHERE starts_with(tag, $1) ORDER BY created_at",
        [tagPrefix],
      );
      return result.rows;
    },
    async buildsFor(deploymentId) {
      const result = await pool.query(
        "SELECT id, status FROM m12_fixture_builds WHERE config::text LIKE $1",
        [`%EMBODY_DEPLOYMENT_ID=${deploymentId}%`],
      );
      return result.rows;
    },
    close: () => pool.end(),
  };
}

/**
 * Candidate provisioning modelled on M13's contract: named and labelled from platform records,
 * idempotent (a re-run adopts the existing candidate), removed only when its labels match.
 * `afterCreate` is the crash point between creating the candidate and recording it.
 */
export function createTableStages(connectionString, afterCreate = async () => undefined) {
  const pool = new Pool({ connectionString, max: 2 });
  const nameOf = (deployment) => `cand-${deployment.workspaceId}-${deployment.deploymentId}`;
  return {
    nameOf,
    async provision({ deployment, artifact }) {
      const created = await pool.query(
        "INSERT INTO m12_fixture_resources (name, labels) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING",
        [
          nameOf(deployment),
          JSON.stringify({
            workspace: deployment.workspaceId,
            app: deployment.appId,
            deployment: deployment.deploymentId,
            image: artifact.imageReference,
          }),
        ],
      );
      if (created.rowCount === 1) await afterCreate();
      return { ok: true };
    },
    async check({ deployment, artifact }) {
      const row = (
        await pool.query("SELECT labels FROM m12_fixture_resources WHERE name = $1", [
          nameOf(deployment),
        ])
      ).rows[0];
      return row?.labels.image === artifact.imageReference
        ? { ok: true }
        : { ok: false, retryable: false, reason: "CANDIDATE_MISSING" };
    },
    async abandon(deployment) {
      await pool.query(
        "DELETE FROM m12_fixture_resources WHERE name = $1 AND labels->>'workspace' = $2 AND labels->>'deployment' = $3",
        [nameOf(deployment), deployment.workspaceId, deployment.deploymentId],
      );
    },
    async resources(workspaceId) {
      const result = await pool.query(
        "SELECT name, labels FROM m12_fixture_resources WHERE labels->>'workspace' = $1",
        [workspaceId],
      );
      return result.rows;
    },
    close: () => pool.end(),
  };
}

export const requestOnly = {
  profile: "request-only-v1",
  crud: true,
  boundedActions: true,
  workflows: false,
  schedules: false,
  subscriptions: false,
  appToAppRpc: false,
  persistentLocalState: false,
  genui: false,
};
