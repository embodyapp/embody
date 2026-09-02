import { describe, expect, it, vi } from "vitest";
import type { Kernel } from "@embody/core";
import { createHost, createRegistrationClient } from "../src/index.js";

const principal = {
  orgId: "org-1",
  actorId: "user-1",
  actorType: "human" as const,
  roles: [],
  scopes: ["kanban:*"],
};
function makeHost(execute = vi.fn(() => Promise.resolve({ ok: true }))) {
  const kernel = { state: "ready", execute, manifest: {} } as unknown as Kernel;
  return {
    host: createHost({
      kernel,
      verifier: { id: "test", verify: () => Promise.resolve(principal) },
      appId: "kanban",
      version: "1.0.0",
    }),
    execute,
  };
}

describe("remote host", () => {
  it("requires gateway authentication and invokes the shared kernel pipeline", async () => {
    const { host, execute } = makeHost();
    await host.start();
    const unauthorized = await host.app.inject({
      method: "POST",
      url: "/execute",
      payload: { protocolVersion: 1, target: "kanban.card.create", input: {} },
    });
    expect(unauthorized.statusCode).toBe(401);
    const success = await host.app.inject({
      method: "POST",
      url: "/execute",
      headers: { "x-gateway-auth": "Bearer gateway-token", "x-request-id": "request-1" },
      payload: { protocolVersion: 1, target: "kanban.card.create", input: { title: "x" } },
    });
    expect(success.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      "kanban.card.create",
      { title: "x" },
      expect.objectContaining({ principal, requestId: "request-1" }),
    );
    await host.stop();
  });
  it("re-registers on a gateway not-found heartbeat and stops its scheduler", async () => {
    const ticks: (() => void)[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const clear = vi.fn();
    const client = createRegistrationClient({
      gatewayUrl: "https://gateway.example/",
      appId: "kanban",
      version: "1",
      endpoint: "https://app.example",
      healthCheckUrl: "https://app.example/health",
      manifest: {
        protocolVersion: 1,
        plugins: [],
        entities: {},
        actions: {},
        eventSubscriptions: [],
      },
      secret: "do-not-log",
      fetch,
      setInterval: (callback: () => void) => {
        ticks.push(callback);
        return 1 as never;
      },
      clearInterval: clear,
    });
    await client.start();
    ticks[0]!();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    client.stop();
    expect(clear).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer do-not-log" }),
      }),
    );
  });
  it("reports readiness and rejects local development auth in production", async () => {
    const { host } = makeHost();
    const health = await host.app.inject("/health");
    expect(health.json()).toMatchObject({ live: true, ready: false, appId: "kanban" });
    expect(() =>
      createHost({
        kernel: { state: "ready" } as Kernel,
        verifier: {
          id: "local",
          localDevelopmentOnly: true,
          verify: () => Promise.resolve(principal),
        },
        appId: "kanban",
        version: "1",
      }),
    ).toThrow("cannot run in production");
    await host.stop();
  });
});
