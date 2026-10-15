import { request as httpRequest } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDurablePlugins,
  definePlugin,
  defineWorkflow,
  Kernel,
  RateLimitedError,
  UnavailableError,
  z,
} from "@embody/core";
import { gatewayJwtVerifier, platformInvokerVerifier } from "@embody/auth";
import {
  SqliteStorage,
  type OutboxEvent,
  type StorageConnection,
  type StorageTransaction,
} from "@embody/storage";
import {
  cloudTasksWakeQueue,
  createHost,
  MemoryWakeQueue,
  metadataAccessToken,
  parseAppEnvironment,
  wakingStorage,
  type DrainResult,
  type WakeTask,
} from "../src/index.js";

const hosted = {
  NODE_ENV: "production",
  EMBODY_HOST_PROFILE: "hosted",
  DATABASE_URL: "postgresql://localhost/app",
  EMBODY_WORKSPACE_ID: "ws_test12345",
  GATEWAY_JWT_ISSUER: "https://gateway.example",
  GATEWAY_JWKS_URL: "https://gateway.example/jwks",
};
const durableEnv = {
  ...hosted,
  EMBODY_HOSTED_PROFILE: "durable",
  EMBODY_WAKE_QUEUE: "projects/embody-test/locations/us-central1/queues/shop",
  EMBODY_DRAIN_URL: "https://shop.example.run.app/_embody/drain",
  EMBODY_DRAIN_AUDIENCE: "https://shop.example.run.app",
  EMBODY_DRAIN_INVOKER_EMAIL: "embody-invoker@embody-test.iam.gserviceaccount.com",
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const handled = definePlugin({
  id: "shop",
  version: "1.0.0",
  events: { "shop.ordered": () => undefined },
  workflows: {
    fulfil: defineWorkflow(z.object({}))({
      version: "1.0.0",
      steps: { ship: { delayMs: 60_000, handler: () => ({ ok: true }) } },
    }),
  },
});

describe("durable profile preflight", () => {
  it("allows workflows, event handlers and subscriptions", () => {
    expect(() =>
      assertDurablePlugins([
        handled,
        { id: "other", version: "1.0.0", subscriptions: { "shop.ordered": {} } } as never,
      ]),
    ).not.toThrow();
  });
  it.each(["schedules", "background", "capabilities", "init", "services"])(
    "rejects %s with an actionable error",
    (name) => {
      expect(() =>
        assertDurablePlugins([
          {
            id: "app",
            version: "1.0.0",
            [name]: name === "init" || name === "services" ? () => undefined : { job: true },
          },
        ]),
      ).toThrow(/Durable plugin app/);
    },
  );
  it("caps durable workflows at 50 steps", () => {
    const steps = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`s${index}`, { handler: () => undefined }]),
    );
    expect(() =>
      assertDurablePlugins([
        {
          id: "app",
          version: "1.0.0",
          workflows: { wide: defineWorkflow(z.object({}))({ version: "1.0.0", steps }) },
        },
      ]),
    ).toThrow(/more than 50 steps/);
  });
  it("applies hosted workflow limits", () => {
    expect(() =>
      assertDurablePlugins([
        {
          id: "app",
          version: "1.0.0",
          workflows: {
            slow: defineWorkflow(z.object({}))({
              version: "1.0.0",
              steps: { wait: { delayMs: 31 * 24 * 60 * 60_000, handler: () => undefined } },
            }),
          },
        },
      ]),
    ).toThrow(/30 days/);
  });
  it("keeps generated events only when this app handles them", async () => {
    const kernel = new Kernel({
      profile: "durable",
      plugins: [handled],
      storage: new SqliteStorage({ filename: ":memory:" }),
    });
    await kernel.boot();
    expect(kernel.retainsGeneratedEvent("shop.ordered")).toBe(true);
    expect(kernel.retainsGeneratedEvent("shop.fulfil.started")).toBe(false);
    await kernel.stop();
  });
});

