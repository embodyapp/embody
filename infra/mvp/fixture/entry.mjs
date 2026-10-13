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
  const socketDsn = (value) => {
    const url = new URL(value);
    if (process.env.EMBODY_SQL_SOCKET === "true")
      url.searchParams.set("host", `/cloudsql/${instance}`);
    return url.href;
  };
  for (const name of ["DATABASE_URL", "GATEWAY_PLATFORM_DATABASE_URL"])
    if (process.env[name]) process.env[name] = socketDsn(process.env[name]);
  if (process.env.EMBODY_SQL_SOCKET !== "true") {
    stage = "proxy-start";
    proxy = spawn(
      "/usr/local/bin/cloud-sql-proxy",
      ["--address=127.0.0.1", "--port=5432", instance],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proxy.on("error", () => {});
    const proxyDiagnostic = (chunk) => {
      const status = /\b(401|403|404|429|500|503)\b/.exec(String(chunk))?.[1];
      if (status) console.error(JSON.stringify({ proxyFailureStatus: Number(status) }));
    };
    proxy.stdout.on("data", proxyDiagnostic);
    proxy.stderr.on("data", proxyDiagnostic);
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
  }
  if (
    ["runtime-probe", "gateway-probe"].includes(mode) &&
    process.env.EMBODY_M05_PHASE !== "external"
  ) {
    stage = "job-egress-warmup";
    // Live connection-test measured 52s startup; Direct VPC jobs need bounded egress warmup.
    await delay(60000);
  }
  // Direct VPC egress may become usable AFTER the local proxy starts listening.
  // Retry only bounded transport failures; SQL authentication/authorization errors fail closed.
  const dsn = process.env.DATABASE_URL ?? process.env.GATEWAY_PLATFORM_DATABASE_URL;
  if (dsn) {
    stage = "sql-readiness";
    const { Client } = createRequire(
      new URL("../../../packages/gateway/package.json", import.meta.url),
    )("pg");
    for (let attempt = 0; attempt < 15; attempt++) {
      const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10000 });
      try {
        await client.connect();
        await client.query("SELECT 1");
        break;
      } catch (error) {
        if (
          attempt === 14 ||
          !(
            ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH"].includes(error.code) ||
            [
              "Connection terminated unexpectedly",
              "Connection terminated due to connection timeout",
              "timeout expired",
              "timeout exceeded when trying to connect",
            ].includes(error.message)
          )
        )
          throw error;
        await delay(2000);
      } finally {
        await client.end().catch(() => {});
      }
    }
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
      proxy?.kill();
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
    const sql = createRuntimeSqlProbe(Client);
    report = await probeRuntimeIsolation(config, {
      sql: (dsn, role, mode) => sql(socketDsn(dsn), role, mode),
    });
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
  proxy?.kill();
}
main().catch((error) => {
  proxy?.kill();
  console.error(
    JSON.stringify({
      fixtureFailure: true,
      stage,
      errorType: error?.name ?? "unknown",
      probeFailure:
        /^(Runtime metadata|Probe is not running|Own fixture|Effective permission query|Runtime has prohibited|Own-secret|Non-gateway|Runtime probe requires|Runtime probe needs|All fixture workload|Fixture provenance|Live |Valid live|Gateway |Invalid rotation|Rotation watcher|Old[- ]key|New key|Authoritative key|External ingress|Metadata token|Old key authority)/.test(
          error?.message ?? "",
        )
          ? error.message
          : undefined,
      errorTags: ["timeout", "sasl", "ssl", "connect", "terminated", "password", "client"].filter(
        (tag) => String(error?.message).toLowerCase().includes(tag),
      ),
      errorCategory: [
        "Connection terminated unexpectedly",
        "permission denied for schema public",
        "PostgreSQL storage migrations must be applied by maintenance identity before hosted startup",
      ].includes(error?.message)
        ? error.message
        : undefined,
      systemCode:
        typeof error?.code === "string" && /^[A-Z0-9_]{3,40}$/.test(error.code)
          ? error.code
          : undefined,
      sqlCode:
        typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
          ? error.code
          : undefined,
    }),
  );
  process.exitCode = 1;
});
