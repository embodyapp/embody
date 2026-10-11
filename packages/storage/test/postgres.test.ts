import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileEntity, HookVetoError, Kernel, z } from "@embody/core";

import { PostgresStorage } from "../src/index.js";

const connectionString = process.env["EMBODY_POSTGRES_URL"]?.trim() || undefined;
if (process.env["EMBODY_POSTGRES_REQUIRED"] === "true" && !connectionString)
  throw new Error("Mandatory PostgreSQL suite requires EMBODY_POSTGRES_URL");
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

  it("uses a non-owner role without elevated privileges or migration authority", async () => {
    const pool = new Pool({ connectionString });
    try {
      const role = await pool.query(
        "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      const owners = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'embody_%' AND tableowner = current_user",
      );
      expect(owners.rows).toEqual([]);
      const quoteRole = (url: string) =>
        `"${decodeURIComponent(new URL(url).username).replaceAll('"', '""')}"`;
      const migrationUrl = process.env["EMBODY_POSTGRES_MIGRATION_URL"];
      if (!migrationUrl) throw new Error("Isolation case requires EMBODY_POSTGRES_MIGRATION_URL");
      for (const sql of [
        "CREATE TABLE public.runtime_migration_attempt (id integer)",
        "ALTER TABLE embody_entities DISABLE ROW LEVEL SECURITY",
        "INSERT INTO embody_schema_migrations (version, applied_at) VALUES (99999, now())",
        `ALTER ROLE ${quoteRole(connectionString!)} BYPASSRLS`,
        `SET ROLE ${quoteRole(migrationUrl)}`,
      ])
        await expect(pool.query(sql)).rejects.toMatchObject({ code: "42501" });
      await expect(storage!.ensureSchema()).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pool.end();
    }
  });

  it("cannot bypass RLS via row_security=off or cross-tenant inserts", async () => {
    const pool = new Pool({ connectionString });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL row_security = off");
      await expect(client.query("SELECT * FROM embody_entities")).rejects.toMatchObject({
        code: "42501",
      });
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", ["runtime-tenant"]);
      await expect(
        client.query(
          "INSERT INTO embody_entities (id, org_id, entity_type, data, created_at, updated_at) VALUES ($1, $2, 'card', '{}', now(), now())",
          [randomUUID(), "other-tenant"],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });

  it("cannot connect to a second app database with its runtime credentials", async () => {
    const otherUrl = process.env["EMBODY_POSTGRES_OTHER_URL"];
    if (!otherUrl) throw new Error("Isolation case requires EMBODY_POSTGRES_OTHER_URL");
    const wrongDatabase = new URL(connectionString!);
    wrongDatabase.pathname = new URL(otherUrl).pathname;
    const otherPool = new Pool({ connectionString: wrongDatabase.href });
    try {
      await expect(otherPool.query("SELECT 1")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await otherPool.end();
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
