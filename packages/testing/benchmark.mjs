import { hrtime } from "node:process";
import { definePlugin, z } from "@embody/core";
import { createTestHarness } from "@embody/testing";

const samples = Number(process.env.EMBODY_BENCHMARK_SAMPLES ?? 100);
const plugin = definePlugin({
  id: "benchmark",
  version: "1.0.0",
  actions: { ping: { input: z.object({}), handler: () => "ok" } },
});

await (await createTestHarness({ plugins: [plugin] })).close();
const times = [];
for (let index = 0; index < samples; index += 1) {
  const start = hrtime.bigint();
  await (await createTestHarness({ plugins: [plugin] })).close();
  times.push(Number(hrtime.bigint() - start) / 1_000_000);
}
times.sort((left, right) => left - right);
const percentile = (p) => times[Math.ceil(times.length * p) - 1];
console.log(
  JSON.stringify({ samples, medianMs: percentile(0.5), p95Ms: percentile(0.95) }, null, 2),
);
