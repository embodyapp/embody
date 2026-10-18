import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  command,
  evidence,
  main,
  postgresConfiguration,
  platformConfiguration,
  root,
  runVitest,
} from "./verification.mjs";

await main("mvp", async () => {
  postgresConfiguration();
  platformConfiguration();
  command("pnpm", ["test:verification"]);
  command("pnpm", ["test:postgres"]);
  command("pnpm", ["test:gateway-store"]);
  const directory = await mkdtemp(join(tmpdir(), "embody-mvp-report-"));
  let passed = 0;
  const suites = {};
  try {
    // Add later milestone integration suites explicitly here as their implementations land.
    for (const pkg of ["cloud-contracts", "auth", "host", "mcp", "gateway", "cli"]) {
      const report = join(directory, `${pkg}.json`);
      suites[pkg] = await runVitest(
        "pnpm",
        [
          "--filter",
          `@embody/${pkg}`,
          "test",
          "--reporter=default",
          "--reporter=json",
          `--outputFile=${report}`,
        ],
        report,
      );
      passed += suites[pkg].passed;
    }
    const dbEvidence = JSON.parse(
      await readFile(
        resolve(
          root,
          process.env.EMBODY_TEST_EVIDENCE_DIR ?? ".artifacts/verification",
          "postgres.json",
        ),
        "utf8",
      ),
    );
    const platformEvidence = JSON.parse(
      await readFile(
        resolve(
          root,
          process.env.EMBODY_TEST_EVIDENCE_DIR ?? ".artifacts/verification",
          "gateway-store.json",
        ),
        "utf8",
      ),
    );
    suites["gateway-store"] = platformEvidence.counts;
    passed += platformEvidence.counts.passed;
    suites.postgres = dbEvidence.counts;
    passed += dbEvidence.counts.passed;
    await evidence("mvp", "passed", { passed, failed: 0, skipped: 0 }, dbEvidence.images, {
      suites,
      postgresVersion: dbEvidence.postgresVersion,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
