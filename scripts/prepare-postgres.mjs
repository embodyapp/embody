import { createRequire } from "node:module";
import { URL } from "node:url";
import { main, postgresConfiguration } from "./verification.mjs";

await main("postgres-prepare", async () => {
  const { runtime, migration } = postgresConfiguration();
  const { Pool } = createRequire(new URL("../packages/storage/package.json", import.meta.url))(
    "pg",
  );
  const { PostgresStorage } = await import("../packages/storage/dist/index.js");
  const pool = new Pool({ connectionString: migration.href });
  const storage = new PostgresStorage({ connectionString: migration.href });
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  try {
    const result = await pool.query(
      "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user",
    );
    if (!result.rows[0] || Object.values(result.rows[0]).some(Boolean))
      throw new Error(
        "Migration role must not be superuser, bypass RLS, create roles or databases",
      );
    await storage.ensureSchema();
    const tables = await pool.query(
      "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'embody_%'",
    );
    if (
      !tables.rows.length ||
      tables.rows.some((table) => table.tableowner !== decodeURIComponent(migration.username))
    )
      throw new Error("Migration role must own the isolated test schema tables");
    for (const { tablename } of tables.rows) {
      await pool.query(
        `GRANT ${tablename === "embody_schema_migrations" ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE"} ON TABLE public.${quote(tablename)} TO ${quote(decodeURIComponent(runtime.username))}`,
      );
    }
    console.log("Test schema migrated by maintenance role; runtime DML privileges granted");
  } finally {
    await storage.close();
    await pool.end();
  }
});
