import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { signingIdentity } from "./signing-fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceGateway,
  MemoryAuditLog,
  newCredential,
  type GatewayStore,
  type CatalogWrite,
  type Registration,
} from "../src/index.js";

export function appRecord(
  workspaceId: string,
  endpoint = "https://one.example.com",
): CatalogWrite & { registration: Registration } {
  return {
    workspaceId,
    appId: "app_kanban0001",
    activeRelease: "rel_release0001",
    state: "idle",
    registration: {
      protocolVersion: 1,
      appId: "kanban",
      version: "1.0.0",
      endpoint,
      healthCheckUrl: `${endpoint}/health`,
      manifest: {
        protocolVersion: 1,
        plugins: [{ id: "kanban", version: "1.0.0" }],
        entities: {},
        actions: {
          "kanban.ping": { generated: false, inputSchema: { type: "object", properties: {} } },
        },
        eventSubscriptions: [],
      },
    },
  };
}
export const credentialInput = (workspaceId: string) => ({
  workspaceId,
  principal: {
    orgId: workspaceId,
    actorId: "alice",
    actorType: "human" as const,
    roles: [],
    scopes: ["kanban:*"],
  },
  grants: [{ workspaceId, appId: "app_kanban0001", role: "app-caller" as const }],
  expiresAt: "2099-01-01T00:00:00.000Z",
});

