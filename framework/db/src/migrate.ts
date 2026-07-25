/**
 * A small SQL-first migration runner.
 *
 * Why SQL-first (not drizzle-kit generate): RLS policies, FORCE ROW LEVEL SECURITY,
 * GIN indexes, and role grants can't be expressed through Drizzle's schema DSL. We
 * author migrations as plain versioned .sql files (full control) and mirror the
 * tables in Drizzle purely for typed queries. Migrations run with the OWNER role.
 *
 * Each plugin owns a directory of `NNNN_name.sql` files. They run in filename order,
 * once each, tracked in `embody._migrations`. After a plugin's migrations apply, we
 * auto-grant CRUD on its schema to the app role so request-path queries work under
 * RLS (Decision D1/D6).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "./client.ts";

/** The non-owner role the api-server uses for request-path (RLS-subject) queries. */
export const APP_ROLE = "embody_app";

/** Advisory-lock key for the migration phase. Arbitrary, but must stay stable. */
const MIGRATION_LOCK_KEY = 4_051_982_071;

/**
 * Run `fn` holding a database-wide advisory lock, so only one process migrates at a
 * time. More than one deployable can share a database — `pnpm dev` boots both the
 * reference deployment and `deploy/acme` — and they bootstrap the same roles and
 * re-grant the same catalog schemas on every boot. Postgres fails a concurrent
 * GRANT / ALTER DEFAULT PRIVILEGES on one object with "tuple concurrently updated",
 * so the whole phase is serialised rather than made per-statement idempotent.
 *
 * The lock is session-scoped, which means it must be taken on a single reserved
 * connection: `fn` still uses the pool, and callers that don't take the lock are not
 * excluded — every path that migrates goes through here.
 */
export async function withMigrationLock<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  const conn = await sql.reserve();
  try {
    await conn`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      return await fn();
    } finally {
      await conn`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}

/**
 * One-time bootstrap: the meta schema, the migration ledger, and the app role.
 * Idempotent. Runs with the owner role before any plugin migrations.
 */
export async function bootstrap(sql: Sql, appRolePassword = "embody_app"): Promise<void> {
  await sql.unsafe(`
    create schema if not exists embody;
    create table if not exists embody._migrations (
      id text primary key,
      plugin text not null,
      applied_at timestamptz not null default now()
    );
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} login password '${appRolePassword}';
      end if;
    end $$;
    grant usage on schema embody to ${APP_ROLE};
  `);
}

/** Grant CRUD on a plugin's schema (and its future tables) to the app role. */
async function grantSchemaToApp(sql: Sql, schema: string): Promise<void> {
  await sql.unsafe(`
    grant usage on schema "${schema}" to ${APP_ROLE};
    grant select, insert, update, delete on all tables in schema "${schema}" to ${APP_ROLE};
    grant usage, select on all sequences in schema "${schema}" to ${APP_ROLE};
    alter default privileges in schema "${schema}"
      grant select, insert, update, delete on tables to ${APP_ROLE};
    alter default privileges in schema "${schema}"
      grant usage, select on sequences to ${APP_ROLE};
  `);
}

/**
 * Apply all not-yet-applied .sql migrations in `dir` for `pluginId`, then grant the
 * plugin's schema to the app role. Each file runs in its own transaction.
 */
export async function runMigrations(
  sql: Sql,
  pluginId: string,
  dir: string,
  schema: string,
): Promise<string[]> {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (
      await sql<{ id: string }[]>`select id from embody._migrations where plugin = ${pluginId}`
    ).map((r) => r.id),
  );

  const ran: string[] = [];
  for (const file of files) {
    const id = `${pluginId}/${file}`;
    if (applied.has(id)) continue;
    const contents = await readFile(join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`insert into embody._migrations (id, plugin) values (${id}, ${pluginId})`;
    });
    ran.push(id);
  }

  await grantSchemaToApp(sql, schema);
  return ran;
}
