import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceGateway,
  newCredential,
  type GatewayStore,
  type CatalogWrite,
} from "../src/index.js";

export function appRecord(workspaceId: string, endpoint = "https://one.example.com"): CatalogWrite {
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
      const server = createWorkspaceGateway({
        store: backend,
        fetch: fetcher,
        token: {
          issuer: "m04-test",
          key: new TextEncoder().encode("test-key-at-least-thirty-two-bytes"),
        },
        ...(clock ? { clock } : {}),
      });
      closers.push(() => server.close());
      return { server, fetcher };
    };
    const provision = async (w = workspace, endpoint = "https://one.example.com") => {
      const app = await store.putApp(appRecord(w, endpoint), null);
      const issued = newCredential(credentialInput(w));
      const credential = await store.putCredential(issued.credential, null);
      return { ...issued, credential, app };
    };
    const headers = (token: string) => ({ authorization: `Bearer ${token}` });
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
        (await store.snapshot(workspace))?.apps[0]?.registration.manifest.actions,
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
          registration: { ...other.registration, appId: "other" },
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
    it("MCP sessions cannot be reused by another credential or after grant revision changes", async () => {
      const issued = await provision();
      const { server } = gateway();
      const address = await server.listen({ port: 0, host: "127.0.0.1" });
      const client = new Client({ name: "m04-session", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(`/w/${workspace}/mcp`, address), {
        requestInit: { headers: headers(issued.token) },
      });
      await client.connect(transport as unknown as Transport);
      closers.push(() => client.close());
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
            "mcp-session-id": transport.sessionId!,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }),
        });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("kanban_ping");
      }
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
