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

await main("m19", async () => {
  postgresConfiguration();
  requireVariables(["EMBODY_POSTGRES_TEST_CONTAINER"]);
  const image = containerImageIdentity(process.env.EMBODY_POSTGRES_TEST_CONTAINER);
  const directory = await mkdtemp(join(tmpdir(), "embody-m19-"));
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
        "packages/core/test/workflows.test.ts",
        "packages/core/test/workflow-limits.test.ts",
        "packages/testing/test/workflows.test.ts",
        "packages/host/test/workflows.postgres.test.ts",
        "packages/gateway/test/workflow-journey.postgres.test.ts",
        "packages/cli/test",
        // Workers claim every due step in the database, as in production where one database
        // belongs to one app; suites with different workflow plugins must not overlap.
        "--no-file-parallelism",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      report,
      { ...process.env, EMBODY_POSTGRES_REQUIRED: "true" },
    );
    await evidence("m19", "passed", counts, [image], {
      runtimeRoleClaims:
        "runtime role without BYPASSRLS; narrowly granted SECURITY DEFINER claim function",
      crashMatrix: "after-claim, before-effect, after-effect, after-complete, mid-compensation",
      surfaces: "packed CLI binary and official MCP client through the gateway",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