export function storeConformance(
  name: string,
  factory: () => Promise<GatewayStore>,
  reopen?: () => Promise<GatewayStore>,
): void {
  describe(name, () => {
    let store: GatewayStore;
    let workspace: string;
    const closers: Array<() => Promise<void>> = [];
    beforeEach(async () => {
      store = await factory();
      workspace = `ws_${randomUUID().replaceAll("-", "")}`;
      closers.push(() => store.close());
      await store.createWorkspace(workspace);
    });
    afterEach(async () => {
      for (const close of closers.splice(0).reverse()) await close();
    });
    const gateway = (backend = store, clock?: { now(): Date }) => {
      const fetcher = vi.fn<typeof fetch>((url) =>
        Promise.resolve(
          Response.json({
            endpoint: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
          }),
        ),
      );
      const audit = new MemoryAuditLog();
      const server = createWorkspaceGateway({
        store: backend,
        audit,
        fetch: fetcher,
        token: signingIdentity,
        ...(clock ? { clock } : {}),
      });
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= server.close());
      closers.push(close);
      return { server, fetcher, close, audit };
    };
    const provision = async (w = workspace, endpoint = "https://one.example.com") => {
      const app = await store.putApp(appRecord(w, endpoint), null);
      const issued = newCredential(credentialInput(w));
      const credential = await store.putCredential(issued.credential, null);
      return { ...issued, credential, app };
    };
    const headers = (token: string) => ({ authorization: `Bearer ${token}` });
    it("M07.d serializes concurrent workspace admission across replicas and preserves quota after replacement", async () => {
      const other = reopen ? await reopen() : store;
      if (other !== store) closers.push(() => other.close());
      const record = (requestId: string) => ({
        requestId,
        orgId: workspace,
        actorId: "alice",
        appId: "kanban",
        target: "kanban.ping",
        outcome: "unknown" as const,
        durationMs: 0,
      });
      const results = await Promise.allSettled(
        Array.from({ length: 25 }, (_, i) =>
          (i % 2 ? store : other).admit(record(`parallel-${i}`)),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
      for (let i = 0; i < results.length; i++)
        if (results[i]!.status === "fulfilled")
          await other.complete({ ...record(`parallel-${i}`), outcome: "success" });
      for (let i = 0; i < 40; i++) {
        await other.admit(record(`serial-${i}`));
        await other.complete({ ...record(`serial-${i}`), outcome: "success" });
      }
      const replacement = reopen ? await reopen() : store;
      if (replacement !== store) closers.push(() => replacement.close());
      await expect(replacement.admit(record("over-budget"))).rejects.toThrow("Rate limited");
      const second = `ws_${randomUUID().replaceAll("-", "")}`;
      await store.createWorkspace(second);
      await replacement.admit({ ...record("independent"), orgId: second });
      await replacement.complete({ ...record("independent"), orgId: second, outcome: "success" });
    });
    it("M07.a includes stalled invocation-token acquisition in the action deadline", async () => {
      const issued = await provision();
      const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true })));
      const server = createWorkspaceGateway({
        store,
        token: signingIdentity,
        audit: new MemoryAuditLog(),
        fetch: fetcher,
        actionTimeoutMs: 20,
        invocationToken: () => new Promise(() => undefined),
      });
      closers.push(() => server.close());
      const response = await server.inject({
        method: "POST",
        url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
        headers: headers(issued.token),
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("deadline");
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("M07.d shutdown waits for durable completion of an interrupted HTTP call", async () => {
      const issued = await provision();
      let dispatched!: () => void;
      const reached = new Promise<void>((resolve) => {
        dispatched = resolve;
      });
      const server = createWorkspaceGateway({
        store,
        token: signingIdentity,
        audit: new MemoryAuditLog(),
        fetch: () => {
          dispatched();
          return new Promise(() => undefined);
        },
      });
      closers.push(() => server.close());
      const complete = vi.spyOn(store, "complete");
      try {
        const response = server.inject({
          method: "POST",
          url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
          headers: headers(issued.token),
          payload: {},
        });
        await reached;
        await server.close();
        expect((await response).statusCode).toBe(503);
        expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
      } finally {
        complete.mockRestore();
      }
    });
    it("M07.a whole request deadline includes stalled authoritative authentication", async () => {
      const issued = await provision();
      const credential = store.credential.bind(store);
      const stalled = vi.spyOn(store, "credential").mockImplementationOnce(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return credential(...args);
      });
      const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true })));
      const server = createWorkspaceGateway({
        store,
        token: signingIdentity,
        audit: new MemoryAuditLog(),
        fetch: fetcher,
        requestTimeoutMs: 20,
      });
      closers.push(() => server.close());
      try {
        const response = await server.inject({
          method: "POST",
          url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
          headers: headers(issued.token),
          payload: {},
        });
        expect(response.statusCode).toBe(503);
        expect(response.body).toContain("Request deadline");
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        stalled.mockRestore();
      }
    });
    it("M07.d late admission after deadline drains an unknown completion without dispatch", async () => {
      const issued = await provision();
      const admit = store.admit.bind(store);
      const delayed = vi.spyOn(store, "admit").mockImplementationOnce(async (record) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        await admit(record);
      });
      const complete = vi.spyOn(store, "complete");
      const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true })));
      const server = createWorkspaceGateway({
        store,
        token: signingIdentity,
        audit: new MemoryAuditLog(),
        fetch: fetcher,
        actionTimeoutMs: 20,
      });
      closers.push(() => server.close());
      try {
        const response = await server.inject({
          method: "POST",
          url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
          headers: headers(issued.token),
          payload: {},
        });
        expect(response.statusCode).toBe(503);
        await server.close();
        expect(fetcher).not.toHaveBeenCalled();
        expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
      } finally {
        delayed.mockRestore();
        complete.mockRestore();
      }
    });
    it.each(["execute", "execute/stream"])(
      "M07.a disconnect during %s preflight never reaches the host",
      async (surface) => {
        const issued = await provision();
        let entered!: () => void;
        const reached = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true })));
        const complete = vi.spyOn(store, "complete");
        const server = createWorkspaceGateway({
          store,
          token: signingIdentity,
          audit: new MemoryAuditLog(),
          fetch: fetcher,
          invocationToken: () => {
            entered();
            return new Promise(() => undefined);
          },
        });
        closers.push(() => server.close());
        try {
          const address = await server.listen({ host: "127.0.0.1", port: 0 });
          const call = httpRequest(
            new URL(`/w/${workspace}/api/${surface}/kanban/kanban.ping`, address),
            {
              method: "POST",
              headers: { ...headers(issued.token), "content-type": "application/json" },
            },
          );
          call.on("error", () => undefined);
          call.end("{}");
          await reached;
          call.destroy();
          await expect.poll(() => complete.mock.calls.length).toBe(1);
          expect(fetcher).not.toHaveBeenCalled();
          await server.close();
        } finally {
          complete.mockRestore();
        }
      },
    );
    it.each(["execute", "execute/stream"])(
      "M07.d shutdown during %s token preflight never dispatches",
      async (surface) => {
        const issued = await provision();
        let entered!: () => void;
        const reached = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true })));
        const complete = vi.spyOn(store, "complete");
        const server = createWorkspaceGateway({
          store,
          token: signingIdentity,
          audit: new MemoryAuditLog(),
          fetch: fetcher,
          invocationToken: () => {
            entered();
            return new Promise(() => undefined);
          },
        });
        closers.push(() => server.close());
        try {
          const response = server.inject({
            method: "POST",
            url: `/w/${workspace}/api/${surface}/kanban/kanban.ping`,
            headers: headers(issued.token),
            payload: {},
          });
          await reached;
          await server.close();
          expect((await response).statusCode).toBe(503);
          expect(fetcher).not.toHaveBeenCalled();
          expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
        } finally {
          complete.mockRestore();
        }
      },
    );
    it("M07.d shutdown during admission drains a late committed unknown intent", async () => {
      const issued = await provision();
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admit = store.admit.bind(store);
      const delayed = vi.spyOn(store, "admit").mockImplementationOnce(async (record) => {
        entered();
        await barrier;
        await admit(record);
      });
      const complete = vi.spyOn(store, "complete");
      const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true })));
      const server = createWorkspaceGateway({
        store,
        token: signingIdentity,
        audit: new MemoryAuditLog(),
        fetch: fetcher,
      });
      closers.push(() => server.close());
      try {
        const response = server.inject({
          method: "POST",
          url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
          headers: headers(issued.token),
          payload: {},
        });
        await reached;
        const closing = server.close();
        expect((await response).statusCode).toBe(503);
        release();
        await closing;
        expect(fetcher).not.toHaveBeenCalled();
        expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
      } finally {
        release();
        delayed.mockRestore();
        complete.mockRestore();
      }
    });
    it("M07.d admission-store outage fails closed before any host call", async () => {
      const issued = await provision();
      const { server, fetcher } = gateway();
      const fail = vi.spyOn(store, "admit").mockRejectedValueOnce(new Error("store unavailable"));
      try {
        const response = await server.inject({
          method: "POST",
          url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
          headers: headers(issued.token),
          payload: {},
        });
        expect(response.statusCode).toBe(500);
        expect(fetcher).not.toHaveBeenCalled();
        expect(response.body).not.toContain("store unavailable");
      } finally {
        fail.mockRestore();
      }
    });
    it("M07.b commits one effect, loses response and never replays an annotated mutation", async () => {
      const issued = await provision();
      const app = (await store.snapshot(workspace))!.apps[0]!;
      await store.putApp(
        {
          ...app,
          registration: {
            ...app.registration!,
            manifest: {
              ...app.registration!.manifest,
              actions: {
                "kanban.ping": {
                  generated: false,
                  inputSchema: {},
                  effect: "write",
                  idempotent: true,
                },
              },
            },
          },
        },
        app.revision,
      );
      const effects: string[] = [];
      const server = createWorkspaceGateway({
        store,
        token: signingIdentity,
        audit: new MemoryAuditLog(),
        fetch: () => {
          effects.push("committed");
          return Promise.reject(new Error("response lost"));
        },
      });
      closers.push(() => server.close());
      const response = await server.inject({
        method: "POST",
        url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
        headers: headers(issued.token),
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining("outcome unknown"),
          requestId: expect.any(String),
        },
      });
      expect(effects).toEqual(["committed"]);
    });
    it("creates and reads workspace, rejects duplicates, hides missing workspace", async () => {
      expect(await store.snapshot(workspace)).toEqual({
        workspace: { id: workspace, revision: 1 },
        apps: [],
      });
      await expect(store.createWorkspace(workspace)).rejects.toThrow();
      expect(await store.snapshot("missing")).toBeNull();
    });
    it("persists immutable catalog copies and revisions/generation with release promotion", async () => {
      const input = appRecord(workspace);
      const created = await store.putApp(input, null);
      Object.assign(input.registration.manifest.actions, {
        injected: { generated: false, inputSchema: {} },
      });
      expect(
        (await store.snapshot(workspace))?.apps[0]?.registration?.manifest.actions,
      ).not.toHaveProperty("injected");
      const promoted = await store.putApp(
        { ...created, activeRelease: "rel_release0002", state: "ready" },
        created.revision,
      );
      expect(promoted).toMatchObject({
        revision: 2,
        generation: 2,
        activeRelease: "rel_release0002",
      });
      expect((await store.snapshot(workspace))?.workspace.revision).toBe(3);
    });
    it("app names are unique within a workspace even under different immutable identities", async () => {
      await store.putApp(appRecord(workspace), null);
      await expect(
        store.putApp({ ...appRecord(workspace), appId: "app_different0" }, null),
      ).rejects.toThrow();
      expect((await store.snapshot(workspace))?.workspace.revision).toBe(2);
    });
    it("concurrent catalog CAS has exactly one winner and no lost revision", async () => {
      const initial = await store.putApp(appRecord(workspace), null);
      const outcomes = await Promise.allSettled([
        store.putApp({ ...initial, activeRelease: "rel_releaseaaaa" }, 1),
        store.putApp({ ...initial, activeRelease: "rel_releasebbbb" }, 1),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect((await store.snapshot(workspace))?.apps[0]).toMatchObject({
        revision: 2,
        generation: 2,
      });
      expect((await store.snapshot(workspace))?.workspace.revision).toBe(3);
    });
    it("creates hashed credentials, CAS updates/revokes and rejects workspace-mismatched grants", async () => {
      const issued = newCredential(credentialInput(workspace));
      const created = await store.putCredential(issued.credential, null);
      expect(JSON.stringify(created)).not.toContain(issued.token);
      expect(created.hash).toMatch(/^[a-f0-9]{64}$/);
      const updates = await Promise.allSettled([
        store.putCredential({ ...created, revoked: true }, 1),
        store.putCredential({ ...created, revoked: true }, 1),
      ]);
      expect(updates.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await store.credential(workspace, created.hash)).toMatchObject({
        revoked: true,
        revision: 2,
      });
      await expect(
        store.putCredential(
          {
            ...issued.credential,
            grants: [{ workspaceId: "ws_different0", appId: "app_kanban0001", role: "app-caller" }],
          },
          2,
        ),
      ).rejects.toThrow();
    });
    it("duplicate credential hash rollback leaves workspace revision unchanged", async () => {
      const issued = newCredential(credentialInput(workspace));
      await store.putCredential(issued.credential, null);
      const before = await store.snapshot(workspace);
      await expect(
        store.putCredential({ ...issued.credential, id: "different" }, null),
      ).rejects.toThrow();
      expect(await store.snapshot(workspace)).toEqual(before);
    });
    it("rejects create-overwrite, missing workspace and invalid principal without mutation", async () => {
      await store.putApp(appRecord(workspace), null);
      await expect(store.putApp(appRecord(workspace), null)).rejects.toThrow();
      await expect(store.putApp(appRecord("unknown"), null)).rejects.toThrow();
      const issued = newCredential(credentialInput(workspace));
      await expect(
        store.putCredential(
          {
            ...issued.credential,
            principal: { ...issued.credential.principal, orgId: "different" },
          },
          null,
        ),
      ).rejects.toThrow();
      expect((await store.snapshot(workspace))?.workspace.revision).toBe(2);
    });
    it("two workspaces named kanban expose different endpoints, deny mismatches/guessed IDs", async () => {
      const a = await provision();
      const other = `ws_${randomUUID().replaceAll("-", "")}`;
      await store.createWorkspace(other);
      const b = await provision(other, "https://two.example.com");
      const { server, fetcher } = gateway();
      const [first, second] = await Promise.all([
        server.inject({ url: `/w/${workspace}/api/catalog`, headers: headers(a.token) }),
        server.inject({ url: `/w/${other}/api/catalog`, headers: headers(b.token) }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(first.headers["cache-control"]).toContain("max-age=0");
      expect(first.headers["vary"]).toBe("authorization");
      expect(second.statusCode).toBe(200);
      expect(first.json()[0].endpoint).toBe("https://one.example.com");
      expect(second.json()[0].endpoint).toBe("https://two.example.com");
      for (const path of [`/w/${other}/api/catalog`, `/w/ws_guessed000/api/catalog`]) {
        const denied = await server.inject({ url: path, headers: headers(a.token) });
        expect(denied.statusCode).toBe(401);
        expect(denied.body).not.toContain("two.example");
      }
      const missing = await server.inject({
        method: "POST",
        url: `/w/${workspace}/api/execute/guessed/kanban.ping`,
        headers: headers(a.token),
        payload: {},
      });
      expect([403, 404, 503]).toContain(missing.statusCode);
      expect(fetcher).not.toHaveBeenCalled();
      const originalSnapshot = store.snapshot.bind(store);
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const interleave = vi.spyOn(store, "snapshot").mockImplementation(async (id) => {
        const snapshot = await originalSnapshot(id);
        if (++arrived === 2) release();
        await barrier;
        return snapshot;
      });
      const dispatched = await Promise.all(
        [
          [workspace, a.token],
          [other, b.token],
        ].map(([id, token]) =>
          server.inject({
            method: "POST",
            url: `/w/${id}/api/execute/kanban/kanban.ping`,
            headers: headers(token!),
            payload: {},
          }),
        ),
      );
      interleave.mockRestore();
      expect(dispatched.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(dispatched.map((response) => response.json<{ endpoint: string }>().endpoint)).toEqual([
        "https://one.example.com/execute",
        "https://two.example.com/execute",
      ]);
      expect(
        fetcher.mock.calls
          .map(([url]) => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url))
          .sort(),
      ).toEqual(["https://one.example.com/execute", "https://two.example.com/execute"]);
    });
    it("idle/ready/unavailable/disabled catalogs survive no heartbeat, discovery makes zero app requests", async () => {
      const issued = await provision();
      const { server, fetcher } = gateway();
      let record = issued.app;
      for (const state of ["idle", "ready", "unavailable", "disabled"] as const) {
        record = await store.putApp({ ...record, state }, record.revision);
        const response = await server.inject({
          url: `/w/${workspace}/api/catalog`,
          headers: headers(issued.token),
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()[0]).toMatchObject({
          state,
          appId: "kanban",
          promotionGeneration: record.generation,
        });
      }
      expect(fetcher).not.toHaveBeenCalled();
      const disabled = await server.inject({
        method: "POST",
        url: `/w/${workspace}/api/execute/kanban/kanban.ping`,
        headers: headers(issued.token),
        payload: {},
      });
      expect(disabled.statusCode).not.toBe(200);
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("two gateway instances see promotion and revocation on the next operation and cold start", async () => {
      const issued = await provision();
      const otherStore = reopen ? await reopen() : store;
      if (otherStore !== store) closers.push(() => otherStore.close());
      const first = gateway();
      const second = gateway(otherStore);
      const read = () =>
        second.server.inject({
          url: `/w/${workspace}/api/catalog`,
          headers: headers(issued.token),
        });
      expect((await read()).json()[0].activeRelease).toBe("rel_release0001");
      await store.putApp({ ...issued.app, activeRelease: "rel_release0002" }, 1);
      const latest = await read();
      expect(latest.json()[0].activeRelease).toBe("rel_release0002");
      await store.putCredential({ ...issued.credential, revoked: true }, 1);
      for (const server of [first.server, second.server, gateway(otherStore).server])
        expect(
          (
            await server.inject({
              url: `/w/${workspace}/api/catalog`,
              headers: { ...headers(issued.token), "if-none-match": latest.headers.etag! },
            })
          ).statusCode,
        ).toBe(401);
    });
    it("expired credentials are rejected exactly at expiry, including cold start", async () => {
      const issued = await provision();
      await store.putCredential({ ...issued.credential, expiresAt: "2026-10-11T12:00:00.000Z" }, 1);
      const clock = { now: () => new Date("2026-10-11T11:59:59.999Z") };
      const { server } = gateway(store, clock);
      expect(
        (
          await server.inject({
            url: `/w/${workspace}/api/catalog`,
            headers: headers(issued.token),
          })
        ).statusCode,
      ).toBe(200);
      clock.now = () => new Date("2026-10-11T12:00:00.000Z");
      for (const target of [server, gateway(store, clock).server])
        expect(
          (
            await target.inject({
              url: `/w/${workspace}/api/catalog`,
              headers: headers(issued.token),
            })
          ).statusCode,
        ).toBe(401);
    });
    it("broad namespace scopes do not grant another opaque app identity in the same workspace", async () => {
      const issued = await provision();
      const other = appRecord(workspace, "https://other.example.com");
      await store.putApp(
        {
          ...other,
          appId: "app_other0001",
          registration: { ...other.registration!, appId: "other" },
        },
        null,
      );
      await store.putCredential(
        { ...issued.credential, principal: { ...issued.credential.principal, scopes: ["*"] } },
        1,
      );
      const { server, fetcher } = gateway();
      const headersWithKey = headers(issued.token);
      const catalog = await server.inject({
        url: `/w/${workspace}/api/catalog`,
        headers: headersWithKey,
      });
      expect(catalog.json()).toHaveLength(1);
      expect(catalog.json()[0].catalogAppId).toBe("app_kanban0001");
      expect(catalog.body).not.toContain("other.example");
      const denied = await server.inject({
        method: "POST",
        url: `/w/${workspace}/api/execute/other/kanban.ping`,
        headers: headersWithKey,
        payload: {},
      });
      expect(denied.statusCode).not.toBe(200);
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("deployer does not inherit app-call, deleted records persist but leave discovery", async () => {
      const issued = await provision();
      const { server, fetcher } = gateway();
      await store.putCredential(
        {
          ...issued.credential,
          grants: [{ workspaceId: workspace, appId: "app_kanban0001", role: "deployer" }],
        },
        1,
      );
      const response = await server.inject({
        url: `/w/${workspace}/api/catalog`,
        headers: headers(issued.token),
      });
      expect(response.json()).toEqual([]);
      await store.putCredential(issued.credential, 2);
      await store.putApp({ ...issued.app, state: "deleted" }, 1);
      expect((await store.snapshot(workspace))?.apps[0]?.state).toBe("deleted");
      expect(
        (
          await server.inject({
            url: `/w/${workspace}/api/catalog`,
            headers: headers(issued.token),
          })
        ).json(),
      ).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("store failure fails closed even after successful discovery, without leaking internals", async () => {
      const issued = await provision();
      const { server, fetcher } = gateway();
      expect(
        (
          await server.inject({
            url: `/w/${workspace}/api/catalog`,
            headers: headers(issued.token),
          })
        ).statusCode,
      ).toBe(200);
      const spy = vi
        .spyOn(store, "snapshot")
        .mockRejectedValue(new Error("secret-dsn-do-not-expose"));
      try {
        const response = await server.inject({
          url: `/w/${workspace}/api/catalog`,
          headers: headers(issued.token),
        });
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain("secret-dsn");
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
    it("workspace MCP discovers without app requests and revocation denies existing sessions", async () => {
      const issued = await provision();
      const { server, fetcher } = gateway();
      const address = await server.listen({ port: 0, host: "127.0.0.1" });
      const client = new Client({ name: "m04-conformance", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`/w/${workspace}/mcp`, address), {
          requestInit: { headers: headers(issued.token) },
        }) as unknown as Transport,
      );
      closers.push(() => client.close());
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        "kanban__kanban_ping",
      );
      expect(fetcher).not.toHaveBeenCalled();
      await store.putCredential({ ...issued.credential, revoked: true }, 1);
      await expect(client.listTools()).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("stateless MCP rejects session reuse and rechecks every credential grant revision", async () => {
      const issued = await provision();
      const { server } = gateway();
      const address = await server.listen({ port: 0, host: "127.0.0.1" });
      const client = new Client({ name: "m04-session", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(`/w/${workspace}/mcp`, address), {
        requestInit: { headers: headers(issued.token) },
      });
      await client.connect(transport as unknown as Transport);
      closers.push(() => client.close());
      expect(transport.sessionId).toBeUndefined();
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        "kanban__kanban_ping",
      );
      const other = newCredential({
        ...credentialInput(workspace),
        grants: [{ workspaceId: workspace, appId: "app_kanban0001", role: "deployer" }],
      });
      await store.putCredential(other.credential, null);
      for (const token of [other.token, issued.token]) {
        if (token === issued.token)
          await store.putCredential({ ...issued.credential, grants: [] }, 1);
        const response = await fetch(new URL(`/w/${workspace}/mcp`, address), {
          method: "POST",
          headers: {
            ...headers(token),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-session-id": "legacy-session",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }),
        });
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain("kanban_ping");
        const current = await fetch(new URL(`/w/${workspace}/mcp`, address), {
          method: "POST",
          headers: {
            ...headers(token),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
        });
        expect(current.status).toBe(200);
        expect(await current.text()).not.toContain("kanban_ping");
      }
    });
    it("M06: one official client lists and calls across alternating gateways, replacement and grant changes", async () => {
      const issued = await provision();
      const otherStore = reopen ? await reopen() : store;
      if (otherStore !== store) closers.push(() => otherStore.close());
      const instances = [gateway(), gateway(otherStore)];
      const configure = (instance: ReturnType<typeof gateway>) => {
        instance.fetcher.mockImplementation(async (url) => {
          await Promise.resolve();
          const endpoint = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
          return new Response(`event: result\ndata: ${JSON.stringify({ endpoint })}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        });
      };
      instances.forEach(configure);
      const addresses = await Promise.all(
        instances.map(({ server }) => server.listen({ port: 0, host: "127.0.0.1" })),
      );
      let next = 0;
      const routed: Array<{ index: number; method: string }> = [];
      const client = new Client({ name: "m06-replacement", version: "1" });
      closers.push(() => client.close());
      const transport = new StreamableHTTPClientTransport(
        new URL(`/w/${workspace}/mcp`, addresses[0]),
        {
          requestInit: { headers: headers(issued.token) },
          fetch: (url, init) => {
            const index = next++ % 2;
            const message =
              typeof init?.body === "string"
                ? (JSON.parse(init.body) as { method: string })
                : undefined;
            if (message) routed.push({ index, method: message.method });
            const path = new URL(String(url));
            return fetch(new URL(path.pathname, addresses[index]), init);
          },
        },
      );
      await client.connect(transport as unknown as Transport);
      expect(transport.sessionId).toBeUndefined();
      for (let i = 0; i < 2; i++)
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
          "kanban__kanban_ping",
        ]);
      expect(instances.map(({ fetcher }) => fetcher.mock.calls.length)).toEqual([0, 0]);
      for (let i = 0; i < 4; i++) {
        expect(await client.callTool({ name: "kanban__kanban_ping", arguments: {} })).toMatchObject(
          {
            structuredContent: { endpoint: "https://one.example.com/execute/stream" },
          },
        );
      }
      expect(instances.every(({ fetcher }) => fetcher.mock.calls.length > 0)).toBe(true);
      const callRoutes = routed
        .filter(({ method }) => method === "tools/call")
        .map(({ index }) => index);
      expect(callRoutes).toEqual([
        callRoutes[0],
        1 - callRoutes[0]!,
        callRoutes[0],
        1 - callRoutes[0]!,
      ]);
      expect(
        new Set(routed.filter(({ method }) => method === "tools/list").map(({ index }) => index)),
      ).toEqual(new Set([0, 1]));
      await instances[0]!.close();
      const replacement = gateway(otherStore);
      configure(replacement);
      instances[0] = replacement;
      addresses[0] = await replacement.server.listen({ port: 0, host: "127.0.0.1" });
      await store.putApp(
        {
          ...issued.app,
          registration: {
            ...issued.app.registration!,
            endpoint: "https://new.example.com",
            healthCheckUrl: "https://new.example.com/health",
          },
        },
        1,
      );
      expect((await client.listTools()).tools).toHaveLength(1);
      expect(await client.callTool({ name: "kanban__kanban_ping", arguments: {} })).toMatchObject({
        structuredContent: { endpoint: "https://new.example.com/execute/stream" },
      });
      await store.putCredential({ ...issued.credential, grants: [] }, 1);
      const invocationCount = () =>
        instances.reduce((count, instance) => count + instance.fetcher.mock.calls.length, 0);
      const before = invocationCount();
      for (let i = 0; i < 2; i++) {
        expect((await client.listTools()).tools).toEqual([]);
        expect(await client.callTool({ name: "kanban__kanban_ping", arguments: {} })).toMatchObject(
          {
            isError: true,
            _meta: { "embody/errorCode": "FORBIDDEN" },
          },
        );
      }
      expect(invocationCount()).toBe(before);
      await store.putCredential({ ...issued.credential, revoked: true }, 2);
      await expect(client.listTools()).rejects.toThrow();
      expect(new Set(routed.map(({ index }) => index))).toEqual(new Set([0, 1]));
    });
    it("M06: gateway shutdown aborts active MCP dispatch and closes the client response", async () => {
      const issued = await provision();
      const { server, fetcher, close, audit } = gateway();
      let markStarted!: () => void;
      let markAborted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const aborted = new Promise<void>((resolve) => {
        markAborted = resolve;
      });
      fetcher.mockImplementation(async (_url, init) => {
        await Promise.resolve();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                markAborted();
                controller.error(new Error("fixture aborted"));
              },
              { once: true },
            );
            controller.enqueue(
              new TextEncoder().encode(
                'event: progress\ndata: {"percent":10,"message":"started"}\n\n',
              ),
            );
            markStarted();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      });
      const address = await server.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(new URL(`/w/${workspace}/mcp`, address), {
        method: "POST",
        headers: {
          ...headers(issued.token),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "kanban__kanban_ping",
            arguments: {},
            _meta: { progressToken: "shutdown" },
          },
        }),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await started;
      const closing = close();
      await aborted;
      await expect(reader.read()).rejects.toThrow();
      await closing;
      await expect
        .poll(() => audit.records)
        .toMatchObject([
          {
            surface: "mcp",
            outcome: "unknown",
            appId: "kanban",
            target: "kanban.ping",
          },
        ]);
      expect(audit.records).toHaveLength(1);
      expect(audit.records[0]?.errorCode).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it("M06: MCP catalogs bind workspace and app scope on each request without waking hosts", async () => {
      const issued = await provision();
      const hidden = appRecord(workspace, "https://hidden.example.com");
      await store.putApp(
        {
          ...hidden,
          appId: "app_hidden0001",
          registration: {
            ...hidden.registration!,
            appId: "hidden",
          },
        },
        null,
      );
      const other = `ws_${randomUUID().replaceAll("-", "")}`;
      await store.createWorkspace(other);
      await provision(other, "https://foreign.example.com");
      const { server, fetcher } = gateway();
      const address = await server.listen({ port: 0, host: "127.0.0.1" });
      const list = async (path: string, token = issued.token) => {
        const response = await fetch(new URL(path, address), {
          method: "POST",
          headers: {
            ...headers(token),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
        return { status: response.status, body: await response.text() };
      };
      const global = await list(`/w/${workspace}/mcp`);
      expect(global.status).toBe(200);
      expect(global.body).toContain('"name":"kanban__kanban_ping"');
      expect(global.body).not.toContain("hidden__");
      const scoped = await list(`/w/${workspace}/mcp/kanban`);
      expect(scoped.status).toBe(200);
      expect(scoped.body).toContain('"name":"kanban_ping"');
      expect(scoped.body).not.toContain("kanban__");
      for (const app of ["hidden", "guessed"]) {
        const denied = await list(`/w/${workspace}/mcp/${app}`);
        expect(denied.status).toBe(200);
        expect(denied.body).toContain('"tools":[]');
      }
      for (const path of [`/w/${other}/mcp`, "/w/ws_guessed000/mcp"]) {
        const denied = await list(path);
        expect(denied.status).toBe(401);
        expect(denied.body).not.toContain("kanban");
      }
      expect((await list(`/w/${workspace}/mcp`, "wrong-token")).status).toBe(401);
      await store.putCredential({ ...issued.credential, grants: [] }, 1);
      expect((await list(`/w/${workspace}/mcp/kanban`)).body).toContain('"tools":[]');
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("unprefixed hosted routes and heartbeat registration are not usable", async () => {
      const issued = await provision();
      const { server } = gateway();
      for (const path of ["/api/catalog", `/w/${workspace}/register`, `/w/${workspace}/heartbeat`])
        expect(
          (await server.inject({ url: path, headers: headers(issued.token) })).statusCode,
        ).not.toBe(200);
      expect((await server.inject({ url: "/health" })).json()).toEqual({ live: true });
    });
  });
}
