import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileEntity, Kernel, z } from "@embody/core";

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

  it("lets concurrent worker connections claim disjoint eligible events", async () => {
    const db = storage!;
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.transaction("claim-org", async (tx) => {
      for (const id of ids)
        await tx.outbox.enqueue("claim-org", { id, eventName: "card.created", payload: {} });
    });
    const other = new PostgresStorage({ connectionString });
    try {
      const [first, second] = await Promise.all([
        db.transaction("claim-org", (tx) => tx.outbox.claimBatch({ workerId: "one", limit: 4 })),
        other.transaction("claim-org", (tx) => tx.outbox.claimBatch({ workerId: "two", limit: 4 })),
      ]);
      const claimed = [...first, ...second].map(({ id }) => id);
      expect(claimed).toHaveLength(ids.length);
      expect(new Set(claimed)).toEqual(new Set(ids));
    } finally {
      await other.close();
    }
  });
});
