import { createRequire } from "node:module";
import { URL } from "node:url";
import { main, platformConfiguration } from "./verification.mjs";
await main("platform-prepare", async () => {
  const { runtime, migration } = platformConfiguration();
  const { Pool } = createRequire(new URL("../packages/gateway/package.json", import.meta.url))(
    "pg",
  );
  const { PostgresGatewayStore } = await import("../packages/gateway/dist/index.js");
  const pool = new Pool({ connectionString: migration.href });
  const store = new PostgresGatewayStore(migration.href);
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  try {
    const role = (
      await pool.query(
        "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    if (!role || Object.values(role).some(Boolean))
      throw new Error("Platform maintenance role must be restricted");
    await store.migrate();
    const tables = (
      await pool.query(
        "SELECT tablename,tableowner FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'embody_platform_%'",
      )
    ).rows;
    if (
      tables.length !== 5 ||
      tables.some((table) => table.tableowner !== decodeURIComponent(migration.username))
    )
      throw new Error("Platform maintenance role must own all platform tables");
    for (const { tablename } of tables)
      await pool.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.${quote(tablename)} TO ${quote(decodeURIComponent(runtime.username))}`,
      );
    console.log("Platform tables migrated separately; gateway runtime granted DML only");
  } finally {
    await pool.end();
    await store.close();
  }
});
