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

await main("m08", async () => {
  postgresConfiguration();
  requireVariables(["EMBODY_POSTGRES_TEST_CONTAINER"]);
  const image = containerImageIdentity(process.env.EMBODY_POSTGRES_TEST_CONTAINER);
  const directory = await mkdtemp(join(tmpdir(), "embody-m08-"));
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
        "packages/core/test",
        "packages/host/test",
        "packages/create-embody-app/test",
        "packages/storage/test/request-only.postgres.test.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      report,
      { ...process.env, EMBODY_POSTGRES_REQUIRED: "true" },
    );
    command(process.execPath, ["scripts/test-packed-consumer.mjs"], {
      ...process.env,
      EMBODY_PACKED_PROFILE: "request-only",
    });
    await evidence("m08", "passed", counts, [image], {
      packedRequestOnlyScaffold: true,
      outboxRetention: "zero-generated-notifications; custom-publish-rejected",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
