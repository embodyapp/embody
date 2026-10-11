import { randomUUID } from "node:crypto";
import { signingIdentity, privateKeyPem, publicKeys } from "./signing-fixture.js";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
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
      expect(tables).toHaveLength(3);
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
      const sql = createRuntimeSqlProbe(Client);
      const own = new URL(process.env.EMBODY_POSTGRES_URL);
      const role = decodeURIComponent(own.username);
      await sql(own.href, role, 'inspect');
      const platform = new URL(own);
      platform.pathname = new URL(process.env.EMBODY_PLATFORM_URL).pathname;
      await assert.rejects(sql(platform.href, role, 'connect-only'), error => error.code === '42501' && error.stage === 'connect');
      const migration = new URL(process.env.EMBODY_POSTGRES_MIGRATION_URL);
      await assert.rejects(sql(migration.href, decodeURIComponent(migration.username), 'inspect'), /elevated or mismatched/);
      console.log(JSON.stringify({ ownRole: 'restricted', platformConnect: 'denied', elevatedMigrator: 'rejected' }));
    `,
      ],
      { cwd: import.meta.dirname + "/..", env: process.env },
    );
    expect(JSON.parse(probe.stdout)).toEqual({
      ownRole: "restricted",
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
  });
});
