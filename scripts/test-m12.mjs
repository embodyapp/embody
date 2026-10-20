import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  command,
  databaseServiceIdentity,
  evidence,
  main,
  platformConfiguration,
  runVitest,
} from "./verification.mjs";

await main("m12", async () => {
  platformConfiguration();
  const image = databaseServiceIdentity();
  const directory = await mkdtemp(join(tmpdir(), "embody-m12-"));
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
        // Controller, store conformance (memory), ingress and malicious-task cases.
        "packages/gateway/test/deployment.test.ts",
        // Real PostgreSQL: early/rolled-back tasks, cross-pool races and the SIGKILL matrix.
        "packages/gateway/test/deployment.postgres.test.ts",
        // M11 hardening (unplanned provider fields, N3 freeze, abandon) and admission regression.
        "packages/gateway/test/build-admission.test.ts",
        // Shared queue adapter and task ingress, plus the M20 users of it.
        "packages/host/test/tasks.test.ts",
        "packages/host/test/durable.test.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      report,
      { ...process.env, EMBODY_PLATFORM_REQUIRED: "true" },
    );
    await evidence("m12", "passed", counts, [image], {
      queue: "in-memory and PostgreSQL-table fake queues; Cloud Tasks adapter request shape only",
      buildProvider: "in-memory and PostgreSQL-table fakes; Cloud Build in the live suite",
      crashMatrix:
        "after-enqueue-before-commit, after-commit-before-response, lost-task, after-claim, after-build-submit-before-receipt, after-provision-create-before-receipt, after-complete-before-ack, after-promote-before-ack",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
