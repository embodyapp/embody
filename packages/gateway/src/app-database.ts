import { Client } from "pg";
import {
  migrationRefusal,
  type AppDatabase,
  type AppResourceNames,
  type MigrationPolicyEntry,
  type WorkflowVersionInUse,
} from "./release-stages.js";

/**
 * M13 per-app database on the shared PostgreSQL instance (MD05: one Cloud SQL instance, one
 * database and least-privilege roles per app). The controller connects as a **provisioner** role
 * with `CREATEDB` and `CREATEROLE` and nothing else (no superuser, no `BYPASSRLS`): it creates the
 * app's owner role (no login; owns the schema; migrations run as it through `SET ROLE`) and its
 * runtime role (login, `CONNECTION LIMIT`, DML and the storage runtime functions only), and runs
 * only the platform's framework migrations, never customer SQL. Every connection is short-lived
 * and every statement bounded. See docs/mvp/RELEASES.md.
 */
export interface MigrationStep extends MigrationPolicyEntry {
  readonly postgres: string;
}
export interface PostgresAppDatabaseOptions {
  /** Provisioner connection to the instance's maintenance database (`postgres`). */
  readonly provisionerUrl: string;
  /**
   * Where the runtime connects: a Cloud SQL socket directory (`/cloudsql/<connection>`) or
   * `host:port` for local fixtures.
   */
  readonly runtimeHost: string;
  readonly migrations: readonly MigrationStep[];
  /** Function signatures the runtime may execute (`STORAGE_RUNTIME_FUNCTIONS`). */
  readonly runtimeFunctions: readonly string[];
  /** Concurrent runtime connections: 3 instances × pool 5 (RUNTIME). */
  readonly runtimeConnectionLimit?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
}
export class MigrationRefusedError extends Error {
  public constructor(public readonly reason: string) {
    super(`Migration refused: ${reason}`);
    this.name = "MigrationRefusedError";
  }
}

const IDENT = /^embody_[a-z0-9_]{1,48}$/;
const ident = (name: string): string => {
  if (!IDENT.test(name)) throw new TypeError("Unsafe SQL identifier");
  return `"${name}"`;
};
const PASSWORD = /^[A-Za-z0-9_-]{24,128}$/;
const MARKER = "embody-secret-version:";

