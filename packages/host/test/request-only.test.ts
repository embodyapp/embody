import { request as httpRequest } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertRequestOnlyPlugins,
  definePlugin,
  Kernel,
  z,
  type ExecutionOptions,
} from "@embody/core";
import { SqliteStorage } from "@embody/storage";
import { createHost, parseAppEnvironment } from "../src/index.js";

const principal = {
  orgId: "org",
  actorId: "actor",
  actorType: "human" as const,
  roles: [],
  scopes: ["app:*"],
};
const environment = {
  NODE_ENV: "production",
  EMBODY_HOST_PROFILE: "hosted",
  DATABASE_URL: "postgresql://localhost/app",
  EMBODY_WORKSPACE_ID: "ws_test12345",
  GATEWAY_JWT_ISSUER: "https://gateway.example",
  GATEWAY_JWKS_URL: "https://gateway.example/jwks",
};
afterEach(() => vi.useRealTimers());

it.each([
  "workflows",
  "events",
  "subscriptions",
  "schedules",
  "background",
  "capabilities",
  "init",
  "services",
])("rejects unsupported %s before boot", (name) => {
  expect(() =>
    assertRequestOnlyPlugins([
      {
        id: "app",
        version: "1.0.0",
        [name]: name === "init" || name === "services" ? () => undefined : { unsupported: true },
      },
    ]),
  ).toThrow(/Request-only/);
});

it.each([
  { DATABASE_FILE: "app.sqlite" },
  { DATABASE_URL: "file:///app.sqlite" },
  { GATEWAY_URL: "https://gateway.example" },
  { GATEWAY_REGISTRATION_SECRET: "registration-secret" },
  { EMBODY_EVENT_SECRET: "event-secret-long" },
])("rejects local/always-on hosted settings %j", (extra) => {
  expect(() => parseAppEnvironment({ ...environment, ...extra })).toThrow();
});

