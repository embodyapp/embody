// Child process for the M13 crash matrix: handles one deployment task with the real release stages
// (table-backed candidates and identities, the real per-app database) against the built gateway
// package and real PostgreSQL, and stops at M13_CRASH_AT, where the parent kills it with SIGKILL.
import {
  BuildAdmission,
  DeploymentController,
  MemorySourceObjectStore,
  PostgresGatewayStore,
  deploymentWakeHook,
} from "../../dist/index.js";
import { createTableBuildProvider, createTableQueue, recipe } from "./m12-fixtures.mjs";
import {
  appDatabase,
  createTableCandidates,
  createTableIdentities,
  releaseStages,
} from "./m13-fixtures.mjs";

const point = process.env.M13_CRASH_AT;
const offset = Number(process.env.M13_CLOCK_OFFSET ?? "0");
const clock = { now: () => new Date(Date.now() + offset) };
const pause = async (name) => {
  if (name !== point) return;
  process.stdout.write(`PAUSED ${name}\n`);
  await new Promise(() => undefined);
};
const url = process.env.EMBODY_PLATFORM_URL;
const store = new PostgresGatewayStore(url);
const tasks = createTableQueue(url);
const provider = createTableBuildProvider(url);
const candidates = createTableCandidates(url, () => pause("after-candidate-create"));
const identities = createTableIdentities(url, () => pause("after-secret-version"));
const database = appDatabase(process.env.EMBODY_PROVISIONER_URL, () => pause("after-migration"));
const watched = Object.create(store);
watched.completeDeployment = async (...args) => {
  const next = await store.completeDeployment(...args);
  await pause(next.state === "active" ? "after-promote" : "after-complete");
  return next;
};
const controller = new DeploymentController({
  store: watched,
  queue: { enqueue: (task) => tasks.enqueue(task) },
  builds: new BuildAdmission({
    store,
    provider,
    recipe,
    sources: new MemorySourceObjectStore({ clock }),
    clock,
  }),
  stages: releaseStages({ store, candidates, identities, database, outputs: provider }),
  clock,
});
void deploymentWakeHook;
const result = await controller.handle(JSON.parse(process.env.M13_TASK));
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
process.stdout.write("DONE\n");
await Promise.all([provider.close(), candidates.close(), identities.close(), tasks.close(), store.close()]);
