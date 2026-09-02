import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileEntity, z } from "@embody/core";

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