describe("durable environment", () => {
  it("accepts a complete durable configuration", () => {
    expect(parseAppEnvironment(durableEnv).EMBODY_HOSTED_PROFILE).toBe("durable");
  });
  it.each([
    "EMBODY_WAKE_QUEUE",
    "EMBODY_DRAIN_URL",
    "EMBODY_DRAIN_AUDIENCE",
    "EMBODY_DRAIN_INVOKER_EMAIL",
  ])("requires %s", (name) => {
    expect(() => parseAppEnvironment({ ...durableEnv, [name]: undefined })).toThrow(/Durable/);
  });
  it("requires HTTPS drain URLs", () => {
    expect(() =>
      parseAppEnvironment({ ...durableEnv, EMBODY_DRAIN_URL: "http://shop.example/_embody/drain" }),
    ).toThrow(/HTTPS/);
  });
  it.each([
    { ...hosted, EMBODY_WAKE_QUEUE: durableEnv.EMBODY_WAKE_QUEUE },
    { EMBODY_HOSTED_PROFILE: "durable" },
  ])("rejects drain settings outside the hosted durable profile %#", (env) => {
    expect(() => parseAppEnvironment(env)).toThrow(/EMBODY_HOSTED_PROFILE=durable/);
  });
});

async function durableKernel(queue = new MemoryWakeQueue()) {
  const kernel = new Kernel({
    profile: "durable",
    plugins: [handled],
    storage: wakingStorage(new SqliteStorage({ filename: ":memory:" }), { appId: "shop", queue }),
  });
  await kernel.boot();
  return kernel;
}

describe("M20.a: no background work", () => {
  it("20 cold boots create no timers, enqueue nothing and drain nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const queue = new MemoryWakeQueue();
    const drain = vi.fn<(body: unknown) => Promise<DrainResult>>();
    const recover = vi.fn(() => Promise.resolve(false));
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const host = createHost({
          kernel: await durableKernel(queue),
          verifier: { id: "test", verify: () => Promise.reject(new Error("unused")) },
          appId: "shop",
          version: "1.0.0",
          profile: "durable",
          durable: {
            verifier: { id: "test", verify: () => Promise.reject(new Error("unused")) },
            drain,
            recover,
          },
        });
        await host.start();
        await host.app.ready();
        await host.stop();
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.tasks).toEqual([]);
    expect(drain).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });
  it("durable hosts require a durable kernel and a drain", async () => {
    const kernel = await durableKernel();
    const base = {
      kernel,
      verifier: { id: "test", verify: () => Promise.reject(new Error("unused")) },
      appId: "shop",
      version: "1.0.0",
    };
    expect(() => createHost({ ...base, profile: "durable" })).toThrow(/drain/);
    expect(() =>
      createHost({
        ...base,
        profile: "request-only",
        durable: {
          verifier: base.verifier,
          drain: () => Promise.reject(new Error("unused")),
          recover: () => Promise.resolve(false),
        },
      }),
    ).toThrow();
  });
});

const AUDIENCE = "https://shop.example.run.app";
const INVOKER = "embody-invoker@embody-test.iam.gserviceaccount.com";
async function invokerToken(
  key: CryptoKey,
  claims: Record<string, unknown> = {},
  lifetime = "5m",
): Promise<string> {
  return new SignJWT({ email: INVOKER, email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "google" })
    .setIssuer("https://accounts.google.com")
    .setAudience((claims["aud"] as string | undefined) ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(lifetime)
    .sign(key);
}
function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, url),
      { method: "POST", headers: { "content-type": "application/json", ...headers } },
      (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => (text += chunk.toString()));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: text, headers: response.headers }),
        );
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

