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
 * One-time bootstrap: the meta schema, the migration ledger, the app role, and the
 * durable event outbox. Idempotent. Runs with the owner role before any plugin
 * migrations, which is exactly why the outbox lives here rather than in a plugin:
 * every plugin can publish events, so the tables must predate all of them, and no
 * plugin may own them (Decision D5).
 *
 * `embody.current_org()` deliberately duplicates `core.current_org()` instead of
 * calling it. `core` is a plugin, and framework infrastructure cannot depend on
 * plugin DDL that has not run yet.
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

    -- -----------------------------------------------------------------------
    -- Durable event outbox (Decision D5).
    --
    -- Two tables on purpose. \`outbox\` is the append-only log of what happened,
    -- written by the app role INSIDE the tenant transaction that made the change,
    -- so an event and its data commit together or not at all. \`outbox_deliveries\`
    -- is the worker's unit of work, one row per (event, subscriber): subscribers
    -- are only known to the process that booted them, so fan-out cannot happen at
    -- publish time, and per-subscriber rows are what make "which subscriber failed"
    -- answerable and let one failing handler retry without touching its siblings.
    -- -----------------------------------------------------------------------
    create or replace function embody.current_org() returns uuid
      language sql stable
      as $fn$ select nullif(current_setting('app.current_org', true), '')::uuid $fn$;

    create table if not exists embody.outbox (
      id            uuid primary key default gen_random_uuid(),
      org_id        uuid not null,
      name          text not null,
      payload       jsonb not null default '{}'::jsonb,
      at            timestamptz not null default now(),
      published_by  text
    );
    -- Fan-out scans in (at, id) order, which is also the cursor's ordering.
    create index if not exists outbox_scan_idx on embody.outbox (at, id);
    create index if not exists outbox_org_idx on embody.outbox (org_id, at desc);

    -- Per-subscriber progress.
    --
    -- The obvious design is one "has this been fanned out?" flag on the event, and it
    -- is wrong as soon as two deployables share a database -- which this project
    -- supports, and the dev script actually does. Whichever worker reached the row first
    -- would stamp it using ITS subscriber list, and the other deployment's subscribers
    -- would never see the event at all, silently. A cursor per subscriber lets each
    -- advance independently, so disjoint deployments cannot starve each other.
    create table if not exists embody.outbox_cursors (
      subscriber text primary key,
      last_at    timestamptz not null,
      last_id    uuid,
      updated_at timestamptz not null default now()
    );

    do $$
    begin
      -- Databases bootstrapped by the flag-based version. Guarded because DROP COLUMN
      -- takes ACCESS EXCLUSIVE, and bootstrap runs on every boot.
      if exists (select 1 from information_schema.columns
                 where table_schema = 'embody' and table_name = 'outbox'
                   and column_name = 'fanned_out_at') then
        alter table embody.outbox drop column fanned_out_at;
      end if;
    end $$;

    create table if not exists embody.outbox_deliveries (
      id          uuid primary key default gen_random_uuid(),
      outbox_id   uuid not null references embody.outbox(id) on delete cascade,
      subscriber  text not null,
      status      text not null default 'pending',
      attempts    integer not null default 0,
      last_error  text,
      next_run_at timestamptz not null default now(),
      claimed_at  timestamptz,
      unique (outbox_id, subscriber)
    );
    create index if not exists outbox_deliveries_due_idx
      on embody.outbox_deliveries (next_run_at) where status = 'pending';

    -- The app role publishes under RLS and may read back its own org's events. It is
    -- deliberately given NO access to outbox_deliveries: dispatch bookkeeping belongs
    -- to the worker, which runs as owner and must see every tenant.
    do $$
    begin
      -- Guarded rather than re-issued: both statements take ACCESS EXCLUSIVE on the
      -- table, and bootstrap runs on EVERY boot of every deployable. Re-running them
      -- unconditionally blocks (and can deadlock against) a worker that is writing the
      -- outbox during a rolling deploy. Checking the catalog first makes the steady
      -- state a pure read.
      if not (select relrowsecurity from pg_class
              where oid = 'embody.outbox'::regclass) then
        alter table embody.outbox enable row level security;
      end if;
      if not exists (select 1 from pg_policies
                     where schemaname = 'embody' and tablename = 'outbox'
                       and policyname = 'tenant_isolation') then
        create policy tenant_isolation on embody.outbox
          using (org_id = embody.current_org())
          with check (org_id = embody.current_org());
      end if;
    end $$;

    grant select, insert on embody.outbox to ${APP_ROLE};

    -- -----------------------------------------------------------------------
    -- Schedules. A cron trigger is not a second kind of trigger: it is a row that
    -- publishes an event when it comes due, so the automation engine keeps exactly
    -- one primitive to match against. Framework-level rather than owned by the
    -- automation plugin, so any plugin can schedule work.
    -- -----------------------------------------------------------------------
    create table if not exists embody.schedules (
      id          uuid primary key default gen_random_uuid(),
      org_id      uuid not null,
      name        text not null,
      cron        text not null,
      event_name  text not null,
      payload     jsonb not null default '{}'::jsonb,
      timezone    text not null default 'UTC',
      enabled     boolean not null default true,
      next_run_at timestamptz not null default now(),
      last_run_at timestamptz,
      created_at  timestamptz not null default now(),
      unique (org_id, name)
    );
    create index if not exists schedules_due_idx
      on embody.schedules (next_run_at) where enabled;

    do $$
    begin
      -- Guarded rather than re-issued: both statements take ACCESS EXCLUSIVE on the
      -- table, and bootstrap runs on EVERY boot of every deployable. Re-running them
      -- unconditionally blocks (and can deadlock against) a worker that is writing the
      -- outbox during a rolling deploy. Checking the catalog first makes the steady
      -- state a pure read.
      if not (select relrowsecurity from pg_class
              where oid = 'embody.schedules'::regclass) then
        alter table embody.schedules enable row level security;
      end if;
      if not exists (select 1 from pg_policies
                     where schemaname = 'embody' and tablename = 'schedules'
                       and policyname = 'tenant_isolation') then
        create policy tenant_isolation on embody.schedules
          using (org_id = embody.current_org())
          with check (org_id = embody.current_org());
      end if;
    end $$;

    grant select, insert, update, delete on embody.schedules to ${APP_ROLE};

    -- -----------------------------------------------------------------------
    -- Webhook endpoints. An external caller has no session and no cookie, and a
    -- bare path like /hooks/stripe cannot say WHICH tenant it belongs to. So the
    -- URL itself carries the tenancy: the token is looked up here (as owner, since
    -- there is no org to scope by until the lookup succeeds) and resolves to an org
    -- plus the plugin that should parse the body.
    --
    -- Only a hash is stored. A leaked database backup should not hand someone the
    -- ability to inject events into every tenant.
    -- -----------------------------------------------------------------------
    create table if not exists embody.webhook_endpoints (
      id          uuid primary key default gen_random_uuid(),
      org_id      uuid not null,
      name        text not null,
      plugin_id   text not null,
      hook        text not null,
      token_hash  text not null unique,
      -- Shared secret for the provider's own signature scheme (Stripe, Postmark, …),
      -- verified by the plugin's handler. Null when the provider does not sign.
      secret      text,
      enabled     boolean not null default true,
      last_seen_at timestamptz,
      created_at  timestamptz not null default now(),
      unique (org_id, name)
    );

    do $$
    begin
      -- Guarded rather than re-issued: both statements take ACCESS EXCLUSIVE on the
      -- table, and bootstrap runs on EVERY boot of every deployable. Re-running them
      -- unconditionally blocks (and can deadlock against) a worker that is writing the
      -- outbox during a rolling deploy. Checking the catalog first makes the steady
      -- state a pure read.
      if not (select relrowsecurity from pg_class
              where oid = 'embody.webhook_endpoints'::regclass) then
        alter table embody.webhook_endpoints enable row level security;
      end if;
      if not exists (select 1 from pg_policies
                     where schemaname = 'embody' and tablename = 'webhook_endpoints'
                       and policyname = 'tenant_isolation') then
        create policy tenant_isolation on embody.webhook_endpoints
          using (org_id = embody.current_org())
          with check (org_id = embody.current_org());
      end if;
    end $$;

    grant select, insert, update, delete on embody.webhook_endpoints to ${APP_ROLE};
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