export class PostgresAppDatabase implements AppDatabase {
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  public constructor(private readonly options: PostgresAppDatabaseOptions) {
    this.statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  private async connect<T>(
    database: string | null,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    const url = new URL(this.options.provisionerUrl);
    if (database !== null) url.pathname = `/${database}`;
    const client = new Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: 5_000,
      statement_timeout: this.statementTimeoutMs,
      query_timeout: this.statementTimeoutMs + 5_000,
    });
    client.on("error", () => undefined);
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  public async ensure(names: AppResourceNames): Promise<void> {
    const owner = ident(names.ownerRole);
    const runtime = ident(names.runtimeRole);
    const database = ident(names.database);
    const limit = Number(this.options.runtimeConnectionLimit ?? 15);
    await this.connect(null, async (client) => {
      const self = ident(
        (await client.query<{ name: string }>("SELECT current_user AS name")).rows[0]!.name,
      );
      const roles = new Set(
        (
          await client.query<{ rolname: string }>(
            "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
            [[names.ownerRole, names.runtimeRole]],
          )
        ).rows.map((row) => row.rolname),
      );
      if (!roles.has(names.ownerRole))
        await client.query(
          `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
        );
      // The provisioner may act as the owner (DDL as it) but does not inherit its privileges.
      await client.query(`GRANT ${owner} TO ${self} WITH INHERIT FALSE, SET TRUE`);
      if (!roles.has(names.runtimeRole))
        await client.query(
          `CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT ${limit}`,
        );
      await client.query(
        `ALTER ROLE ${runtime} SET statement_timeout = ${Number(this.statementTimeoutMs)}`,
      );
      await client.query(
        `ALTER ROLE ${runtime} SET idle_in_transaction_session_timeout = ${Number(this.statementTimeoutMs)}`,
      );
      const exists = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [
        names.database,
      ]);
      if (!exists.rowCount) await client.query(`CREATE DATABASE ${database} OWNER ${owner}`);
      await client.query(`SET ROLE ${owner}`);
      await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
      await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${runtime}, ${self}`);
      await client.query("RESET ROLE");
    });
    await this.connect(names.database, async (client) => {
      await client.query(`SET ROLE ${owner}`);
      await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${owner}`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
      await client.query("RESET ROLE");
    });
  }

  public async credentialMarker(names: AppResourceNames): Promise<string | null> {
    return this.connect(null, async (client) => {
      const comment = (
        await client.query<{ comment: string | null }>(
          "SELECT shobj_description(oid,'pg_authid') AS comment FROM pg_roles WHERE rolname=$1",
          [names.runtimeRole],
        )
      ).rows[0]?.comment;
      return comment?.startsWith(MARKER) ? comment.slice(MARKER.length) : null;
    });
  }

  public async setCredential(
    names: AppResourceNames,
    password: string,
    marker: string,
  ): Promise<void> {
    if (!PASSWORD.test(password) || !/^[A-Za-z0-9._/-]{1,200}$/.test(marker))
      throw new TypeError("Invalid credential");
    const runtime = ident(names.runtimeRole);
    await this.connect(null, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`ALTER ROLE ${runtime} PASSWORD '${password}'`);
        await client.query(`COMMENT ON ROLE ${runtime} IS '${MARKER}${marker}'`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * A session advisory lock per app database, held on its own connection for the whole of
   * `work` (which includes a provider call), released on every path.
   */
  public async withCredentialLock<T>(names: AppResourceNames, work: () => Promise<T>): Promise<T> {
    return this.connect(null, async (client) => {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [`credential:${names.database}`]);
      try {
        return await work();
      } finally {
        await client
          .query("SELECT pg_advisory_unlock(hashtext($1))", [`credential:${names.database}`])
          .catch(() => undefined);
      }
    });
  }
  public runtimeUrl(names: AppResourceNames, password: string): string {
    const user = encodeURIComponent(names.runtimeRole);
    const secret = encodeURIComponent(password);
    const host = this.options.runtimeHost;
    return host.startsWith("/")
      ? `postgresql://${user}:${secret}@/${names.database}?host=${encodeURIComponent(host)}`
      : `postgresql://${user}:${secret}@${host}/${names.database}`;
  }

  private async applied(client: Client): Promise<number[]> {
    const ledger = await client.query<{ exists: string | null }>(
      "SELECT to_regclass('public.embody_schema_migrations')::text AS exists",
    );
    if (!ledger.rows[0]?.exists) return [];
    return (
      await client.query<{ version: number }>(
        "SELECT version FROM public.embody_schema_migrations ORDER BY version",
      )
    ).rows.map((row) => Number(row.version));
  }

  public async appliedMigrations(names: AppResourceNames): Promise<readonly number[]> {
    return this.connect(names.database, async (client) => {
      await client.query(`SET ROLE ${ident(names.ownerRole)}`);
      return this.applied(client);
    });
  }

  /**
   * One migration per call, in its own transaction as the owner, with statement and lock
   * timeouts (a migration that would block serving traffic for long fails and rolls back). The
   * plan is re-checked under a per-database advisory lock, so concurrent deployments of one app
   * never apply a version twice, and a refused plan executes nothing.
   */
  public async applyNextMigration(
    names: AppResourceNames,
    target: number,
  ): Promise<"applied" | "current"> {
    const owner = ident(names.ownerRole);
    const runtime = ident(names.runtimeRole);
    return this.connect(names.database, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL ROLE ${owner}`);
        await client.query(`SET LOCAL lock_timeout = ${Number(this.lockTimeoutMs)}`);
        await client.query(`SET LOCAL statement_timeout = ${Number(this.statementTimeoutMs)}`);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [names.database]);
        const applied = await this.applied(client);
        const refusal = migrationRefusal(applied, target, this.options.migrations);
        if (refusal) throw new MigrationRefusedError(refusal);
        const next = this.options.migrations.find(
          (migration) => migration.version <= target && !applied.includes(migration.version),
        );
        if (!next) {
          await client.query("COMMIT");
          return "current" as const;
        }
        await client.query(
          "CREATE TABLE IF NOT EXISTS public.embody_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)",
        );
        await client.query(next.postgres);
        await client.query(
          "INSERT INTO public.embody_schema_migrations (version, applied_at) VALUES ($1, now())",
          [next.version],
        );
        // Runtime grants: DML on data tables, read-only ledger, the narrow runtime functions.
        const tables = (
          await client.query<{ tablename: string }>(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
          )
        ).rows.map((row) => row.tablename);
        for (const table of tables)
          await client.query(
            `GRANT ${table === "embody_schema_migrations" ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE"} ON TABLE public.${ident(table)} TO ${runtime}`,
          );
        for (const signature of this.options.runtimeFunctions) {
          const exists = await client.query<{ fn: string | null }>(
            "SELECT to_regprocedure($1)::text AS fn",
            [`public.${signature}`],
          );
          if (exists.rows[0]?.fn)
            await client.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${runtime}`);
        }
        await client.query("COMMIT");
        return "applied" as const;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  public async activeWorkflowVersions(
    names: AppResourceNames,
  ): Promise<readonly WorkflowVersionInUse[]> {
    return this.connect(names.database, async (client) => {
      await client.query(`SET ROLE ${ident(names.ownerRole)}`);
      const fn = await client.query<{ fn: string | null }>(
        "SELECT to_regprocedure('public.embody_active_workflow_versions()')::text AS fn",
      );
      if (!fn.rows[0]?.fn) return [];
      return (
        await client.query<{
          workflow_definition: string;
          workflow_version: string;
          running_instances: string;
        }>("SELECT * FROM public.embody_active_workflow_versions()")
      ).rows.map((row) => ({
        definition: row.workflow_definition,
        version: row.workflow_version,
        instances: Number(row.running_instances),
      }));
    });
  }

  /**
   * Evidence only: a checksum of the app's entity rows (id, type, data), computed as the owner,
   * so tests and the live suite can show a migration or rollback left the data unchanged.
   */
  public async checksum(names: AppResourceNames): Promise<string> {
    return this.connect(names.database, async (client) => {
      await client.query(`SET ROLE ${ident(names.ownerRole)}`);
      const exists = await client.query<{ t: string | null }>(
        "SELECT to_regclass('public.embody_entities')::text AS t",
      );
      if (!exists.rows[0]?.t) return "empty";
      return (
        await client.query<{ sum: string | null }>(
          "SELECT md5(coalesce(string_agg(id::text || ':' || entity_type || ':' || data::text, ',' ORDER BY id), '')) AS sum FROM public.embody_entities",
        )
      ).rows[0]!.sum!;
    });
  }
}