describe("platform-only drain endpoint", () => {
  it("accepts only the platform invoker token for this app's audience", async () => {
    const google = await generateKeyPair("RS256");
    const attacker = await generateKeyPair("RS256");
    const gateway = await generateKeyPair("ES256");
    const drain = vi.fn((): Promise<DrainResult> =>
      Promise.resolve({ retry: false, outcome: "processed", events: 1, steps: 0, followUps: 0 }),
    );
    const host = createHost({
      kernel: await durableKernel(),
      verifier: gatewayJwtVerifier({
        issuer: "https://gateway.example",
        audience: "shop",
        key: (await exportJWK(gateway.publicKey)) as never,
        algorithms: ["ES256"],
      }),
      appId: "shop",
      version: "1.0.0",
      profile: "durable",
      durable: {
        verifier: platformInvokerVerifier({
          audience: AUDIENCE,
          invokerEmail: INVOKER,
          key: google.publicKey,
        }),
        drain,
        recover: () => Promise.resolve(false),
      },
    });
    await host.start();
    const url = await host.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const body = { v: 1 };
      const valid = await invokerToken(google.privateKey);
      const gatewayToken = await new SignJWT({ orgId: "ws_test12345" })
        .setProtectedHeader({ alg: "ES256", kid: "gateway" })
        .setIssuer("https://gateway.example")
        .setAudience("shop")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(gateway.privateKey);
      const rejected = [
        {},
        { "x-gateway-auth": `Bearer ${gatewayToken}` },
        { authorization: `Bearer ${gatewayToken}` },
        { authorization: `Bearer ${await invokerToken(attacker.privateKey)}` },
        {
          authorization: `Bearer ${await invokerToken(google.privateKey, { aud: "https://other.run.app" })}`,
        },
        {
          authorization: `Bearer ${await invokerToken(google.privateKey, { email: "app@x.iam.gserviceaccount.com" })}`,
        },
        {
          authorization: `Bearer ${await invokerToken(google.privateKey, { email_verified: false })}`,
        },
        { authorization: `Bearer ${await invokerToken(google.privateKey, {}, "-1m")}` },
      ];
      for (const headers of rejected)
        expect((await post(url, "/_embody/drain", body, headers)).status).toBe(401);
      expect(drain).not.toHaveBeenCalled();
      // A drain token never authorizes an action.
      expect(
        (
          await post(
            url,
            "/execute",
            { protocolVersion: 1, target: "shop.fulfil.start", input: {} },
            { "x-gateway-auth": `Bearer ${valid}` },
          )
        ).status,
      ).toBe(401);
      const accepted = await post(url, "/_embody/drain", body, {
        authorization: `Bearer ${valid}`,
      });
      expect(accepted.status).toBe(200);
      expect(drain).toHaveBeenCalledWith(body);
      drain.mockResolvedValueOnce({
        retry: true,
        outcome: "uncommitted",
        events: 0,
        steps: 0,
        followUps: 0,
      });
      const early = await post(url, "/_embody/drain", body, { authorization: `Bearer ${valid}` });
      expect(early.status).toBe(503);
      expect(early.headers["retry-after"]).toBe("5");
    } finally {
      await host.stop();
    }
  });
});

const task = (name = "event-1"): WakeTask => ({
  name,
  scheduleAt: "2026-10-15T10:00:00.000Z",
  body: {
    v: 1,
    app: "shop",
    org: "ws_test12345",
    kind: "event",
    id: "6f8f1c0e-6b1a-4c3f-9d3a-1b2c3d4e5f60",
    due: "2026-10-15T10:00:00.000Z",
    txid: "42",
    name,
  },
});

describe("Cloud Tasks wake queue", () => {
  const options = {
    queue: "projects/embody-test/locations/us-central1/queues/shop",
    url: "https://shop.example.run.app/_embody/drain",
    audience: AUDIENCE,
    invokerEmail: INVOKER,
    accessToken: () => Promise.resolve("access-token"),
  };
  it("creates a named, scheduled task with the platform invoker OIDC token", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}")));
    await expect(cloudTasksWakeQueue({ ...options, fetch: fetcher }).enqueue(task())).resolves.toBe(
      "created",
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "https://cloudtasks.googleapis.com/v2/projects/embody-test/locations/us-central1/queues/shop/tasks",
    );
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe("Bearer access-token");
    const sent = JSON.parse(init?.body as string) as {
      task: {
        name: string;
        scheduleTime: string;
        httpRequest: { url: string; body: string; oidcToken: unknown };
      };
    };
    expect(sent.task.name).toBe(`${options.queue}/tasks/event-1`);
    expect(sent.task.scheduleTime).toBe(task().scheduleAt);
    expect(sent.task.httpRequest.url).toBe(options.url);
    expect(sent.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: INVOKER,
      audience: AUDIENCE,
    });
    expect(JSON.parse(Buffer.from(sent.task.httpRequest.body, "base64").toString())).toEqual(
      task().body,
    );
  });
  it("treats an existing name as a duplicate and any other failure as an error", async () => {
    const respond = (status: number) =>
      cloudTasksWakeQueue({
        ...options,
        fetch: () => Promise.resolve(new Response("{}", { status })),
      }).enqueue(task());
    await expect(respond(409)).resolves.toBe("duplicate");
    await expect(respond(503)).rejects.toThrow(/503/);
    await expect(respond(403)).rejects.toThrow(/403/);
  });
  it("rejects invalid queue paths and non-HTTPS targets", () => {
    expect(() => cloudTasksWakeQueue({ ...options, queue: "queues/shop" })).toThrow();
    expect(() => cloudTasksWakeQueue({ ...options, url: "http://shop.example/drain" })).toThrow();
  });
  it("reads and caches the workload access token from the metadata server", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          headers: { "metadata-flavor": "Google" },
        }),
      ),
    );
    const token = metadataAccessToken(fetcher);
    expect(await token()).toBe("token");
    expect(await token()).toBe("token");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const spoofed = metadataAccessToken(() =>
      Promise.resolve(new Response(JSON.stringify({ access_token: "x", expires_in: 60 }))),
    );
    await expect(spoofed()).rejects.toThrow(/unavailable/);
  });
});

