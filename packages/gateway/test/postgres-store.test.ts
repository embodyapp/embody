import { randomUUID } from "node:crypto";
import { signingIdentity, privateKeyPem, publicKeys } from "./signing-fixture.js";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { commitDropProxy } from "./commit-drop-proxy.js";
import { promisify } from "node:util";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresGatewayStore,
  newCredential,
  createWorkspaceGateway,
  purgeExpiredSources,
  type SourceAdmitInput,
  type SourceRecord,
} from "../src/index.js";
import { appRecord, credentialInput, storeConformance } from "./store-conformance.js";
import { sourceStoreConformance } from "./source-store-conformance.js";
import { artifactStoreConformance } from "./artifact-store-conformance.js";
import { deploymentStoreConformance } from "./deployment-store-conformance.js";
import { createSourceArchive } from "@embody/cloud-contracts";
import { MemorySourceObjectStore } from "../src/index.js";
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
  sourceStoreConformance("real source store", () =>
    Promise.resolve(new PostgresGatewayStore(url!)),
  );
  artifactStoreConformance("real artifact store", () =>
    Promise.resolve(new PostgresGatewayStore(url!)),
  );
  deploymentStoreConformance("real deployment store", () =>
    Promise.resolve(new PostgresGatewayStore(url!)),
  );
  it("M10 admits, verifies and persists source identity across store instances", async () => {
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const store = new PostgresGatewayStore(url!);
    const objects = new MemorySourceObjectStore();
    const gateway = createWorkspaceGateway({ store, token: signingIdentity, sources: { objects } });
    try {
      await store.createWorkspace(workspace);
      await store.putApp(appRecord(workspace), null);
      const issued = newCredential({
        ...credentialInput(workspace),
        grants: [{ workspaceId: workspace, appId: "app_kanban0001", role: "deployer" }],
      });
      await store.putCredential(issued.credential, null);
      const archive = createSourceArchive([
        { path: "package.json", content: Buffer.from("{}") },
        { path: "embody.config.ts", content: Buffer.from("export default {};") },
      ]);
      const { createHash } = await import("node:crypto");
      const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
      const headers = { authorization: `Bearer ${issued.token}` };
      const path = `/v1/workspaces/${workspace}/apps/app_kanban0001/sources`;
      const body = {
        version: 1,
        workspaceId: workspace,
        appId: "app_kanban0001",
        idempotencyKey: `sha256_${digest.slice(7)}`,
        format: "embody-source-v1",
        digest,
        bytes: archive.byteLength,
      };
      const created = await gateway.inject({ method: "POST", url: path, headers, payload: body });
      expect(created.statusCode).toBe(201);
      const status = created.json<{
        uploadId: string;
        upload: { url: string; headers: Record<string, string> };
      }>();
      expect(
        (
          await objects.fetch(status.upload.url, {
            method: "PUT",
            headers: status.upload.headers,
            body: archive,
          })
        ).status,
      ).toBe(200);
      const done = await gateway.inject({
        method: "POST",
        url: `${path}/${status.uploadId}/complete`,
        headers: { ...headers, "content-type": "application/json" },
        payload: "{}",
      });
      expect(done.json()).toMatchObject({ state: "verified" });
      const fresh = new PostgresGatewayStore(url!);
      try {
        expect(await fresh.source(workspace, "app_kanban0001", status.uploadId)).toMatchObject({
          state: "verified",
          digest,
          bytes: archive.byteLength,
        });
        const replay = await fresh.admitSource({
          workspaceId: workspace,
          appId: "app_kanban0001",
          idempotencyKey: body.idempotencyKey,
          digest,
          bytes: archive.byteLength,
          actorId: "alice",
          now: new Date(),
        });
        expect(replay).toMatchObject({ replay: true, record: { uploadId: status.uploadId } });
      } finally {
        await fresh.close();
      }
    } finally {
      await gateway.close();
      await store.close();
    }
  });
  it("M10 admitSource upsert is a CAS: a sweep fence or completion in its window is never overwritten (F1)", async () => {
    const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
    const store = new PostgresGatewayStore(url!);
    const pool = (store as unknown as { pool: Pool }).pool;
    const connect = pool.connect.bind(pool) as (cb?: unknown) => Promise<PoolClient>;
    /** Runs `between` after admitSource read the row and before its upsert, once. */
    const interleave = async <T>(between: () => Promise<unknown>, admit: () => Promise<T>) => {
      let armed = true;
      // pool.query checks out through connect(callback); only transactions use the promise form.
      (pool as unknown as { connect: (cb?: unknown) => unknown }).connect = (cb?: unknown) =>
        cb ? connect(cb) : connect().then(wrap);
      const wrap = (client: PoolClient) => {
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          if (
            armed &&
            typeof args[0] === "string" &&
            args[0].includes("INSERT INTO embody_platform_sources")
          ) {
            armed = false;
            await between();
          }
          return query(...args);
        };
        return client;
      };
      try {
        return await admit();
      } finally {
        (pool as unknown as { connect: unknown }).connect = connect;
      }
    };
    const rows = async () =>
      (
        await pool.query<{ upload_id: string; purging: boolean; doc_purging: string | null }>(
          "SELECT upload_id, purging, document->>'purging' AS doc_purging FROM embody_platform_sources WHERE workspace_id=$1 ORDER BY retain_until",
          [workspace],
        )
      ).rows;
    const deletedKeys: string[] = [];
    const objects = {
      delete: (key: string) => {
        deletedKeys.push(key);
        return Promise.resolve();
      },
    };
    const failing = { delete: () => Promise.reject(new Error("storage down")) };
    const mine = {
      expiredSources: async (now: Date, limit: number) =>
        (await store.expiredSources(now, limit)).filter((r) => r.workspaceId === workspace),
      updateSource: (next: SourceRecord, expected: number) => store.updateSource(next, expected),
      deleteSource: (record: SourceRecord) => store.deleteSource(record),
    };
    const t0 = new Date("2030-01-01T00:00:00.000Z");
    const input = (key: string, now: Date): SourceAdmitInput => ({
      workspaceId: workspace,
      appId: "app_kanban0001",
      idempotencyKey: key,
      digest: `sha256:${"1".padStart(64, "0")}`,
      bytes: 1000,
      actorId: "alice",
      now,
    });
    try {
      await store.createWorkspace(workspace);
      // 1. The sweep fences an expired verified record while a re-run is renewing it in place.
      const { record } = await store.admitSource(input("sha256_key_fenced_0001", t0));
      const verified = await store.updateSource(
        { ...record, state: "verified", files: 2, expandedBytes: 10, treeDigest: record.digest },
        record.revision,
      );
      const after = new Date(Date.parse(record.retainUntil) + 1000);
      const [listed] = await mine.expiredSources(after, 1000);
      const rerun = await interleave(
        () => store.updateSource({ ...listed!, purging: true }, listed!.revision),
        () => store.admitSource(input("sha256_key_fenced_0001", after)),
      );
      // The renewal lost its CAS and re-read: a fresh identity, never the fenced row.
      expect(rerun.replay).toBe(false);
      expect(rerun.record.uploadId).not.toBe(record.uploadId);
      expect(rerun.record.objectKey).not.toBe(record.objectKey);
      expect(await rows()).toEqual([
        { upload_id: record.uploadId, purging: true, doc_purging: "true" },
        { upload_id: rerun.record.uploadId, purging: false, doc_purging: null },
      ]);
      // An interrupted sweep leaves a tombstone that the next sweep purges.
      expect(await purgeExpiredSources({ store: mine, objects: failing, now: after })).toEqual({
        deleted: 0,
        failed: 1,
        skipped: 0,
      });
      expect(await purgeExpiredSources({ store: mine, objects, now: after })).toEqual({
        deleted: 1,
        failed: 0,
        skipped: 0,
      });
      expect(deletedKeys).toEqual([verified.objectKey]);
      expect((await rows()).map((r) => r.upload_id)).toEqual([rerun.record.uploadId]);

      // 2. A completion verifies a pending record while a re-run is renewing its access.
      const pending = (await store.admitSource(input("sha256_key_complete_01", t0))).record;
      const later = new Date(t0.getTime() + 60_000);
      const renewed = await interleave(
        () =>
          store.updateSource(
            {
              ...pending,
              state: "verified",
              files: 2,
              expandedBytes: 10,
              treeDigest: pending.digest,
            },
            pending.revision,
          ),
        () => store.admitSource(input("sha256_key_complete_01", later)),
      );
      expect(renewed).toMatchObject({
        replay: true,
        record: { uploadId: pending.uploadId, state: "verified", revision: pending.revision + 1 },
      });
      expect(await store.source(workspace, "app_kanban0001", pending.uploadId)).toMatchObject({
        state: "verified",
      });

      // 3. A row whose column says purging but whose document does not is still purged.
      await pool.query(
        "UPDATE embody_platform_sources SET purging=true WHERE workspace_id=$1 AND upload_id=$2",
        [workspace, pending.uploadId],
      );
      const swept = new Date(Date.parse(pending.retainUntil));
      const stranded = (await mine.expiredSources(swept, 1000)).find(
        (r) => r.uploadId === pending.uploadId,
      );
      expect(stranded?.purging).toBe(true);
      deletedKeys.length = 0;
      expect(await purgeExpiredSources({ store: mine, objects, now: swept })).toEqual({
        deleted: 1,
        failed: 0,
        skipped: 0,
      });
      expect(deletedKeys).toEqual([pending.objectKey]);
    } finally {
      await store.close();
    }
  });
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
      expect(tables).toHaveLength(9);
      expect(tables.every((row) => !row.owned)).toBe(true);
      await expect(store.migrate()).rejects.toThrow("maintenance authority");
      await expect(
        pool.query("CREATE TABLE public.forbidden_platform_ddl(id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        pool.query("ALTER TABLE embody_platform_apps ADD COLUMN forbidden integer"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        pool.query(
          "ALTER TABLE embody_platform_sources DROP CONSTRAINT embody_platform_sources_pkey",
        ),
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
