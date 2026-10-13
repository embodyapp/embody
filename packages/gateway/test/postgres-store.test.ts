import { randomUUID } from "node:crypto";
import { signingIdentity, privateKeyPem, publicKeys } from "./signing-fixture.js";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { commitDropProxy } from "./commit-drop-proxy.js";
import { promisify } from "node:util";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresGatewayStore, newCredential, createWorkspaceGateway } from "../src/index.js";
import { appRecord, credentialInput, storeConformance } from "./store-conformance.js";
const url = process.env["EMBODY_PLATFORM_URL"];
if (process.env["EMBODY_PLATFORM_REQUIRED"] === "true" && !url)
  throw new Error("Required platform PostgreSQL configuration missing");
// Ordinary workspace tests may skip; the mandatory runner rejects every skip.
describe.skipIf(!url)("platform PostgreSQL (mandatory in test:mvp)", () => {
  storeConformance(
    "real gateway store",
    () => Promise.resolve(new PostgresGatewayStore(url!)),
    () => Promise.resolve(new PostgresGatewayStore(url!)),
  );
  it("M07.d committed audit intent survives process loss, completion is immutable and contains no payload", async () => {
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const store = new PostgresGatewayStore(url!);
    const pool = new Pool({ connectionString: url });
    try {
      await store.createWorkspace(workspace);
      const record = {
        requestId: randomUUID(),
        orgId: workspace,
        appId: "kanban",
        target: "kanban.ping",
        actorId: "alice",
        surface: "http" as const,
        outcome: "unknown" as const,
        durationMs: 0,
      };
      await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {PostgresGatewayStore} from './dist/index.js';const store=new PostgresGatewayStore(process.env.EMBODY_PLATFORM_URL);await store.admit(JSON.parse(process.env.TEST_ADMISSION));process.exit(0);`,
        ],
        {
          cwd: import.meta.dirname + "/..",
          env: { ...process.env, TEST_ADMISSION: JSON.stringify(record) },
        },
      );
      await store.close();
      const replacement = new PostgresGatewayStore(url!);
      try {
        const read = async () =>
          (
            await pool.query<{ document: typeof record }>(
              "SELECT document FROM embody_platform_audit WHERE workspace_id=$1 AND request_id=$2",
              [workspace, record.requestId],
            )
          ).rows[0]!.document;
        expect(await read()).toEqual(record);
        await replacement.complete({ ...record, outcome: "success", durationMs: 10 });
        await replacement.complete({ ...record, outcome: "failure", durationMs: 20 });
        expect(await read()).toMatchObject({ outcome: "success", durationMs: 10 });
        expect(Object.keys(await read()).sort()).toEqual(Object.keys(record).sort());
      } finally {
        await replacement.close();
      }
    } finally {
      await store.close();
      await pool.end();
    }
  });
  it("M07.d expired leases and quota rollover admit again without inventing success", async () => {
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const store = new PostgresGatewayStore(url!);
    const replica = new PostgresGatewayStore(url!);
    const pool = new Pool({ connectionString: url });
    try {
      await store.createWorkspace(workspace);
      for (let i = 0; i < 20; i++)
        await store.admit({
          requestId: `abandoned-${i}`,
          orgId: workspace,
          outcome: "unknown",
          durationMs: 0,
        });
      await expect(
        replica.admit({
          requestId: "blocked",
          orgId: workspace,
          outcome: "unknown",
          durationMs: 0,
        }),
      ).rejects.toThrow("Rate limited");
      await pool.query(
        "UPDATE embody_platform_audit SET lease_until=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
        [workspace],
      );
      await pool.query(
        "UPDATE embody_platform_quotas SET used=60,reset_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
        [workspace],
      );
      await replica.admit({
        requestId: "next-window",
        orgId: workspace,
        outcome: "unknown",
        durationMs: 0,
      });
      expect(
        (
          await pool.query("SELECT used FROM embody_platform_quotas WHERE workspace_id=$1", [
            workspace,
          ])
        ).rows,
      ).toEqual([{ used: 1 }]);
      const expired = await pool.query(
        "SELECT document->>'outcome' AS outcome,completed FROM embody_platform_audit WHERE workspace_id=$1 AND request_id LIKE 'abandoned-%'",
        [workspace],
      );
      expect(expired.rows).toHaveLength(20);
      expect(expired.rows.every((row) => row.outcome === "unknown" && !row.completed)).toBe(true);
    } finally {
      await store.close();
      await replica.close();
      await pool.end();
    }
  });
  it("M07.d lost COMMIT acknowledgement preserves one admission/unknown intent and never dispatches", async () => {
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const seed = new PostgresGatewayStore(url!);
    const proxy = await commitDropProxy(new URL(url!));
    const store = new PostgresGatewayStore(proxy.url);
    const pool = new Pool({ connectionString: url });
    const issued = newCredential(credentialInput(workspace));
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true })));
    const gateway = createWorkspaceGateway({ store, token: signingIdentity, fetch: fetcher });
    try {
      await seed.createWorkspace(workspace);
      await seed.putApp(appRecord(workspace), null);
      await seed.putCredential(issued.credential, null);
      const result = await gateway.inject({
        method: "POST",
        url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
        headers: { authorization: `Bearer ${issued.token}` },
        payload: {},
      });
      expect(result.statusCode).toBe(500);
      expect(fetcher).not.toHaveBeenCalled();
      expect(proxy.dropped()).toBe(1);
      expect(
        (
          await pool.query("SELECT used FROM embody_platform_quotas WHERE workspace_id=$1", [
            workspace,
          ])
        ).rows,
      ).toEqual([{ used: 1 }]);
      expect(
        (
          await pool.query(
            "SELECT document->>'outcome' AS outcome,completed FROM embody_platform_audit WHERE workspace_id=$1",
            [workspace],
          )
        ).rows,
      ).toEqual([{ outcome: "unknown", completed: false }]);
    } finally {
      await gateway.close();
      await store.close();
      await seed.close();
      await pool.end();
      await proxy.close();
    }
  });
  it("M07.d actual completion-pool outage retains known host result and committed unknown intent", async () => {
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const store = new PostgresGatewayStore(url!);
    const pool = new Pool({ connectionString: url });
    const issued = newCredential(credentialInput(workspace));
    const gateway = createWorkspaceGateway({
      store,
      token: signingIdentity,
      fetch: async () => {
        await store.close();
        return Response.json({ committed: true });
      },
    });
    try {
      await store.createWorkspace(workspace);
      await store.putApp(appRecord(workspace), null);
      await store.putCredential(issued.credential, null);
      const result = await gateway.inject({
        method: "POST",
        url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
        headers: { authorization: `Bearer ${issued.token}` },
        payload: {},
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ committed: true });
      expect(
        (
          await pool.query(
            "SELECT document->>'outcome' AS outcome,document->>'requestId' AS request_id FROM embody_platform_audit WHERE workspace_id=$1",
            [workspace],
          )
        ).rows,
      ).toEqual([{ outcome: "unknown", request_id: result.headers["x-request-id"] }]);
    } finally {
      await gateway.close();
      await store.close();
      await pool.end();
    }
  });
  it("M07.d SQL lock timeout rolls admission back and the pool remains usable", async () => {
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const store = new PostgresGatewayStore(url!);
    const pool = new Pool({ connectionString: url });
    const lock = await pool.connect();
    try {
      await store.createWorkspace(workspace);
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM embody_platform_workspaces WHERE id=$1 FOR UPDATE", [
        workspace,
      ]);
      await expect(
        store.admit({ requestId: "blocked", orgId: workspace, outcome: "unknown", durationMs: 0 }),
      ).rejects.toThrow();
      await lock.query("ROLLBACK");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM embody_platform_audit WHERE workspace_id=$1",
            [workspace],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      await store.admit({
        requestId: "healthy",
        orgId: workspace,
        outcome: "unknown",
        durationMs: 0,
      });
      expect(
        (
          await pool.query("SELECT used FROM embody_platform_quotas WHERE workspace_id=$1", [
            workspace,
          ])
        ).rows,
      ).toEqual([{ used: 1 }]);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await store.close();
      await pool.end();
    }
  }, 20_000);
  it("M07.b real host commits a PostgreSQL effect then drops the response once", async () => {
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const store = new PostgresGatewayStore(url!);
    const appPool = new Pool({ connectionString: process.env["EMBODY_POSTGRES_URL"] });
    const platform = new Pool({ connectionString: url });
    const issued = newCredential(credentialInput(workspace));
    let effects = 0;
    const host = createServer((request, response) => {
      const commit = async () => {
        const client = await appPool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.current_org',$1,true)", [workspace]);
          await client.query(
            "INSERT INTO embody_entities(id,org_id,entity_type,data,created_at,updated_at) VALUES($1,$2,'m07-effect',$3,clock_timestamp(),clock_timestamp())",
            [randomUUID(), workspace, { requestId: request.headers["x-request-id"] }],
          );
          await client.query("COMMIT");
          effects++;
          response.destroy();
        } catch {
          await client.query("ROLLBACK");
          response.statusCode = 500;
          response.end();
        } finally {
          client.release();
        }
      };
      void commit();
    });
    host.listen(0, "127.0.0.1");
    await once(host, "listening");
    const address = host.address();
    if (!address || typeof address === "string") throw new Error("Missing effect host address");
    const gateway = createWorkspaceGateway({
      store,
      token: signingIdentity,
      fetch: (input, init) =>
        fetch(
          new URL(
            new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            ).pathname,
            `http://127.0.0.1:${address.port}`,
          ),
          init,
        ),
    });
    try {
      await store.createWorkspace(workspace);
      await store.putApp(appRecord(workspace), null);
      await store.putCredential(issued.credential, null);
      const result = await gateway.inject({
        method: "POST",
        url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
        headers: { authorization: `Bearer ${issued.token}` },
        payload: {},
      });
      expect(result.statusCode).toBe(503);
      expect(result.body).toContain("outcome unknown");
      expect(effects).toBe(1);
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_org',$1,true)", [workspace]);
        const ledger = await client.query(
          "SELECT data FROM embody_entities WHERE org_id=$1 AND entity_type='m07-effect'",
          [workspace],
        );
        expect(ledger.rows).toEqual([{ data: { requestId: result.headers["x-request-id"] } }]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(
        (
          await platform.query(
            "SELECT document->>'outcome' AS outcome FROM embody_platform_audit WHERE workspace_id=$1",
            [workspace],
          )
        ).rows,
      ).toEqual([{ outcome: "unknown" }]);
    } finally {
      await gateway.close();
      await new Promise<void>((resolve, reject) =>
        host.close((error) => (error ? reject(error) : resolve())),
      );
      await store.close();
      await appPool.end();
      await platform.end();
    }
  });
  it("data survives a separate Node process with a fresh connection pool", async () => {
    const store = new PostgresGatewayStore(url!);
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    try {
      await store.createWorkspace(workspace);
      await store.putApp(appRecord(workspace), null);
      await store.close();
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {PostgresGatewayStore} from './dist/index.js';const store=new PostgresGatewayStore(process.env.EMBODY_PLATFORM_URL);try{const s=await store.snapshot(process.env.TEST_WORKSPACE);console.log(JSON.stringify({revision:s.workspace.revision,release:s.apps[0].activeRelease,generation:s.apps[0].generation}));}finally{await store.close();}`,
        ],
        { cwd: import.meta.dirname + "/..", env: { ...process.env, TEST_WORKSPACE: workspace } },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        revision: 2,
        release: "rel_release0001",
        generation: 1,
      });
    } finally {
      await store.close();
    }
  });
  it("hosted gateway bootstrap starts from durable data without reference secrets or migrations", async () => {
    const store = new PostgresGatewayStore(url!);
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const issued = newCredential(credentialInput(workspace));
    await store.createWorkspace(workspace);
    await store.putApp(appRecord(workspace), null);
    await store.putCredential(issued.credential, null);
    await store.close();
    const child = spawn(
      process.execPath,
      [new URL("../../../apps/gateway/dist/src/index.js", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          GATEWAY_PROFILE: "hosted",
          GATEWAY_PLATFORM_DATABASE_URL: url!,
          GATEWAY_SERVICE_ACCOUNT_EMAIL: "gateway@fixture-project.iam.gserviceaccount.com",
          GATEWAY_JWT_ISSUER: "test",
          GATEWAY_JWT_KID: "test-key",
          GATEWAY_JWT_PRIVATE_KEY: privateKeyPem,
          GATEWAY_JWT_PUBLIC_JWKS: JSON.stringify({ keys: publicKeys }),
          PORT: "0",
          HOST: "127.0.0.1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    try {
      const address = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Hosted gateway bootstrap timeout")), 5000);
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          const match = /Gateway listening at (http:\/\/[^\s]+) \(hosted\)/.exec(output);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Hosted gateway exited before readiness"));
        });
      });
      expect(await (await fetch(new URL("/health", address))).json()).toEqual({ live: true });
      const response = await fetch(new URL(`/w/${workspace}/api/catalog`, address), {
        headers: { authorization: `Bearer ${issued.token}` },
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as Array<{ appId: string }>)[0]?.appId).toBe("kanban");
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  });
  it("actual platform pool failure denies warm cached operations without stale fallback", async () => {
    const store = new PostgresGatewayStore(url!);
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const issued = newCredential(credentialInput(workspace));
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true })));
    const gateway = createWorkspaceGateway({
      store,
      fetch: fetcher,
      environment: "development",
      token: signingIdentity,
    });
    try {
      await store.createWorkspace(workspace);
      await store.putApp(appRecord(workspace), null);
      await store.putCredential(issued.credential, null);
      const request = {
        url: `/w/${workspace}/api/catalog`,
        headers: { authorization: `Bearer ${issued.token}` },
      };
      expect((await gateway.inject(request)).statusCode).toBe(200);
      await store.close();
      const denied = await gateway.inject(request);
      expect(denied.statusCode).toBe(500);
      expect(denied.body).not.toContain("pool");
      expect(denied.body).not.toContain("one.example");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await gateway.close();
      await store.close();
    }
  });
  it("platform runtime is restricted/nonowner and cannot execute migrations or DDL", async () => {
    const pool = new Pool({ connectionString: url });
    const store = new PostgresGatewayStore(url!);
    try {
      const role = (
        await pool.query<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
        }>(
          "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0];
      if (!role) throw new Error("Missing platform runtime role");
      expect(Object.values(role)).toEqual([false, false, false, false]);
      const tables = (
        await pool.query(
          "SELECT tableowner=current_user AS owned FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'embody_platform_%'",
        )
      ).rows;
      expect(tables).toHaveLength(5);
      expect(tables.every((row) => !row.owned)).toBe(true);
      await expect(store.migrate()).rejects.toThrow("maintenance authority");
      await expect(
        pool.query("CREATE TABLE public.forbidden_platform_ddl(id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        pool.query("ALTER TABLE embody_platform_apps ADD COLUMN forbidden integer"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await store.close();
      await pool.end();
    }
  });
  it("app runtime cannot connect to platform database and gateway runtime cannot connect to app database", async () => {
    const app = new URL(process.env["EMBODY_POSTGRES_URL"]!);
    const platform = new URL(url!);
    const one = new URL(app);
    one.pathname = platform.pathname;
    const two = new URL(platform);
    two.pathname = app.pathname;
    // Exercise the production probe's SQL inspection/parser and CONNECT-stage classifier,
    // not only an injected tagged error. No metadata/cloud request is made by this child.
    const probe = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { Client } from 'pg';
      import { createRuntimeSqlProbe } from '../../scripts/probe-m05-runtime.mjs';
      import { createAppHost } from '../host/dist/index.js';
      const sql = createRuntimeSqlProbe(Client);
      const own = new URL(process.env.EMBODY_POSTGRES_URL);
      const role = decodeURIComponent(own.username);
      await sql(own.href, role, 'inspect');
      const host = await createAppHost({appId:'proof',version:'1.0.0',plugins:[]}, {env:{NODE_ENV:'production',EMBODY_HOST_PROFILE:'hosted',EMBODY_WORKSPACE_ID:'ws_readonly01',DATABASE_URL:own.href,GATEWAY_JWT_ISSUER:'fixture',GATEWAY_JWKS_URL:'https://example.com/jwks'}});
      await host.stop();
      const platform = new URL(own);
      platform.pathname = new URL(process.env.EMBODY_PLATFORM_URL).pathname;
      await assert.rejects(sql(platform.href, role, 'connect-only'), error => error.code === '42501' && error.stage === 'connect');
      const migration = new URL(process.env.EMBODY_POSTGRES_MIGRATION_URL);
      await assert.rejects(sql(migration.href, decodeURIComponent(migration.username), 'inspect'), /elevated or mismatched/);
      console.log(JSON.stringify({ ownRole: 'restricted', hostedStartup: 'verified', platformConnect: 'denied', elevatedMigrator: 'rejected' }));
    `,
      ],
      { cwd: import.meta.dirname + "/..", env: process.env },
    );
    expect(JSON.parse(probe.stdout)).toEqual({
      ownRole: "restricted",
      hostedStartup: "verified",
      platformConnect: "denied",
      elevatedMigrator: "rejected",
    });
    for (const connectionString of [one.href, two.href]) {
      const pool = new Pool({ connectionString });
      try {
        await expect(pool.query("SELECT 1")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await pool.end();
      }
    }
  }, 20_000);
});