describe("wake tasks are enqueued before commit", () => {
  const event = (scheduledAt: string): OutboxEvent => ({
    id: "6f8f1c0e-6b1a-4c3f-9d3a-1b2c3d4e5f60",
    orgId: "ws_test12345",
    eventName: "shop.ordered",
    payload: {},
    occurredAt: scheduledAt,
    scheduledAt,
    attempts: 0,
    status: "pending",
  });
  /** A storage whose transactions publish `count` events scheduled at `at`. */
  function fakeStorage(log: string[]): StorageConnection {
    return {
      dialect: "postgres",
      ensureSchema: () => Promise.resolve(),
      close: () => Promise.resolve(),
      transaction: async (orgId, callback) => {
        const tx = {
          orgId,
          outbox: {
            enqueue: (_org: string, input: { scheduledAt: string }) =>
              Promise.resolve(event(input.scheduledAt)),
          },
          workflows: {},
          durable: { transactionId: () => Promise.resolve("7") },
        } as unknown as StorageTransaction;
        try {
          const value = await callback(tx);
          log.push("commit");
          return value;
        } catch (error) {
          log.push("rollback");
          throw error;
        }
      },
    };
  }
  const publish = (storage: StorageConnection, count: number, scheduledAt: string) =>
    storage.transaction("ws_test12345", async (tx) => {
      for (let index = 0; index < count; index++)
        await tx.outbox.enqueue("ws_test12345", {
          eventName: "shop.ordered",
          payload: {},
          scheduledAt,
        });
    });
  it("enqueues before commit and rolls back when the queue fails", async () => {
    const log: string[] = [];
    const queue = new MemoryWakeQueue();
    const storage = wakingStorage(fakeStorage(log), { appId: "shop", queue });
    const now = new Date().toISOString();
    await publish(storage, 1, now);
    expect(queue.tasks.map((item) => item.body.txid)).toEqual(["7"]);
    expect(log).toEqual(["commit"]);
    queue.outage = true;
    await expect(publish(storage, 1, now)).rejects.toBeInstanceOf(UnavailableError);
    expect(log).toEqual(["commit", "rollback"]);
  });
  it("fails closed above the per-transaction quota", async () => {
    const log: string[] = [];
    const queue = new MemoryWakeQueue();
    const storage = wakingStorage(fakeStorage(log), { appId: "shop", queue });
    await expect(publish(storage, 101, new Date().toISOString())).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(queue.tasks).toEqual([]);
    expect(log).toEqual(["rollback"]);
  });
  it("schedules work beyond the queue's 30-day horizon at the horizon", async () => {
    const queue = new MemoryWakeQueue();
    const storage = wakingStorage(fakeStorage([]), { appId: "shop", queue });
    const late = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
    await publish(storage, 1, late);
    const [task] = queue.tasks;
    expect(task!.body.due).toBe(late);
    const ahead = Date.parse(task!.scheduleAt) - Date.now();
    expect(ahead).toBeLessThan(30 * 24 * 60 * 60_000 - 59_000);
    expect(ahead).toBeGreaterThan(30 * 24 * 60 * 60_000 - 120_000);
  });
  it("in-memory queue reports duplicate names like Cloud Tasks", async () => {
    const queue = new MemoryWakeQueue();
    expect(await queue.enqueue(task())).toBe("created");
    expect(await queue.enqueue(task())).toBe("duplicate");
    expect(queue.due(new Date("2026-10-15T09:59:59.000Z"))).toEqual([]);
    expect(queue.due(new Date("2026-10-15T10:00:00.000Z"))).toHaveLength(1);
    queue.acknowledge("event-1");
    expect(queue.due(new Date("2026-10-15T11:00:00.000Z"))).toEqual([]);
  });
});