it("20 cold boots create no recurring timers and never run rejected startup callbacks", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const init = vi.fn();
  await expect(
    new Kernel({
      profile: "request-only",
      plugins: [{ id: "app", version: "1.0.0", init }],
      storage: new SqliteStorage({ filename: ":memory:" }),
    }).boot(),
  ).rejects.toThrow(/startup/);
  expect(init).not.toHaveBeenCalled();
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      const kernel = new Kernel({
        profile: "request-only",
        plugins: [],
        storage: new SqliteStorage({ filename: ":memory:" }),
      });
      await kernel.boot();
      const host = createHost({
        kernel,
        profile: "request-only",
        verifier: { id: "test", verify: () => Promise.resolve(principal) },
        appId: "app",
        version: "1.0.0",
      });
      await host.start();
      expect(
        (await host.app.inject({ method: "POST", url: "/execute/stream", payload: {} })).statusCode,
      ).toBe(400);
      await host.stop();
      await kernel.stop();
    }),
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("generated CRUD retains zero notifications while hooks and entity writes stay atomic", async () => {
  const storage = new SqliteStorage({ filename: ":memory:" });
  const controller = new AbortController();
  const plugin = definePlugin({
    id: "app",
    version: "1.0.0",
    entities: { card: { schema: z.object({ title: z.string() }) } },
    actions: {
      publish: {
        input: z.object({}),
        handler: (_input: unknown, ctx) => ctx.events.publish("app.custom", {}),
      },
    },
    hooks: {
      "app.card.afterCreate": (payload) => {
        const title = (payload as { record: { data: { title: string } } }).record.data.title;
        if (title === "reject") throw new Error("veto");
        if (title === "cancel") controller.abort();
      },
    },
  });
  const kernel = new Kernel({ profile: "request-only", plugins: [plugin], storage });
  await kernel.boot();
  try {
    for (let index = 0; index < 100; index++)
      await kernel.execute("app.card.create", { data: { title: `ok-${index}` } }, { principal });
    await expect(
      kernel.execute("app.card.create", { data: { title: "reject" } }, { principal }),
    ).rejects.toThrow();
    await expect(
      kernel.execute(
        "app.card.create",
        { data: { title: "cancel" } },
        { principal, signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/);
    await expect(kernel.execute("app.publish", {}, { principal })).rejects.toThrow(
      /cannot publish/,
    );
    await storage.transaction("org", async (tx) => {
      expect(await tx.outbox.list()).toEqual([]);
      expect(await tx.entities.list("org", "card", { limit: 100 })).toHaveLength(100);
    });
  } finally {
    await kernel.stop();
  }
});

it("disconnect after the complete request body cancels execution", async () => {
  let signal: AbortSignal | undefined;
  const execute = vi.fn((_target: string, _input: unknown, options: ExecutionOptions) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  });
  const kernel = {
    state: "ready",
    profile: "request-only",
    plugins: [],
    execute,
  } as unknown as Kernel;
  const host = createHost({
    kernel,
    profile: "request-only",
    verifier: { id: "test", verify: () => Promise.resolve(principal) },
    appId: "app",
    version: "1.0.0",
  });
  await host.start();
  const url = await host.app.listen({ host: "127.0.0.1", port: 0 });
  const client = httpRequest(new URL("/execute", url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-gateway-auth": "Bearer test" },
  });
  client.on("error", () => undefined);
  try {
    client.end(JSON.stringify({ protocolVersion: 1, target: "app.wait", input: {} }));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    client.destroy();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  } finally {
    client.destroy();
    await host.stop();
  }
});

it("request-only SSE preserves gateway/MCP progress and results without keepalive intervals", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const interval = vi.spyOn(globalThis, "setInterval");
  const execute = (_target: string, _input: unknown, options: ExecutionOptions) => {
    options.progress?.({ percent: 100, message: "done" });
    return Promise.resolve({ ok: true });
  };
  const kernel = {
    state: "ready",
    profile: "request-only",
    plugins: [],
    execute,
  } as unknown as Kernel;
  const host = createHost({
    kernel,
    profile: "request-only",
    verifier: { id: "test", verify: () => Promise.resolve(principal) },
    appId: "app",
    version: "1.0.0",
  });
  try {
    await host.start();
    const response = await host.app.inject({
      method: "POST",
      url: "/execute/stream",
      headers: { "x-gateway-auth": "Bearer test" },
      payload: { protocolVersion: 1, target: "app.ping", input: {} },
    });
    expect(response.body).toContain("event: progress");
    expect(response.body).toContain('event: result\ndata: {"ok":true}');
    expect(interval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await host.stop();
    interval.mockRestore();
  }
});

it.each(["/execute", "/execute/stream"])(
  "%s bounds responses at 30 seconds and keeps non-cooperative execution counted",
  async (surface) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let signal: AbortSignal | undefined;
    let finish!: (value: unknown) => void;
    const execute = vi.fn((_target: string, _input: unknown, options: ExecutionOptions) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const kernel = {
      state: "ready",
      profile: "request-only",
      plugins: [],
      execute,
    } as unknown as Kernel;
    const host = createHost({
      kernel,
      profile: "request-only",
      concurrency: 1,
      verifier: { id: "test", verify: () => Promise.resolve(principal) },
      appId: "app",
      version: "1.0.0",
    });
    await host.start();
    const request = {
      method: "POST" as const,
      url: surface,
      headers: { "x-gateway-auth": "Bearer test" },
      payload: { protocolVersion: 1, target: "app.wait", input: {} },
    };
    const response = host.app.inject(request).then((result) => result);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);
    const timedOut = await response;
    expect(timedOut.statusCode).toBe(surface === "/execute" ? 503 : 200);
    if (surface === "/execute/stream") expect(timedOut.body).toContain("event: error");
    expect(signal?.aborted).toBe(true);
    expect((await host.app.inject(request)).statusCode).toBe(429);
    finish({ ok: true });
    await Promise.resolve();
    await host.stop();
    expect(vi.getTimerCount()).toBe(0);
  },
);
