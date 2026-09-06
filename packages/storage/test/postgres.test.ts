import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileEntity, HookVetoError, Kernel, z } from "@embody/core";

import { PostgresStorage } from "../src/index.js";

const connectionString = process.env["EMBODY_POSTGRES_URL"];
const describePostgres = connectionString === undefined ? describe.skip : describe;
let storage: PostgresStorage | undefined;

beforeAll(async () => {
  if (connectionString === undefined) return;
  storage = new PostgresStorage({ connectionString });
  if (process.env["EMBODY_POSTGRES_SKIP_SCHEMA"] !== "true") await storage.ensureSchema();
});
afterAll(async () => {
  await storage?.close();
});

describePostgres("PostgreSQL storage conformance", () => {
  it("provides a contextual store with nested JSON filters", async () => {
    const db = storage!;
    const entity = compileEntity("kanban", "card", {
      schema: z.object({
        title: z.string(),
        metadata: z.object({ lane: z.string(), rank: z.number() }),
      }),
      defaultSort: { field: "title", direction: "asc" },
    });
    await db.transaction(`entity-${randomUUID()}`, async (tx) => {
      const store = entity.createStore(tx.orgId, tx);
      await store.create({ title: "B", metadata: { lane: "now", rank: 1 } });
      await store.create({ title: "A", metadata: { lane: "now", rank: 2 } });
      await store.create({ title: "C", metadata: { lane: "later", rank: 1 } });
      expect(await store.list({ filter: { metadata: { lane: "now" } } })).toMatchObject([
        { data: { title: "A" } },
        { data: { title: "B" } },
      ]);
    });
  });

  it("rolls back bulk updates, lifecycle hooks, and events as one transaction", async () => {
    const db = storage!;
    const orgId = `bulk-${randomUUID()}`;
    const entity = compileEntity<{ title: string; status: "todo" | "done" }>("kanban", "card", {
      schema: z.object({ title: z.string().min(1), status: z.enum(["todo", "done"]) }),
    });
    const [first, second] = await db.transaction(orgId, async (tx) => {
      const store = entity.createStore(orgId, tx);
      return Promise.all([
        store.create({ title: "First", status: "todo" }),
        store.create({ title: "Second", status: "todo" }),
      ]);
    });

    await db.transaction(orgId, async (tx) => {
      const store = entity.createStore(orgId, tx);
      expect(await store.getMany([first.id, second.id])).toHaveLength(2);
    });

    await expect(
      db.transaction(orgId, async (tx) => {
        const store = entity.createStore(orgId, {
          ...tx,
          lifecycle: {
            beforeUpdate: (payload) => {
              const current = (payload as { current: { id: string } }).current;
              if (current.id === second.id) throw new HookVetoError("second card is guarded");
              return Promise.resolve();
            },
            publish: (eventName, payload) =>
              tx.outbox.enqueue(orgId, { eventName, payload }).then(() => undefined),
          },
        });
        await store.updateMany([
          { id: first.id, data: { status: "done" } },
          { id: second.id, data: { status: "done" } },
        ]);
      }),
    ).rejects.toBeInstanceOf(HookVetoError);

    await db.transaction(orgId, async (tx) => {
      const store = entity.createStore(orgId, tx);
      expect((await store.getMany([second.id, first.id])).map(({ data }) => data.status)).toEqual([
        "todo",
        "todo",
      ]);
      expect(await tx.outbox.list()).toEqual([]);
    });
  });

  it("executes generated CRUD actions transactionally", async () => {
    const db = storage!;
    const kernel = new Kernel({
      storage: {
        ensureSchema: () => Promise.resolve(),
        transaction: db.transaction.bind(db),
        close: () => Promise.resolve(),
      },
      plugins: [
        {
          id: "generated",
          version: "1.0.0",
          entities: { note: { schema: z.object({ body: z.string().min(1) }) } },
        },
      ],
    });
    await kernel.boot();
    const principal = {
      orgId: `generated-${randomUUID()}`,
      actorId: "tester",
      actorType: "system" as const,
      roles: [],
      scopes: [],
    };
    const created = (await kernel.execute(
      "generated.note.create",
      { data: { body: "hello" } },
      principal,
    )) as { id: string };
    await kernel.execute("generated.note.delete", { id: created.id }, principal);
    await expect(
      kernel.execute("generated.note.get", { id: created.id }, principal),
    ).rejects.toThrow("Entity was not found");
    await kernel.stop();
  });

  it("enforces RLS for raw reads and uses SET LOCAL tenant identity", async () => {
    const db = storage!;
    const id = randomUUID();
    await db.transaction("rls-owner", (tx) =>
      tx.entities.create("rls-owner", "card", { id, data: { title: "private" } }),
    );
    const pool = new Pool({ connectionString });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", ["another-org"]);
      expect(
        (await client.query("SELECT id FROM embody_entities WHERE id = $1", [id])).rows,
      ).toEqual([]);
      await client.query("COMMIT");
      expect(
        (await client.query("SELECT current_setting('app.current_org', true) AS org")).rows[0]?.[
          "org"
        ],
      ).toBe("");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });

  it("persists and exclusively claims durable workflow DAG steps", async () => {
    const db = storage!;
    const orgId = `workflow-${randomUUID()}`;
    const instanceId = randomUUID();
    await db.transaction(orgId, (tx) =>
      tx.workflows.start({
        id: instanceId,
        orgId,
        definition: "orders.fulfil",
        definitionVersion: "1.0.0",
        idempotencyKey: "one",
        inputHash: "hash",
        input: { orderId: "one" },
        principal: {
          orgId,
          actorId: "tester",
          actorType: "human",
          roles: [],
          scopes: ["orders:*"],
        },
        now: new Date().toISOString(),
        steps: [
          {
            id: randomUUID(),
            name: "reserve",
            dependencies: [],
            scheduledAt: new Date().toISOString(),
            compensatable: true,
          },
        ],
      }),
    );
    const other = new PostgresStorage({ connectionString });
    try {
      const [first, second] = await Promise.all([
        db.transaction(orgId, (tx) => tx.workflows.claimBatch({ workerId: "one", limit: 10 })),
        other.transaction(orgId, (tx) => tx.workflows.claimBatch({ workerId: "two", limit: 10 })),
      ]);
      expect(first.length + second.length).toBe(1);
      expect(
        (await db.transaction(orgId, (tx) => tx.workflows.get(instanceId)))?.steps[0]?.attempt,
      ).toBe(1);
    } finally {
      await other.close();
    }
  });

  it("lets concurrent delivery workers claim disjoint destinations", async () => {
    const db = storage!;
    const orgId = `delivery-${randomUUID()}`;
    const eventId = randomUUID();
    await db.transaction(orgId, async (tx) => {
      for (let index = 0; index < 100; index++)
        await tx.eventDeliveries.create({
          eventId,
          orgId,
          destinationAppId: `app-${index}`,
          destinationEndpoint: `https://app-${index}.example/`,
          envelope: { id: eventId },
        });
    });
    const other = new PostgresStorage({ connectionString });
    try {
      const [first, second] = await Promise.all([
        db.transaction(orgId, (tx) =>
          tx.eventDeliveries.claimBatch({ workerId: "one", limit: 50 }),
        ),
        other.transaction(orgId, (tx) =>
          tx.eventDeliveries.claimBatch({ workerId: "two", limit: 50 }),
        ),
      ]);
      expect(first).toHaveLength(50);
      expect(second).toHaveLength(50);
      expect(new Set([...first, ...second].map(({ id }) => id)).size).toBe(100);
    } finally {
      await other.close();
    }
  });

  it("lets two workers claim 1,000 events without duplicate claims", async () => {
    const db = storage!;
    const ids = Array.from({ length: 1_000 }, () => randomUUID());
    const orgId = `claim-${randomUUID()}`;
    await db.transaction(orgId, async (tx) => {
      for (const id of ids)
        await tx.outbox.enqueue(orgId, { id, eventName: "card.created", payload: {} });
    });
    const other = new PostgresStorage({ connectionString });
    try {
      const claimed: string[] = [];
      for (let batch = 0; batch < 10; batch++) {
        const [first, second] = await Promise.all([
          db.transaction(orgId, (tx) => tx.outbox.claimBatch({ workerId: "one", limit: 50 })),
          other.transaction(orgId, (tx) => tx.outbox.claimBatch({ workerId: "two", limit: 50 })),
        ]);
        claimed.push(...first.map(({ id }) => id), ...second.map(({ id }) => id));
      }
      expect(claimed).toHaveLength(ids.length);
      expect(new Set(claimed)).toEqual(new Set(ids));
    } finally {
      await other.close();
    }
  });
});
