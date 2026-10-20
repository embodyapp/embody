// M13 qualification deployment worker: the real controller (`@embody/gateway`) on Cloud Run with
// the real M13 release stages: Cloud Run candidates, runtime identities and database secrets
// (Google adapters), per-app databases and framework migrations on the run's Cloud SQL instance
// through the provisioner role, health checks with the worker's own identity, and the candidate
// sweep. Woken only by the controller queue's OIDC tasks, as in M12. No fault injection.
import { URL } from "node:url";
import { platformInvokerVerifier } from "../../../packages/auth/dist/index.js";
import {
  BuildAdmission,
  CandidateSweep,
  CloudBuildProvider,
  DeploymentController,
  GcsSourceObjectStore,
  GoogleReleaseProvider,
  PostgresAppDatabase,
  PostgresGatewayStore,
  ReleaseStages,
  cloudRunHealthProbe,
  createDeploymentWorker,
} from "../../../packages/gateway/dist/index.js";
import { cloudTasksQueue } from "../../../packages/host/dist/index.js";
import {
  STORAGE_MIGRATIONS,
  STORAGE_RUNTIME_FUNCTIONS,
} from "../../../packages/storage/dist/index.js";

const env = process.env;
const required = [
  "EMBODY_PLATFORM_URL",
  "EMBODY_PROVISIONER_URL",
  "EMBODY_M12_RECIPE",
  "EMBODY_M12_SOURCE_BUCKET",
  "EMBODY_M12_READ_SIGNER",
  "EMBODY_M12_QUEUE",
  "EMBODY_M12_TASK_URL",
  "EMBODY_M12_INVOKER",
  "EMBODY_SQL_CONNECTION",
  "EMBODY_M13_PLATFORM",
  "EMBODY_M13_PROJECT_NUMBER",
];
for (const name of required) if (!env[name]) throw new Error(`Missing ${name}`);
if (!/^[a-z][a-z0-9-]+:us-central1:embody-test-[a-z0-9-]+$/.test(env.EMBODY_SQL_CONNECTION))
  throw new Error("Approved SQL connection required");
const socket = `/cloudsql/${env.EMBODY_SQL_CONNECTION}`;
const viaSocket = (value) => {
  const dsn = new URL(value);
  if (env.EMBODY_SQL_SOCKET !== "false") dsn.searchParams.set("host", socket);
  return dsn.href;
};
const platform = JSON.parse(env.EMBODY_M13_PLATFORM);
const project = env.EMBODY_SQL_CONNECTION.split(":")[0];
const recipe = JSON.parse(env.EMBODY_M12_RECIPE);
const store = new PostgresGatewayStore(viaSocket(env.EMBODY_PLATFORM_URL));
const builds = new CloudBuildProvider({ recipe, timeoutMs: 15_000 });
const google = new GoogleReleaseProvider({
  project,
  region: "us-central1",
  projectNumber: env.EMBODY_M13_PROJECT_NUMBER,
  prefix: platform.prefix,
});
const migrations = STORAGE_MIGRATIONS.map((m) => ({
  version: m.version,
  compatibility: m.compatibility,
  postgres: m.postgres,
  ...(m.readerFloor !== undefined ? { readerFloor: m.readerFloor } : {}),
}));
const database = new PostgresAppDatabase({
  provisionerUrl: viaSocket(env.EMBODY_PROVISIONER_URL),
  runtimeHost: socket,
  migrations,
  runtimeFunctions: STORAGE_RUNTIME_FUNCTIONS,
});
const queue = cloudTasksQueue({
  queue: env.EMBODY_M12_QUEUE,
  url: env.EMBODY_M12_TASK_URL,
  audience: env.EMBODY_M12_TASK_URL,
  invokerEmail: env.EMBODY_M12_INVOKER,
});
const controller = new DeploymentController({
  store,
  queue,
  builds: new BuildAdmission({
    store,
    provider: builds,
    recipe,
    sources: new GcsSourceObjectStore({
      bucket: env.EMBODY_M12_SOURCE_BUCKET,
      signerEmail: env.EMBODY_M12_READ_SIGNER.replace("-r-", "-u-"),
      readSignerEmail: env.EMBODY_M12_READ_SIGNER,
      timeoutMs: 10_000,
    }),
  }),
  stages: new ReleaseStages({
    platform: { ...platform, cloudSqlConnection: env.EMBODY_SQL_CONNECTION },
    candidates: google,
    identities: google,
    database,
    health: cloudRunHealthProbe({ serviceAccountEmail: platform.controllerServiceAccount }),
    outputs: builds,
    store,
    migrations,
  }),
  sweeper: new CandidateSweep({ prefix: platform.prefix, candidates: google, store }),
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
