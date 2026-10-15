import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { join } from "node:path";
import {
  command,
  evidence,
  databaseServiceIdentity,
  main,
  runVitest,
  postgresConfiguration,
} from "./verification.mjs";

await main("postgres", async () => {
  const config = postgresConfiguration(); // Fail before builds or child tests when required config is absent.
  const image = databaseServiceIdentity();
  const directory = await mkdtemp(join(tmpdir(), "embody-postgres-report-"));
  const report = join(directory, "tests.json");
  try {
    command("pnpm", ["build"]);
    command(process.execPath, ["scripts/prepare-postgres.mjs"]);
    const env = {
      ...process.env,
      EMBODY_POSTGRES_REQUIRED: "true",
      EMBODY_POSTGRES_SKIP_SCHEMA: "true",
    };
    const counts = await runVitest(
      "pnpm",
      [
        "--filter",
        "@embody/storage",
        "test:postgres",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      report,
      env,
    );
    const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))(
      "pg",
    );
    const pool = new Pool({ connectionString: config.runtime.href });
    let postgresVersion;
    try {
      postgresVersion = (
        await pool.query("SELECT current_setting('server_version_num')::integer AS version")
      ).rows[0].version;
    } finally {
      await pool.end();
    }
    await evidence("postgres", "passed", counts, [image], { postgresVersion });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
