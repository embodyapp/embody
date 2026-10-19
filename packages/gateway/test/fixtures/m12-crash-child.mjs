// Child process for the M12 crash matrix: submits one deployment or handles one task against the
// built gateway package and real PostgreSQL, and stops at M12_CRASH_AT, where the parent kills
// it with SIGKILL.
import { submissionFingerprint } from "@embody/cloud-contracts";
import {
  BuildAdmission,
  DeploymentController,
  MemorySourceObjectStore,
  PostgresGatewayStore,
  deploymentWakeHook,
} from "../../dist/index.js";
import {
  createTableBuildProvider,
  createTableQueue,
  createTableStages,
  recipe,
} from "./m12-fixtures.mjs";

const point = process.env.M12_CRASH_AT;
const offset = Number(process.env.M12_CLOCK_OFFSET ?? "0");
const clock = { now: () => new Date(Date.now() + offset) };
const pause = async (name) => {
  if (name !== point) return;
  process.stdout.write(`PAUSED ${name}\n`);
  await new Promise(() => undefined);
};
const url = process.env.EMBODY_PLATFORM_URL;
const store = new PostgresGatewayStore(url);
const tasks = createTableQueue(url);
const queue = {
  enqueue: async (task) => {
    const outcome = await tasks.enqueue(task);
    // Inside the store transaction, before COMMIT.
    await pause("after-enqueue");
    return outcome;
  },
};
if (process.env.M12_MODE === "submit") {
  const submission = JSON.parse(process.env.M12_SUBMISSION);
  await store.submitDeployment(
    {
      submission,
      fingerprint: submissionFingerprint(submission),
      actorId: "alice",
      now: clock.now(),
    },
    deploymentWakeHook(queue),
  );
  await pause("after-commit");
} else {
  const provider = createTableBuildProvider(url, () => pause("after-build-submit"));
  const stages = createTableStages(url, () => pause("after-provision-create"));
  const watched = Object.create(store);
  watched.claimDeployment = async (...args) => {
    const result = await store.claimDeployment(...args);
    if (result.decision.kind === "claimed") await pause("after-claim");
    return result;
  };
  watched.completeDeployment = async (...args) => {
    const next = await store.completeDeployment(...args);
    await pause(next.state === "active" ? "after-promote" : "after-complete");
    return next;
  };
  const controller = new DeploymentController({
    store: watched,
    queue,
    builds: new BuildAdmission({
      store,
      provider,
      recipe,
      sources: new MemorySourceObjectStore({ clock }),
      clock,
    }),
    stages,
    clock,
  });
  const result = await controller.handle(JSON.parse(process.env.M12_TASK));
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  await pause("before-ack");
  await provider.close();
  await stages.close();
}
process.stdout.write("DONE\n");
await tasks.close();
await store.close();
