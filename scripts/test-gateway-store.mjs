import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  platformConfiguration,
  databaseServiceIdentity,
  command,
  runVitest,
  evidence,
} from "./verification.mjs";
await main("gateway-store", async () => {
  platformConfiguration();
  const image = databaseServiceIdentity();
  const directory = await mkdtemp(join(tmpdir(), "embody-platform-report-"));
  try {
    command("pnpm", ["build"]);
    command(process.execPath, ["scripts/prepare-platform.mjs"]);
    const report = join(directory, "tests.json");
    const counts = await runVitest(
      "pnpm",
      [
        "--filter",
        "@embody/gateway",
        "test:postgres",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      report,
      { ...process.env, EMBODY_PLATFORM_REQUIRED: "true" },
    );
    await evidence("gateway-store", "passed", counts, [image]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
