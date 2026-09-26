#!/usr/bin/env node
// Disposable, loopback-only reference stack. Not a production gateway installer.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envFile = resolve(root, ".env.gateway.local");
const composeFile = resolve(root, "docker-compose.e2e.yml");
const localOverride = resolve(root, "docker-compose.gateway-local.yml");
const command = process.argv[2] ?? "up";
const secret = () => randomBytes(32).toString("hex");

function run(program, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${program} exited with code ${code}`)),
    );
  });
}

function compose(...args) {
  return run("docker", [
    "compose",
    "--project-name",
    "embody-local",
    "--env-file",
    envFile,
    "--file",
    composeFile,
    "--file",
    localOverride,
    ...args,
  ]);
}

async function environment(create) {
  if (create) {
    const data = [
      "# Generated local-only credentials. Do not use this stack on an untrusted network.",
      "POSTGRES_USER=embody",
      `POSTGRES_PASSWORD=${secret()}`,
      "POSTGRES_DB=embody",
      "GATEWAY_PORT=4400",
      "KANBAN_PORT=8081",
      "EMAIL_PORT=8082",
      `GATEWAY_API_KEY=${secret()}`,
      `E2E_SECOND_API_KEY=${secret()}`,
      "GATEWAY_JWT_ISSUER=embody-local-gateway",
      `GATEWAY_JWT_SECRET=${secret()}`,
      `KANBAN_REGISTRATION_SECRET=${secret()}`,
      `EMAIL_REGISTRATION_SECRET=${secret()}`,
      `EVENT_DELIVERY_SECRET=${secret()}`,
      "E2E_ORG_ID=local-org",
      "",
    ].join("\n");
    try {
      await writeFile(envFile, data, { flag: "wx", mode: 0o600 });
      console.log(`Created ${envFile} (gitignored; keep private).`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const text = await readFile(envFile, "utf8");
  const env = Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  for (const key of ["GATEWAY_PORT", "GATEWAY_API_KEY"]) {
    if (!env[key]) throw new Error(`Missing ${key} in ${envFile}`);
  }
  return env;
}

async function waitForApps(url, token) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(`${url}/api/catalog`, {
        headers: { authorization: `Bearer ${token}`, "cache-control": "no-cache" },
        signal: globalThis.AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const catalog = await response.json();
        // A successful catalog alone can mean the apps have not registered yet.
        if (
          Array.isArray(catalog) &&
          ["kanban", "email"].every((id) => catalog.some((app) => app.appId === id))
        )
          return;
      }
    } catch {
      /* containers may still be booting */
    }
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 1000));
  }
  throw new Error(
    "Timed out waiting for Kanban and Email registration. Check: pnpm gateway:dev:logs",
  );
}

try {
  if (command === "help") {
    console.log("Usage: pnpm gateway:dev | pnpm gateway:dev:down | pnpm gateway:dev:logs");
  } else if (command === "up") {
    const env = await environment(true);
    await compose("up", "--build", "-d");
    const url = `http://127.0.0.1:${env.GATEWAY_PORT}`;
    console.log("Waiting for both example apps to register...");
    await waitForApps(url, env.GATEWAY_API_KEY);
    console.log(`Gateway ready: ${url} (health: ${url}/health; MCP: ${url}/mcp)`);
    console.log("Try the CLI:");
    console.log(
      `  EMBODY_GATEWAY_URL=${url} EMBODY_TOKEN="$(node scripts/gateway-dev.mjs token)" npx -y @embody/cli apps list`,
    );
    console.log("Stop and remove disposable data with: pnpm gateway:dev:down");
  } else if (command === "token") {
    const env = await environment(false);
    process.stdout.write(env.GATEWAY_API_KEY);
  } else if (command === "down") {
    await environment(false);
    await compose("down", "--volumes", "--remove-orphans");
  } else if (command === "logs") {
    await environment(false);
    await compose("logs", "--tail", "100");
  } else {
    throw new Error(`Unknown command: ${command}. Run pnpm gateway:dev:help`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
