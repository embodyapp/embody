import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileEntity, Kernel, z, type EntityStoreAccessor } from "@embody/core";

import { SqliteStorage } from "../src/index.js";

const stores: SqliteStorage[] = [];
async function storage(): Promise<SqliteStorage> {
  const directory = await mkdtemp(join(tmpdir(), "embody-storage-"));
  const instance = new SqliteStorage({ filename: join(directory, "storage.sqlite") });
  await instance.ensureSchema();
  await instance.ensureSchema();
  stores.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((instance) => instance.close()));
});

describe("SQLite storage conformance", () => {
  it("provides a contextual store with nested JSON filters", async () => {
    const db = await storage();
    const entity = compileEntity("kanban", "card", {
      schema: z.object({
        title: z.string(),
        metadata: z.object({ lane: z.string(), rank: z.number() }),
      }),
      defaultSort: { field: "title", direction: "asc" },
    });
    await db.transaction("org-a", async (tx) => {
      const store = entity.createStore("org-a", tx);
      await store.create({ title: "B", metadata: { lane: "now", rank: 1 } });
      await store.create({ title: "A", metadata: { lane: "now", rank: 2 } });
      await store.create({ title: "C", metadata: { lane: "later", rank: 1 } });
      expect(await store.list({ filter: { metadata: { lane: "now" } } })).toMatchObject([
        { data: { title: "A" } },
        { data: { title: "B" } },
      ]);
    });
  });

  it("commits an entity and outbox event atomically", async () => {
    const db = await storage();
    await db.transaction("org-a", async (tx) => {
      await tx.entities.create("org-a", "card", {
        id: "11111111-1111-4111-8111-111111111111",
        data: { title: "A" },
      });
      await tx.outbox.enqueue("org-a", { eventName: "card.created", payload: { id: 1 } });
    });
    await db.transaction("org-a", async (tx) => {
      expect(
        await tx.entities.get("org-a", "card", "11111111-1111-4111-8111-111111111111"),
      ).toMatchObject({ data: { title: "A" } });
      expect(await tx.outbox.list()).toHaveLength(1);
    });
  });

  it("rolls back entity and outbox writes when the callback throws", async () => {
    const db = await storage();
    await expect(
      db.transaction("org-a", async (tx) => {
        await tx.entities.create("org-a", "card", { data: { title: "A" } });
        await tx.outbox.enqueue("org-a", { eventName: "card.created", payload: {} });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    await db.transaction("org-a", async (tx) => {
      expect(await tx.entities.list("org-a", "card")).toEqual([]);
      expect(await tx.outbox.list()).toEqual([]);
    });
  });

  it("rolls back a mutation when an event payload is not serializable", async () => {
    const db = await storage();
    const kernel = new Kernel({
      storage: {
        ensureSchema: () => Promise.resolve(),
        transaction: db.transaction.bind(db),
        close: () => Promise.resolve(),
      },
      plugins: [
        {
          id: "invalid",
          version: "1.0.0",
          entities: { note: { schema: z.object({ body: z.string() }) } },
          actions: {
            publish: {
              input: z.object({}),
              handler: async (_input, ctx) => {
                await (
                  ctx.entities["note"] as unknown as EntityStoreAccessor<{ body: string }>
                ).create({
                  body: "must roll back",
                });
                const circular: { self?: unknown } = {};
                circular.self = circular;
                await ctx.events.publish("invalid.note.created", circular);
              },
            },
          },
        },
      ],
    });
    await kernel.boot();
    await expect(
      kernel.execute(
        "invalid.publish",
        {},
        {
          orgId: "org-a",
          actorId: "test",
          actorType: "system",
          roles: [],
          scopes: [],
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await db.transaction("org-a", async (tx) => {
      expect(await tx.entities.list("org-a", "note")).toEqual([]);
      expect(await tx.outbox.list()).toEqual([]);
    });
  });

  it("persists injected event identity, timestamp, and correlation metadata", async () => {
    const db = await storage();
    const id = "55555555-5555-4555-8555-555555555555";
    const occurredAt = new Date("2026-02-03T04:05:06.000Z");
    const kernel = new Kernel({
      eventId: () => id,
      now: () => occurredAt,
      storage: {
        ensureSchema: () => Promise.resolve(),
        transaction: db.transaction.bind(db),
        close: () => Promise.resolve(),
      },
      plugins: [
        {
          id: "publisher",
          version: "1.0.0",
          actions: {
            publish: {
              input: z.object({}),
              handler: (_input, ctx) => ctx.events.publish("publisher.note.created", { ok: true }),
            },
          },
        },
      ],
    });
    await kernel.boot();
    await kernel.execute(
      "publisher.publish",
      {},
      {
        principal: {
          orgId: "org-a",
          actorId: "test",
          actorType: "system",
          roles: [],
          scopes: ["publisher:*"],
        },
        requestId: "request-123",
      },
    );
    await db.transaction("org-a", async (tx) => {
      expect(await tx.outbox.list()).toMatchObject([
        {
          id,
          occurredAt: occurredAt.toISOString(),
          correlationId: "request-123",
          producerPluginId: "publisher",
        },
      ]);
    });
  });

  it("rejects entity reads from another org", async () => {
    const db = await storage();
    const id = "11111111-1111-4111-8111-111111111111";
    await db.transaction("org-a", (tx) =>
      tx.entities.create("org-a", "card", { id, data: { title: "private" } }),
    );
    await db.transaction("org-b", async (tx) => {
      expect(await tx.entities.get("org-b", "card", id)).toBeNull();
      expect(await tx.entities.list("org-b", "card")).toEqual([]);
      expect(await tx.entities.update("org-b", "card", id, { data: { title: "no" } })).toBeNull();
      expect(await tx.entities.delete("org-b", "card", id)).toBeNull();
    });
  });

  it("round-trips JSON and treats injection strings as data", async () => {
    const db = await storage();
    const payload = { quote: "' OR 1=1 --", nested: { ok: true }, array: [null, "☃"], nil: null };
    await db.transaction("org-a", (tx) => tx.entities.create("org-a", "card", { data: payload }));
    await db.transaction("org-a", async (tx) => {
      expect(
        await tx.entities.list("org-a", "card", { filter: { quote: "' OR 1=1 --" } }),
      ).toHaveLength(1);
    });
  });

  it("claims eligible outbox events once in scheduled order", async () => {
    const db = await storage();
    const now = "2026-01-01T00:00:00.000Z";
    await db.transaction("org-a", async (tx) => {
      await tx.outbox.enqueue("org-a", {
        id: "11111111-1111-4111-8111-111111111111",
        eventName: "later",
        payload: {},
        scheduledAt: "2026-01-01T00:01:00.000Z",
      });
      await tx.outbox.enqueue("org-a", {
        id: "22222222-2222-4222-8222-222222222222",
        eventName: "now",
        payload: {},
        scheduledAt: now,
      });
    });
    await db.transaction("org-a", async (tx) => {
      expect(
        (await tx.outbox.claimBatch({ workerId: "a", limit: 10, now })).map(
          (event) => event.eventName,
        ),
      ).toEqual(["now"]);
      expect(await tx.outbox.claimBatch({ workerId: "b", limit: 10, now })).toEqual([]);
    });
  });

  it("snapshots each event destination once and recovers expired delivery leases", async () => {
    const db = await storage();
    const eventId = "11111111-1111-4111-8111-111111111111";
    await db.transaction("org-a", async (tx) => {
      const input = {
        eventId,
        orgId: "org-a",
        destinationAppId: "email",
        destinationEndpoint: "https://email.example/",
        envelope: { id: eventId },
        scheduledAt: "2026-01-01T00:00:00.000Z",
      };
      await tx.eventDeliveries.create(input);
      await tx.eventDeliveries.create(input);
      expect(await tx.eventDeliveries.list()).toHaveLength(1);
      expect(
        await tx.eventDeliveries.claimBatch({
          workerId: "one",
          limit: 10,
          now: "2026-01-01T00:00:01.000Z",
          leaseMs: 1_000,
        }),
      ).toHaveLength(1);
      expect(
        await tx.eventDeliveries.claimBatch({
          workerId: "two",
          limit: 10,
          now: "2026-01-01T00:00:01.500Z",
          leaseMs: 1_000,
        }),
      ).toHaveLength(0);
      expect(
        await tx.eventDeliveries.claimBatch({
          workerId: "two",
          limit: 10,
          now: "2026-01-01T00:00:02.001Z",
          leaseMs: 1_000,
        }),
      ).toMatchObject([{ claimedBy: "two", attempts: 2 }]);
    });
  });

  it("reserves an inbox event only once", async () => {
    const db = await storage();
    await db.transaction("org-a", async (tx) => {
      expect(
        (await tx.inbox.reserve("11111111-1111-4111-8111-111111111111", "handler")).state,
      ).toBe("new");
      expect(
        (await tx.inbox.reserve("11111111-1111-4111-8111-111111111111", "handler")).state,
      ).toBe("in-progress");
      await tx.inbox.complete("11111111-1111-4111-8111-111111111111", "handler");
      expect(
        (await tx.inbox.reserve("11111111-1111-4111-8111-111111111111", "handler")).state,
      ).toBe("completed");
    });
  });
});
