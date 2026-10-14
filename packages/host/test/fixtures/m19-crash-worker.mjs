// Child process for the M19 crash matrix: runs one worker tick against the built packages and
// stops at M19_CRASH_AT, where the parent kills it with SIGKILL.
import { Kernel } from "@embody/core";
import { PostgresStorage } from "@embody/storage";
import { WorkflowWorker } from "../../dist/index.js";
import { createEffects, createPlugins } from "./m19-workflows.mjs";

const point = process.env.M19_CRASH_AT;
const pause = async (name) => {
  if (name !== point) return;
  process.stdout.write(`PAUSED ${name}\n`);
  await new Promise(() => undefined);
};
const storage = new PostgresStorage(
  { connectionString: process.env.EMBODY_POSTGRES_URL, max: 3 },
  { schemaMode: "verify" },
);
const withCrashPoints = (tx) => ({
  ...tx,
  workflows: {
    ...tx.workflows,
    completeStep: async (input) => {
      await tx.workflows.completeStep(input);
      await pause("after-complete");
    },
  },
});
const crashing = {
  dialect: storage.dialect,
  ensureSchema: () => storage.ensureSchema(),
  close: () => storage.close(),
  transaction: async (orgId, callback) => {
    const value = await storage.transaction(orgId, (tx) => callback(withCrashPoints(tx)));
    if (orgId === "system") await pause("after-claim");
    return value;
  },
};
const effects = createEffects(process.env.EMBODY_POSTGRES_URL);
const kernel = new Kernel({ plugins: createPlugins(effects, pause), storage: crashing });
await kernel.boot();
const worker = new WorkflowWorker({
  storage: crashing,
  kernel,
  workerId: "crashing-worker",
  cancelPollMs: 0,
});
await worker.tick();
process.stdout.write("TICKED\n");
await effects.close();
await kernel.stop();
