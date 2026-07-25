/**
 * Database connections.
 *
 * We use two roles on purpose (Decision D1 — tenancy):
 *   - the OWNER role ("admin") runs migrations, seeding, and any control-plane work.
 *     It owns the tables and therefore BYPASSES row-level security.
 *   - a non-owner APP role handles request-path queries. It is SUBJECT to RLS, so a
 *     bug in application code can never leak another tenant's rows — the database
 *     refuses.
 *
 * `withTenant` sets the tenant for a transaction; every app-path query must run
 * through it.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

export type Sql = postgres.Sql;
export type Database = ReturnType<typeof drizzle>;

export interface DbHandle {
  /** Raw postgres.js tagged-template client. */
  sql: Sql;
  /** Drizzle ORM instance for typed queries. */
  db: Database;
  /** Close the pool. */
  close: () => Promise<void>;
}

export function createDb(connectionString: string, opts: postgres.Options<{}> = {}): DbHandle {
  const sql = postgres(connectionString, {
    max: 10,
    // Silence routine "already exists, skipping" NOTICEs from idempotent DDL.
    onnotice: () => {},
    ...opts,
  });
  const db = drizzle(sql);
  return { sql, db, close: () => sql.end({ timeout: 5 }) };
}

/**
 * Run `fn` inside a transaction scoped to a tenant. Sets `app.current_org` (and
 * optionally `app.current_user`) as transaction-local settings that the RLS policies
 * read via current_setting('app.current_org'). Use the APP-role handle here.
 */
export async function withTenant<T>(
  sql: Sql,
  orgId: string,
  userId: string | null,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${orgId}, true)`;
    await tx`select set_config('app.current_user', ${userId ?? ""}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}
