// M09 Cloud SQL qualification helpers: per-app database/role bootstrap, connection storm,
// cold-connection latency and restore checks. Pure functions are unit-tested; the live run
// supplies real pg clients through the Cloud SQL Auth Proxy. Never against customer data.
import { randomBytes } from "node:crypto";

export const SQL_LIMITS = Object.freeze({
  runtimeConnectionLimit: 5,
  migratorConnectionLimit: 2,
  statementTimeoutMs: 30_000,
  idleInTransactionTimeoutMs: 30_000,
});
const IDENT = /^embody_[a-z0-9_]{1,40}$/;
const ident = (name) => {
  if (!IDENT.test(name)) throw new Error("Unsafe SQL identifier");
  return `"${name}"`;
};
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** Fresh random fixture passwords. Kept in a mode-0600 file outside the repo, never logged. */
export function fixturePasswords(roles) {
  return Object.fromEntries(roles.map((role) => [role, randomBytes(24).toString("base64url")]));
}

const DATABASES = Object.freeze([
  ["embody_test", "embody_migrator", "embody_runtime"],
  ["embody_other", "embody_other", null],
  ["embody_platform", "embody_platform_migrator", "embody_platform_runtime"],
]);

/**
 * Statements run as the Cloud SQL `postgres` admin (cloudsqlsuperuser, not a real superuser).
 * The M03 role/database layout plus provider limits: per-role CONNECTION LIMIT, statement and
 * idle-in-transaction timeouts, PUBLIC revoked on every database and schema.
 *
 * Live finding (2026-10-18): a non-owner's REVOKE of PUBLIC is silently a no-op, which left
 * app B's database open to app A. So the admin takes owner membership (PostgreSQL 16 also needs
 * it for CREATE DATABASE ... OWNER), runs every owner-scoped statement under SET ROLE, and only
 * releases the membership after the schemas are done (`releaseStatements`).
 */
export function bootstrapStatements(passwords, limits = SQL_LIMITS) {
  const roles = {
    embody_migrator: limits.migratorConnectionLimit,
    embody_runtime: limits.runtimeConnectionLimit,
    embody_other: limits.runtimeConnectionLimit,
    embody_platform_migrator: limits.migratorConnectionLimit,
    embody_platform_runtime: limits.runtimeConnectionLimit,
  };
  const statements = [];
  for (const [role, connections] of Object.entries(roles)) {
    if (!passwords[role]) throw new Error("Missing fixture password");
    statements.push(
      `CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(passwords[role])} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT ${Number(connections)}`,
      `ALTER ROLE ${ident(role)} SET statement_timeout = ${Number(limits.statementTimeoutMs)}`,
      `ALTER ROLE ${ident(role)} SET idle_in_transaction_session_timeout = ${Number(limits.idleInTransactionTimeoutMs)}`,
    );
  }
  for (const [database, owner, runtime] of DATABASES)
    statements.push(
      `GRANT ${ident(owner)} TO CURRENT_USER`,
      `CREATE DATABASE ${ident(database)} OWNER ${ident(owner)}`,
      `SET ROLE ${ident(owner)}`,
      `REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC`,
      ...(runtime ? [`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(runtime)}`] : []),
      "RESET ROLE",
    );
  return statements;
}
/** Per-database schema statements, run connected to each database as its owner. */
export function schemaStatements() {
  return Object.fromEntries(
    DATABASES.map(([database, owner, runtime]) => [
      database,
      [
        `SET ROLE ${ident(owner)}`,
        "REVOKE ALL ON SCHEMA public FROM PUBLIC",
        `GRANT USAGE, CREATE ON SCHEMA public TO ${ident(owner)}`,
        ...(runtime ? [`GRANT USAGE ON SCHEMA public TO ${ident(runtime)}`] : []),
        "RESET ROLE",
      ],
    ]),
  );
}
/**
 * The M03 conformance suites open many connections (20 concurrent cold boots), so the fixture
 * runs them without role limits and applies the per-app limit before the storm.
 */
export function stormLimitStatements(limits = SQL_LIMITS) {
  return [
    `ALTER ROLE "embody_runtime" CONNECTION LIMIT ${Number(limits.runtimeConnectionLimit)}`,
    `ALTER ROLE "embody_platform_runtime" CONNECTION LIMIT ${Number(limits.runtimeConnectionLimit)}`,
  ];
}
/** After the schemas: the admin gives up owner membership again. */
export function releaseStatements() {
  return DATABASES.map(([, owner]) => `REVOKE ${ident(owner)} FROM CURRENT_USER`);
}

export function percentile(samples, p) {
  if (!samples.length) throw new Error("No latency samples");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
export function latencySummary(samples) {
  if (samples.length < 20) throw new Error("At least 20 cold connection samples required");
  return {
    trials: samples.length,
    p50Ms: Math.round(percentile(samples, 50)),
    p95Ms: Math.round(percentile(samples, 95)),
    maxMs: Math.round(Math.max(...samples)),
  };
}

/**
 * Storm: `attempts` concurrent runtime connections against a role limit. Passes only if
 * exactly `limit` succeed, every refusal is 53300 (too many connections for role), the
 * platform role still connects during the storm, and all connections were released.
 */
export function evaluateStorm({ results, limit, platformDuringStorm, releasedAfter }) {
  const succeeded = results.filter((result) => result.ok).length;
  const refusals = results.filter((result) => !result.ok);
  const pass =
    results.length > limit &&
    succeeded === limit &&
    refusals.every((result) => result.code === "53300") &&
    platformDuringStorm === true &&
    releasedAfter === true;
  return {
    attempts: results.length,
    limit,
    succeeded,
    refused: refusals.length,
    refusalCodes: [...new Set(refusals.map((result) => result.code ?? "none"))],
    platformDuringStorm,
    releasedAfter,
    pass,
  };
}

/** Cross-database CONNECT negatives must be real 42501 denials, not timeouts or bad passwords. */
export function evaluateConnectDenials(results) {
  const pass = results.length > 0 && results.every((result) => result.code === "42501");
  return { cases: results.map(({ target, code }) => ({ target, code })), pass };
}

/** Restore: checksum after restore equals the backup point; the post-backup marker is gone. */
export function evaluateRestore({
  checksumAtBackup,
  checksumAfterRestore,
  markerAfterRestore,
  seconds,
}) {
  return {
    seconds,
    checksumMatches: Boolean(checksumAtBackup) && checksumAtBackup === checksumAfterRestore,
    markerGone: markerAfterRestore === false,
    pass:
      Boolean(checksumAtBackup) &&
      checksumAtBackup === checksumAfterRestore &&
      markerAfterRestore === false,
  };
}

export const FIXTURE_ROLES = Object.freeze([
  "embody_migrator",
  "embody_runtime",
  "embody_other",
  "embody_platform_migrator",
  "embody_platform_runtime",
]);

/**
 * Removes the fixture. The Cloud SQL admin is not a superuser and gave up owner membership
 * after bootstrap, so it takes membership back (it created the roles, so it holds ADMIN) before
 * dropping each database. Only roles that still exist are touched; repeatable.
 */
export function dropStatements(existingRoles) {
  const exists = new Set(existingRoles.filter((role) => FIXTURE_ROLES.includes(role)));
  return [
    ...DATABASES.flatMap(([database, owner]) => [
      ...(exists.has(owner) ? [`GRANT ${ident(owner)} TO CURRENT_USER`] : []),
      `DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`,
    ]),
    ...FIXTURE_ROLES.filter((role) => exists.has(role)).map((role) => `DROP ROLE ${ident(role)}`),
  ];
}
