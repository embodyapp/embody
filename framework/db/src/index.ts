/** @embody/db — connections, tenant scoping, and the SQL migration runner. */
export { createDb, withTenant } from "./client.ts";
export type { DbHandle, Sql, Database } from "./client.ts";
export { bootstrap, runMigrations, APP_ROLE } from "./migrate.ts";
