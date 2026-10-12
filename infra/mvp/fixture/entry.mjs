import { spawn } from "node:child_process";
import { URL } from "node:url";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { createAppHost } from "../../../packages/host/dist/index.js";
import { fixtureApp } from "./app.mjs";
import {
  validateRuntimeProbe,
  probeRuntimeIsolation,
  createRuntimeSqlProbe,
} from "../../../scripts/probe-m05-runtime.mjs";
const mode = process.argv[2] ?? process.env.EMBODY_FIXTURE_MODE;
let proxy;
let stage = "connection-validation";
async function main() {
  const instance = process.env.EMBODY_SQL_CONNECTION;
  if (!/^[a-z][a-z0-9-]+:us-central1:embody-test-[a-z0-9-]+$/.test(instance ?? ""))
    throw new Error("Approved SQL connection required");
  stage = "proxy-start";
  proxy = spawn(
    "/usr/local/bin/cloud-sql-proxy",
    ["--address=127.0.0.1", "--port=5432", instance],
    { stdio: "ignore" },
  );
  proxy.on("error", () => {});
  for (let attempt = 0; attempt < 30; attempt++) {
    const ready = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: 5432 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) break;
    if (attempt === 29) throw new Error("SQL proxy unavailable");
    await delay(1000);
  }
  stage = `start-${mode}`;
  if (mode === "gateway") {
    await import("../../../apps/gateway/dist/src/index.js");
    return;
  }
  if (["kanban", "email"].includes(mode)) {
    const runtime = await createAppHost(fixtureApp(mode));
    await runtime.start();
    console.log(
      JSON.stringify({ fixture: mode, ready: true, sourceSha: process.env.EMBODY_SOURCE_SHA }),
    );
    process.once("SIGTERM", () => {
      proxy.kill();
      void runtime.stop();
    });
    return;
  }
  if (
    process.env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true" ||
    Number(process.env.EMBODY_MVP_CLOUD_BUDGET_USD) !== 10
  )
    throw new Error("Fixture budget required");
  const config = validateRuntimeProbe(JSON.parse(process.env.EMBODY_M05_CONFIG));
  if (
    config.project !== process.env.EMBODY_MVP_CLOUD_PROJECT ||
    config.prefix !== process.env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX ||
    config.candidateSha !== process.env.EMBODY_SOURCE_SHA
  )
    throw new Error("Fixture provenance/scope mismatch");
  let report;
  if (mode === "runtime-probe") {
    const { Client } = createRequire(
      new URL("../../../packages/gateway/package.json", import.meta.url),
    )("pg");
    report = await probeRuntimeIsolation(config, { sql: createRuntimeSqlProbe(Client) });
  } else if (mode === "gateway-probe") {
    const { runGatewayProbe } = await import("./gateway-probe.mjs");
    report = await runGatewayProbe(config);
  } else throw new Error("Unknown fixture mode");
  console.log(
    JSON.stringify({
      ...report,
      sourceSha: process.env.EMBODY_SOURCE_SHA,
      timestamp: new Date().toISOString(),
    }),
  );
  proxy.kill();
}
main().catch((error) => {
  proxy?.kill();
  console.error(
    JSON.stringify({
      fixtureFailure: true,
      stage,
      errorType: error?.name ?? "unknown",
      sqlCode:
        typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
          ? error.code
          : undefined,
    }),
  );
  process.exitCode = 1;
});
