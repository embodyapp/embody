import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  command,
  databaseServiceIdentity,
  evidence,
  main,
  platformConfiguration,
  requireVariables,
  runVitest,
} from "./verification.mjs";

await main("m13", async () => {
  platformConfiguration();
  // M13 provisions per-app databases through a provisioner role (CREATEDB, CREATEROLE only).
  requireVariables(["EMBODY_PROVISIONER_URL"]);
  const image = databaseServiceIdentity();
  const directory = await mkdtemp(join(tmpdir(), "embody-m13-"));
  try {
    command("pnpm", ["build"]);
    command(process.execPath, ["scripts/prepare-platform.mjs"]);
    const report = join(directory, "tests.json");
    const counts = await runVitest(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        // Sequential: the files share one platform database, and recovery after every delivered
        // task is platform-wide (MD12). A file on a test clock years ahead would otherwise wake
        // the other file's in-flight deployments as overdue.
        "--no-file-parallelism",
        // Release stages, promotion switch, rollback, workflow guard, retention and sweep (memory).
        "packages/gateway/test/release.test.ts",
        // Real PostgreSQL: per-app database and migrations, M13.e continuation, promotion races,
        // rollback, retention, migrate() backfill and the SIGKILL matrix.
        "packages/gateway/test/release.postgres.test.ts",
        // Cloud Run, IAM, Secret Manager and Cloud Tasks adapter request shapes; health probe.
        "packages/gateway/test/cloud-release.test.ts",
        // The M12 controller and its real-PostgreSQL matrix, which M13 extends (regression).
        "packages/gateway/test/deployment.test.ts",
        "packages/gateway/test/deployment.postgres.test.ts",
        // Migration compatibility policy and the hosted schema check.
        "packages/storage/test/migrations.test.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      report,
      { ...process.env, EMBODY_PLATFORM_REQUIRED: "true" },
    );
    await evidence("m13", "passed", counts, [image], {
      providers:
        "in-memory and PostgreSQL-table fakes for Cloud Run, IAM, Secret Manager and Cloud Tasks; adapter request shapes only; Cloud Run in the live suite",
      appDatabase:
        "real PostgreSQL per-app database, roles and framework migrations via the provisioner role",
      crashMatrix:
        "after-migration, after-secret-version, after-candidate-create, after-promote (update with prior pins released); plus the M12 matrix",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
