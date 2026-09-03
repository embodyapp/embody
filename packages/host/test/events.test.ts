import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Kernel } from "@embody/core";
import { SqliteStorage } from "@embody/storage";
import {
  DeliveryWorker,
  DirectEventTransport,
  OutboxWorker,
  StaticEventDirectory,
  type Clock,
} from "../src/index.js";

const stores: SqliteStorage[] = [];
afterEach(async () => Promise.all(stores.splice(0).map((storage) => storage.close())));
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "embody-events-"));
  const storage = new SqliteStorage({ filename: join(directory, "events.sqlite") });
  stores.push(storage);
  await storage.ensureSchema();
  const handled: string[] = [];
  const kernel = new Kernel({
    storage: {
      ensureSchema: () => Promise.resolve(),
      transaction: storage.transaction.bind(storage),
      close: () => Promise.resolve(),
    },
    plugins: [
      {
        id: "local",
        version: "1.0.0",
        events: {
          "kanban.card.created": (event) => {
            handled.push(event.id);
          },
        },
      },
    ],
  });
  await kernel.boot();
  return { storage, kernel, handled };
}

describe("durable event workers", () => {
  it("suppresses an already-completed receiver handler", async () => {
    const { storage, kernel, handled } = await setup();
    const event = {
      id: "44444444-4444-4444-8444-444444444444",
      name: "kanban.card.created",
      orgId: "org-a",
      payload: {},
      occurredAt: "2026-01-01T00:00:00.000Z",
    };
    await storage.transaction("org-a", (tx) => kernel.handleEvent(event, tx));
    await storage.transaction("org-a", (tx) => kernel.handleEvent(event, tx));
    expect(handled).toEqual([event.id]);
  });

  it("snapshots destinations once and retries each destination independently after restart", async () => {
    const { storage, kernel, handled } = await setup();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const clock: Clock = { now: () => now };
    const id = "11111111-1111-4111-8111-111111111111";
    await storage.transaction("org-a", (tx) =>
      tx.outbox.enqueue("org-a", {
        id,
        eventName: "kanban.card.created",
        payload: { cardId: "card-1" },
        occurredAt: now.toISOString(),
        scheduledAt: now.toISOString(),
      }),
    );
    const calls: string[] = [];
    let analyticsOnline = false;
    const transport = new DirectEventTransport({
      secret: "secret",
      directory: new StaticEventDirectory({
        "kanban.card.created": [
          { appId: "email", endpoint: "https://email.example" },
          { appId: "analytics", endpoint: "https://analytics.example" },
        ],
      }),
      send: (destination) => {
        calls.push(destination.appId);
        if (destination.appId === "analytics" && !analyticsOnline)
          return Promise.reject(new Error("offline\nsecret details"));
        return Promise.resolve();
      },
    });
    const router = new OutboxWorker({ storage, kernel, transport, clock, producerAppId: "kanban" });
    await router.tick();
    await router.tick();
    expect(handled).toEqual([id]);
    await storage.transaction("org-a", async (tx) => {
      expect(await tx.eventDeliveries.list()).toHaveLength(2);
      expect((await tx.outbox.list())[0]?.status).toBe("completed");
    });

    const firstWorker = new DeliveryWorker({
      storage,
      transport,
      clock,
      maxAttempts: 2,
      concurrency: 2,
    });
    await firstWorker.tick();
    await storage.transaction("org-a", async (tx) => {
      expect(await tx.eventDeliveries.list({ status: "completed" })).toMatchObject([
        { destinationAppId: "email" },
      ]);
      expect(await tx.eventDeliveries.list({ status: "failed" })).toMatchObject([
        { destinationAppId: "analytics", lastError: "offline secret details" },
      ]);
    });

    analyticsOnline = true;
    now.setSeconds(1);
    const restartedWorker = new DeliveryWorker({ storage, transport, clock, maxAttempts: 2 });
    await restartedWorker.tick();
    expect(calls.filter((appId) => appId === "email")).toHaveLength(1);
    expect(calls.filter((appId) => appId === "analytics")).toHaveLength(2);
    await storage.transaction("org-a", async (tx) => {
      expect(await tx.eventDeliveries.list({ status: "completed" })).toHaveLength(2);
    });
  });

  it("dead-letters after the default single attempt and audits no subscribers", async () => {
    const { storage, kernel } = await setup();
    const audit = vi.fn();
    const empty = new DirectEventTransport({
      secret: "secret",
      directory: new StaticEventDirectory({}),
      send: () => Promise.reject(new Error("unreachable")),
    });
    await storage.transaction("org-a", (tx) =>
      tx.outbox.enqueue("org-a", {
        id: "22222222-2222-4222-8222-222222222222",
        eventName: "kanban.card.created",
        payload: {},
      }),
    );
    await new OutboxWorker({ storage, kernel, transport: empty, audit }).tick();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "no-subscriber" }));

    await storage.transaction("org-a", (tx) =>
      tx.eventDeliveries.create({
        eventId: "33333333-3333-4333-8333-333333333333",
        orgId: "org-a",
        destinationAppId: "offline",
        destinationEndpoint: "https://offline.example/",
        envelope: {
          protocolVersion: 1,
          id: "33333333-3333-4333-8333-333333333333",
          name: "kanban.card.created",
          orgId: "org-a",
          producerAppId: "kanban",
          payload: {},
          occurredAt: new Date().toISOString(),
        },
      }),
    );
    const failing = new DirectEventTransport({
      secret: "secret",
      directory: new StaticEventDirectory({}),
      send: () => Promise.reject(new Error("unreachable")),
    });
    await new DeliveryWorker({ storage, transport: failing }).tick();
    await storage.transaction("org-a", async (tx) => {
      expect(await tx.eventDeliveries.list({ status: "dead_letter" })).toHaveLength(1);
    });
  });
});
