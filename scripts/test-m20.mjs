import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  command,
  containerImageIdentity,
  evidence,
  main,
  postgresConfiguration,
  requireVariables,
  runVitest,
} from "./verification.mjs";

await main("m20", async () => {
  postgresConfiguration();
  requireVariables(["EMBODY_POSTGRES_TEST_CONTAINER"]);
  const image = containerImageIdentity(process.env.EMBODY_POSTGRES_TEST_CONTAINER);
  const directory = await mkdtemp(join(tmpdir(), "embody-m20-"));
  try {
    command("pnpm", ["build"]);
    command(process.execPath, ["scripts/prepare-postgres.mjs"]);
    const report = join(directory, "tests.json");
    const counts = await runVitest(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "packages/host/test/durable.test.ts",
        "packages/host/test/durable.postgres.test.ts",
        // M20.d: the request-only profile is unchanged.
        "packages/host/test/request-only.test.ts",
        "packages/host/test/request-only-postgres.test.ts",
        "packages/host/test/request-only-pool.test.ts",
        "packages/storage/test/request-only.postgres.test.ts",
        "packages/create-embody-app/test",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      report,
      { ...process.env, EMBODY_POSTGRES_REQUIRED: "true" },
    );
    command(process.execPath, ["scripts/test-packed-consumer.mjs"], {
      ...process.env,
      EMBODY_PACKED_PROFILE: "durable",
    });
    await evidence("m20", "passed", counts, [image], {
      packedDurableScaffold: true,
      queue: "in-memory and PostgreSQL-backed fake queues; Cloud Tasks adapter unit-tested only",
      crashMatrix:
        "before-enqueue, after-enqueue-before-commit, after-commit-before-drain, mid-batch, after-effect-before-commit, after-commit-before-acknowledgement, mid-step",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
