import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";

export const root = resolve(import.meta.dirname, "..");
export function requireVariables(names, env = process.env) {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);
}
export function postgresConfiguration(env = process.env) {
  requireVariables(
    ["EMBODY_POSTGRES_URL", "EMBODY_POSTGRES_MIGRATION_URL", "EMBODY_POSTGRES_OTHER_URL"],
    env,
  );
  const urls = [
    env.EMBODY_POSTGRES_URL,
    env.EMBODY_POSTGRES_MIGRATION_URL,
    env.EMBODY_POSTGRES_OTHER_URL,
  ].map((value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Invalid PostgreSQL test URL (value redacted)");
    }
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.username ||
      !url.hostname ||
      url.pathname.length < 2
    )
      throw new Error("Invalid PostgreSQL test URL (value redacted)");
    return url;
  });
  const [runtime, migration, other] = urls;
  if (
    runtime.host !== migration.host ||
    runtime.pathname !== migration.pathname ||
    decodeURIComponent(runtime.username) === decodeURIComponent(migration.username)
  )
    throw new Error("Runtime and migration roles must differ on the same test database");
  if (other.host !== runtime.host || other.pathname === runtime.pathname)
    throw new Error("Other-app test database must be distinct on the same PostgreSQL server");
  return { runtime, migration, other };
}
export function platformConfiguration(env = process.env) {
  requireVariables(["EMBODY_PLATFORM_URL", "EMBODY_PLATFORM_MIGRATION_URL"], env);
  const app = postgresConfiguration(env);
  const config = postgresConfiguration({
    ...env,
    EMBODY_POSTGRES_URL: env.EMBODY_PLATFORM_URL,
    EMBODY_POSTGRES_MIGRATION_URL: env.EMBODY_PLATFORM_MIGRATION_URL,
    EMBODY_POSTGRES_OTHER_URL: app.runtime.href,
  });
  const appRoles = [app.runtime, app.migration, app.other].map((url) =>
    decodeURIComponent(url.username),
  );
  if (
    config.runtime.pathname === app.other.pathname ||
    [config.runtime, config.migration].some((url) =>
      appRoles.includes(decodeURIComponent(url.username)),
    )
  )
    throw new Error("Platform database/roles must be distinct from app fixtures");
  return config;
}
export function redact(text, env = process.env) {
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        value && /(?:PASSWORD|TOKEN|SECRET|POSTGRES.*URL|PLATFORM.*URL|CREDENTIAL)/u.test(key),
    )
    .flatMap(([, value]) => {
      try {
        const url = new URL(value);
        const password = decodeURIComponent(url.password);
        return [
          value,
          value.trim(),
          url.href,
          url.password,
          password,
          encodeURIComponent(password),
          JSON.stringify(password).slice(1, -1),
        ].filter(Boolean);
      } catch {
        return [value];
      }
    })
    .sort((a, b) => b.length - a.length);
  return secrets
    .reduce((output, value) => output.replaceAll(value, "[REDACTED]"), String(text))
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gu, "[REDACTED]");
}
export function command(program, args, env = process.env) {
  const result = spawnSync(program, args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write(redact(result.stdout ?? "", env));
  process.stderr.write(redact(result.stderr ?? "", env));
  if (result.error || result.status !== 0)
    throw new Error(
      `Verification command failed: ${program} (exit ${result.status ?? "unavailable"})`,
    );
  return result.stdout;
}
export class SuiteFailure extends Error {
  constructor(message, counts) {
    super(message);
    this.counts = counts;
  }
}
export function countsFromVitest(report) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const suite of report.testResults ?? [])
    for (const test of suite.assertionResults ?? []) {
      if (test.status === "passed") counts.passed++;
      else if (test.status === "failed") counts.failed++;
      else counts.skipped++;
    }
  if (!report.success || !counts.passed || counts.failed || counts.skipped)
    throw new SuiteFailure(
      `Mandatory suite did not pass without skips: ${JSON.stringify(counts)}`,
      counts,
    );
  return counts;
}
export async function runVitest(program, args, reportFile, env = process.env) {
  let commandError;
  try {
    command(program, args, env);
  } catch (error) {
    commandError = error;
  }
  let report;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch {
    throw commandError ?? new Error("Mandatory suite did not produce a test report");
  }
  const counts = countsFromVitest(report);
  if (commandError) throw new SuiteFailure(commandError.message, counts);
  return counts;
}
export function imageIdentity(name) {
  const result = spawnSync(
    "docker",
    ["image", "inspect", name, "--format", "{{json .Id}} {{json .RepoDigests}}"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("Could not record verification image hashes");
  const [id, ...digests] = result.stdout.trim().split(" ");
  return { name, id: JSON.parse(id), repoDigests: JSON.parse(digests.join(" ")) };
}
export function containerImageIdentity(container) {
  const result = spawnSync(
    "docker",
    ["container", "inspect", container, "--format", "{{json .Id}} {{json .Image}}"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("Could not record PostgreSQL service image identity");
  const [containerId, imageId] = result.stdout
    .trim()
    .split(" ")
    .map((value) => JSON.parse(value));
  return { ...imageIdentity(imageId), name: "postgres-service", containerId };
}
export async function evidence(gate, status, counts = null, images = [], details = {}) {
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
  const hash = async (path) =>
    createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex");
  const directory = resolve(
    root,
    process.env.EMBODY_TEST_EVIDENCE_DIR ?? ".artifacts/verification",
  );
  await mkdir(directory, { recursive: true });
  const report = {
    gate,
    status,
    timestamp: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain", "--untracked-files=normal")),
    node: process.version,
    lockfileSha256: await hash("pnpm-lock.yaml"),
    schemaSourceSha256: await hash("packages/storage/src/index.ts"),
    platformSchemaSourceSha256: await hash("packages/gateway/src/store.ts"),
    postgresFixtureSha256: await hash("test/postgres/init.sql"),
    counts,
    images,
    ...details,
  };
  await writeFile(resolve(directory, `${gate}.json`), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`Sanitized verification evidence written for ${gate}`);
}
export async function main(gate, operation) {
  try {
    if (![22, 24].includes(Number(process.versions.node.split(".")[0])))
      throw new Error("Verification gates require Node 22 or 24");
    await operation();
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : "Verification failed"));
    await evidence(gate, "failed", error instanceof SuiteFailure ? error.counts : null).catch(() =>
      console.error("Could not write verification evidence"),
    );
    process.exitCode = 1;
  }
}
