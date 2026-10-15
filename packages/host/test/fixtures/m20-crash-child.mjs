// Child process for the M20 crash matrix: runs one action or one drain against the built
// packages and stops at M20_CRASH_AT, where the parent kills it with SIGKILL.
import { Kernel } from "@embody/core";
import { PostgresStorage } from "@embody/storage";
import { createDurableDrain, wakingStorage } from "../../dist/index.js";
import {
  APP_ID,
  createEffects,
  createPlugins,
  createTableQueue,
  principal,
} from "./m20-durable.mjs";

const point = process.env.M20_CRASH_AT;
const offset = Number(process.env.M20_CLOCK_OFFSET ?? "0");
const clock = { now: () => new Date(Date.now() + offset) };
const pause = async (name) => {
  if (name !== point) return;
  process.stdout.write(`PAUSED ${name}\n`);
  await new Promise(() => undefined);
};
const url = process.env.EMBODY_POSTGRES_URL;
const tasks = createTableQueue(url);
const queue = {
  enqueue: async (task) => {
    const outcome = await tasks.enqueue(task);
    await pause("after-enqueue");
    return outcome;
  },
};
const storage = wakingStorage(
  new PostgresStorage({ connectionString: url, max: 5 }, { schemaMode: "verify" }),
  { appId: APP_ID, queue, clock },
);
const effects = createEffects(url);
const kernel = new Kernel({
  profile: "durable",
  plugins: createPlugins(effects, pause),
  storage,
  now: clock.now,
});
await kernel.boot();
if (process.env.M20_MODE === "action") {
  await kernel.execute(
    "shop.order",
    { orderId: process.env.M20_ORDER },
    { principal: principal(process.env.M20_ORG) },
  );
} else {
  const drain = createDurableDrain({ appId: APP_ID, storage, kernel, queue, clock });
  await drain.drain(JSON.parse(process.env.M20_TASK));
  await pause("before-acknowledge");
}
process.stdout.write("DONE\n");
await effects.close();
await tasks.close();
await kernel.stop();
