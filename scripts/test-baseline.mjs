import { command, evidence, imageIdentity, main } from "./verification.mjs";

await main("baseline", async () => {
  command("pnpm", ["build"]);
  command(process.execPath, ["scripts/test-packed-consumer.mjs"]);
  command("pnpm", ["test:e2e"]);
  const images = [];
  for (const name of ["embody-e2e-apps", "postgres:16-alpine"]) {
    images.push(imageIdentity(name));
  }
  // These are journey counts, not a fabricated unit-test count.
  await evidence(
    "baseline",
    "passed",
    { packedConsumerJourneys: 1, distributedJourneys: 1, failed: 0, skipped: 0 },
    images,
  );
});
