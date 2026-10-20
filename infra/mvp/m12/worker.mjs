// M12 qualification deployment worker: the real controller (`@embody/gateway`) on Cloud Run,
// woken only by the controller queue's OIDC tasks. Real platform database (Cloud SQL socket),
// real Cloud Build, GCS read signer and Cloud Tasks; candidates are fixture rows in the platform
// database because real provisioning is M13. Qualification-only fault injection: a row in
// `m12_fixture_faults` makes the process exit at a named point once, as a crash would.
import { createRequire } from "node:module";
import { URL } from "node:url";
import { platformInvokerVerifier } from "../../../packages/auth/dist/index.js";
import {
  BuildAdmission,
  CloudBuildProvider,
  DeploymentController,
  GcsSourceObjectStore,
  PostgresGatewayStore,
  createDeploymentWorker,
} from "../../../packages/gateway/dist/index.js";
import { cloudTasksQueue } from "../../../packages/host/dist/index.js";
import { createTableStages } from "../../../packages/gateway/test/fixtures/m12-fixtures.mjs";

const env = process.env;
const required = [
  "EMBODY_PLATFORM_URL",
  "EMBODY_M12_RECIPE",
  "EMBODY_M12_SOURCE_BUCKET",
  "EMBODY_M12_READ_SIGNER",
  "EMBODY_M12_QUEUE",
  "EMBODY_M12_TASK_URL",
  "EMBODY_M12_INVOKER",
  "EMBODY_SQL_CONNECTION",
];
for (const name of required) if (!env[name]) throw new Error(`Missing ${name}`);
if (!/^[a-z][a-z0-9-]+:us-central1:embody-test-[a-z0-9-]+$/.test(env.EMBODY_SQL_CONNECTION))
  throw new Error("Approved SQL connection required");
const dsn = new URL(env.EMBODY_PLATFORM_URL);
// Cloud Run mounts the instance socket; `EMBODY_SQL_SOCKET=false` keeps the DSN host (local smoke).
if (env.EMBODY_SQL_SOCKET !== "false")
  dsn.searchParams.set("host", `/cloudsql/${env.EMBODY_SQL_CONNECTION}`);
const url = dsn.href;

const { Pool } = createRequire(new URL("../../../packages/gateway/package.json", import.meta.url))(
  "pg",
);
/** An idle connection the server or proxy drops is an 'error' event; without a listener it kills
 * the process (live run 4ab5cd). Queries still reject, and the pool reconnects. */
const quiet = (pool) => {
  pool.on("error", () => undefined);
  return pool;
};
const faults = quiet(new Pool({ connectionString: url, max: 1 }));
/** Exits the process at `point` once per deployment when the suite planted that fault. */
async function crashAt(point, deploymentId) {
  if (!deploymentId) return;
  const fired = await faults.query(
    "UPDATE m12_fixture_faults SET fired = now() WHERE deployment_key = $1 AND point = $2 AND fired IS NULL RETURNING point",
    [deploymentId, point],
  );
  if (fired.rowCount) {
    console.log(JSON.stringify({ type: "embody.m12.fault", point }));
    process.exit(70);
  }
}

const recipe = JSON.parse(env.EMBODY_M12_RECIPE);
const store = new PostgresGatewayStore(url);
const cloudBuild = new CloudBuildProvider({ recipe, timeoutMs: 15_000 });
const provider = new Proxy(cloudBuild, {
  get(target, key) {
    if (key === "submit")
      return async (config) => {
        const result = await target.submit(config);
        const step = config.steps[0]?.env ?? [];
        const deployment = step
          .find((e) => e.startsWith("EMBODY_DEPLOYMENT_ID="))
          ?.slice("EMBODY_DEPLOYMENT_ID=".length);
        await crashAt("after-build-submit", deployment);
        return result;
      };
    const value = target[key];
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const watched = Object.create(store);
watched.claimDeployment = async (...args) => {
  const result = await store.claimDeployment(...args);
  if (result.decision.kind === "claimed") await crashAt("after-claim", args[0].deploymentId);
  return result;
};
watched.completeDeployment = async (...args) => {
  const next = await store.completeDeployment(...args);
  if (next.state === "active") await crashAt("after-promote", next.deploymentId);
  return next;
};
const queue = cloudTasksQueue({
  queue: env.EMBODY_M12_QUEUE,
  url: env.EMBODY_M12_TASK_URL,
  audience: env.EMBODY_M12_TASK_URL,
  invokerEmail: env.EMBODY_M12_INVOKER,
});
const controller = new DeploymentController({
  store: watched,
  queue,
  builds: new BuildAdmission({
    store,
    provider,
    recipe,
    sources: new GcsSourceObjectStore({
      bucket: env.EMBODY_M12_SOURCE_BUCKET,
      // No uploads here; the upload signer must differ from the read signer and is never used.
      signerEmail: env.EMBODY_M12_READ_SIGNER.replace("-r-", "-u-"),
      readSignerEmail: env.EMBODY_M12_READ_SIGNER,
      timeoutMs: 10_000,
    }),
  }),
  stages: createTableStages(url),
  log: (record) => console.log(JSON.stringify(record)),
});
const app = createDeploymentWorker({
  controller,
  verifier: platformInvokerVerifier({
    audience: env.EMBODY_M12_TASK_URL,
    invokerEmail: env.EMBODY_M12_INVOKER,
  }),
});
await app.listen({ host: "0.0.0.0", port: Number(env.PORT ?? 8080) });
