// Runs ONLY as an M09 Cloud Run job in us-central1, next to the Cloud SQL instance, so test
// timing and connection latency reflect an app in the region rather than the operator's laptop.
// Connects through the Cloud SQL Auth Proxy with the job's own identity. Prints one
// `embody.m09.sqlSuite` JSON line with gate outcomes and counts; never URLs or passwords.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, URL } from "node:url";
import { latencySummary } from "./sql.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** The fixture URLs arrive as one JSON secret; every URL must target the local proxy. */
export function parseSqlSecret(text) {
  const value = JSON.parse(text);
  const keys = [
    "EMBODY_POSTGRES_URL",
    "EMBODY_POSTGRES_MIGRATION_URL",
    "EMBODY_POSTGRES_OTHER_URL",
    "EMBODY_PLATFORM_URL",
    "EMBODY_PLATFORM_MIGRATION_URL",
  ];
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]:us-central1:embody-test-[a-z0-9-]+$/.test(
      value?.instance ?? "",
    ) ||
    keys.some((key) => {
      try {
        const url = new URL(value.urls?.[key]);
        return url.hostname !== "127.0.0.1" || url.port !== "5432";
      } catch {
        return true;
      }
    })
  )
    throw new Error("SQL suite secret must name an embody-test instance and loopback proxy URLs");
  return value;
}

async function portOpen(port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const open = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (open) return;
    await delay(1000);
  }
  throw new Error("Cloud SQL Auth Proxy did not start");
}

function run(program, args, env) {
  return new Promise((resolve) => {
    // The runners redact credentials from their own child output before printing it.
    const child = spawn(program, args, { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function gate(name) {
  try {
    const report = JSON.parse(await readFile(`/tmp/m09-evidence/${name}.json`, "utf8"));
    return {
      status: report.status,
      counts: report.counts,
      postgresVersion: report.postgresVersion ?? null,
      image: report.images?.[0] ?? null,
    };
  } catch {
    return { status: "missing", counts: null };
  }
}

export async function runSqlSuite(secret) {
  const proxy = spawn(
    "/usr/local/bin/cloud-sql-proxy",
    ["--port=5432", "--address=127.0.0.1", secret.instance],
    {
      stdio: "ignore",
    },
  );
  try {
    await portOpen(5432);
    await mkdir("/tmp/m09-evidence", { recursive: true });
    await mkdir("/tmp/corepack-bin", { recursive: true });
    const env = {
      ...process.env,
      ...secret.urls,
      EMBODY_POSTGRES_PROVIDER_INSTANCE: secret.instance,
      EMBODY_TEST_EVIDENCE_DIR: "/tmp/m09-evidence",
      COREPACK_HOME: "/tmp/corepack",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      PATH: `/tmp/corepack-bin:${process.env.PATH}`,
    };
    delete env.EMBODY_M09_SQL;
    delete env.EMBODY_POSTGRES_TEST_CONTAINER;
    // The runners call pnpm; the image ships Node's corepack, which provides the pinned pnpm.
    const corepack = await run(
      "corepack",
      ["enable", "--install-directory", "/tmp/corepack-bin"],
      env,
    );
    const storageExit = await run(process.execPath, ["scripts/test-postgres.mjs"], env);
    const gatewayExit = await run(process.execPath, ["scripts/test-gateway-store.mjs"], env);
    const { Client } = createRequire(new URL("packages/storage/package.json", pathToFileURL(ROOT)))(
      "pg",
    );
    const samples = [];
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      const client = new Client({
        connectionString: secret.urls.EMBODY_POSTGRES_URL,
        connectionTimeoutMillis: 15000,
      });
      try {
        await client.connect();
        await client.query("SELECT 1");
        samples.push(performance.now() - started);
      } catch {
        // A failed connection is reported by the sample count.
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    return {
      message: "embody.m09.sqlSuite",
      corepack,
      storage: { exit: storageExit, ...(await gate("postgres")) },
      gatewayStore: { exit: gatewayExit, ...(await gate("gateway-store")) },
      latency: samples.length === 20 ? latencySummary(samples) : { trials: samples.length },
    };
  } finally {
    proxy.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSqlSuite(parseSqlSecret(process.env.EMBODY_M09_SQL ?? "null"))
    .then((report) => {
      console.log(JSON.stringify(report));
      if (report.storage.exit !== 0 || report.gatewayStore.exit !== 0) process.exitCode = 1;
    })
    .catch(() => {
      console.log(
        JSON.stringify({
          message: "embody.m09.sqlSuite",
          error: "suite failed; details suppressed",
        }),
      );
      process.exitCode = 1;
    });
}
