import { describe, expect, it, vi } from "vitest";
import { definePlugin, z, type Kernel } from "@embody/core";
import {
  createAppHost,
  createHost,
  createRegistrationClient,
  defineApp,
  parseAppEnvironment,
  signDelivery,
} from "../src/index.js";

const principal = {
  orgId: "org-1",
  actorId: "user-1",
  actorType: "human" as const,
  roles: [],
  scopes: ["kanban:*"],
};
function makeHost(execute: Kernel["execute"] = vi.fn(() => Promise.resolve({ ok: true }))) {
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
  it("streams ordered progress and one result over SSE", async () => {
    const execute = vi.fn(
      (
        _target: string,
        _input: unknown,
        options: { progress?: (update: { percent: number; message: string }) => void },
      ) => {
        options.progress?.({ percent: 10, message: "first" });
        options.progress?.({ percent: 100, message: "done" });
        return Promise.resolve({ ok: true });
      },
    );
    const { host } = makeHost(execute as unknown as Kernel["execute"]);
    await host.start();
    const response = await host.app.inject({
      method: "POST",
      url: "/execute/stream",
      headers: { "x-gateway-auth": "Bearer gateway-token" },
      payload: { protocolVersion: 1, target: "kanban.card.create", input: {} },
    });
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(
      'event: progress\ndata: {"percent":10,"message":"first"}\n\nevent: progress\ndata: {"percent":100,"message":"done"}\n\nevent: result\ndata: {"ok":true}\n\n',
    );
    await host.stop();
  });
  it("streams progress followed by exactly one structured error", async () => {
    const execute = vi.fn(
      (
        _target: string,
        _input: unknown,
        options: { progress?: (update: { message: string }) => void },
      ) => {
        options.progress?.({ message: "line one\nline two ☃" });
        return Promise.reject(new Error("failed"));
      },
    );
    const { host } = makeHost(execute as unknown as Kernel["execute"]);
    await host.start();
    const response = await host.app.inject({
      method: "POST",
      url: "/execute/stream",
      headers: { "x-gateway-auth": "Bearer token" },
      payload: { protocolVersion: 1, target: "kanban.card.create", input: {} },
    });
    expect(response.body).toContain('event: progress\ndata: {"message":"line one\\nline two ☃"}');
    expect(response.body).toContain('event: error\ndata: {"error":{"code":"INTERNAL_ERROR"');
    expect(response.body).not.toContain("event: result");
    await host.stop();
  });

  it("accepts only signed event envelopes", async () => {
    const handleEvent = vi.fn(() => Promise.resolve());
    const storage = {
      transaction: vi.fn((_org: string, callback: (tx: object) => Promise<void>) => callback({})),
    };
    const host = createHost({
      kernel: { state: "ready", handleEvent } as unknown as Kernel,
      verifier: { id: "test", verify: () => Promise.resolve(principal) },
      appId: "kanban",
      version: "1",
      eventDelivery: {
        storage: storage as never,
        secret: "shared-secret",
        authorize: (event) => event.producerAppId === "email" && event.orgId === "org-1",
      },
    });
    const event = {
      protocolVersion: 1 as const,
      id: "11111111-1111-4111-8111-111111111111",
      name: "kanban.card.created",
      orgId: "org-1",
      producerAppId: "email",
      payload: {},
      occurredAt: "2026-01-01T00:00:00.000Z",
    };
    const delivery = {
      protocolVersion: 1 as const,
      deliveryId: "22222222-2222-4222-8222-222222222222",
      destinationAppId: "kanban",
      attempt: 1,
      event,
    };
    const rejected = await host.app.inject({
      method: "POST",
      url: "/events/deliver",
      payload: delivery,
    });
    expect(rejected.statusCode).toBe(401);
    const wrongAudience = { ...delivery, destinationAppId: "analytics" };
    const wrongDestination = await host.app.inject({
      method: "POST",
      url: "/events/deliver",
      headers: {
        "x-embody-event-signature": signDelivery(wrongAudience, "shared-secret"),
      },
      payload: wrongAudience,
    });
    expect(wrongDestination.statusCode).toBe(401);
    const wrongOrg = { ...delivery, event: { ...event, orgId: "other-org" } };
    const rejectedOrg = await host.app.inject({
      method: "POST",
      url: "/events/deliver",
      headers: { "x-embody-event-signature": signDelivery(wrongOrg, "shared-secret") },
      payload: wrongOrg,
    });
    expect(rejectedOrg.statusCode).toBe(401);
    const accepted = await host.app.inject({
      method: "POST",
      url: "/events/deliver",
      headers: { "x-embody-event-signature": signDelivery(delivery, "shared-secret") },
      payload: delivery,
    });
    expect(accepted.statusCode).toBe(200);
    expect(handleEvent).toHaveBeenCalledOnce();
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
  it("assembles and cleans up a conventional development app host", async () => {
    const definition = defineApp({
      appId: "hello",
      version: "1.0.0",
      plugins: [
        definePlugin({
          id: "hello",
          version: "1.0.0",
          actions: { ping: { input: z.object({}), handler: () => ({ ok: true }) } },
        }),
      ],
    });
    const runtime = await createAppHost(definition, {
      env: { NODE_ENV: "development", PORT: "0", DATABASE_FILE: ":memory:" },
    });
    try {
      const address = await runtime.start();
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const health = await runtime.app.inject("/health");
      expect(health.json()).toMatchObject({ appId: "hello", ready: true });
    } finally {
      await runtime.stop();
    }
  });

  it("rejects incomplete conventional production configuration", () => {
    expect(() => parseAppEnvironment({ NODE_ENV: "production" })).toThrow(
      "Production requires DATABASE_URL",
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
