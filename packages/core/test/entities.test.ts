/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileEntity,
  NotFoundError,
  ValidationError,
  type EntityRecord,
  type EntityTransaction,
} from "../src/index.js";

const card = z.object({
  title: z.string().min(1),
  status: z.enum(["todo", "done"]).default("todo"),
  metadata: z.object({ lane: z.string() }).optional(),
});
type Card = z.output<typeof card>;

function transaction(): EntityTransaction & { readonly calls: unknown[][] } {
  const records = new Map<string, EntityRecord<Card>>();
  const calls: unknown[][] = [];
  let sequence = 0;
  return {
    calls,
    entities: {
      create: async (orgId: string, entityType: string, { data }: { data: unknown }) => {
        const record = {
          id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
          orgId,
          entityType,
          data: data as Card,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        records.set(record.id, record);
        return record;
      },
      get: async (orgId: string, entityType: string, id: string) => {
        calls.push(["get", orgId, entityType, id]);
        const record = records.get(id);
        return record?.orgId === orgId && record.entityType === entityType ? record : null;
      },
      list: async (orgId: string, entityType: string, options: unknown) => {
        calls.push(["list", orgId, entityType, options]);
        return [...records.values()].filter(
          (record) => record.orgId === orgId && record.entityType === entityType,
        );
      },
      update: async (
        orgId: string,
        entityType: string,
        id: string,
        { data }: { data: unknown },
      ) => {
        const current = records.get(id);
        if (current?.orgId !== orgId || current.entityType !== entityType) return null;
        const updated = { ...current, data: data as Card, updatedAt: "2026-01-01T00:00:01.000Z" };
        records.set(id, updated);
        return updated;
      },
      delete: async (orgId: string, entityType: string, id: string) => {
        const current = records.get(id);
        if (current?.orgId !== orgId || current.entityType !== entityType) return null;
        records.delete(id);
        return current;
      },
    } as EntityTransaction["entities"],
  };
}

describe("contextual entity stores", () => {
  it("binds every operation to its transaction org and applies schema defaults", async () => {
    const tx = transaction();
    const store = compileEntity<Card>("kanban", "card", { schema: card }).createStore("org-a", tx);
    const created = await store.create({ title: "A" } as Card);
    expect(created).toMatchObject({ orgId: "org-a", entityType: "card", data: { status: "todo" } });
    await expect(store.get("00000000-0000-4000-8000-000000000002")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(tx.calls).toContainEqual([
      "get",
      "org-a",
      "card",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("validates declared filter and sort paths and normalizes pagination defaults", async () => {
    const tx = transaction();
    const store = compileEntity<Card>("kanban", "card", {
      schema: card,
      defaultSort: { field: "title", direction: "asc" },
    }).createStore("org-a", tx);
    await store.list({ filter: { metadata: { lane: "now" } } });
    expect(tx.calls.at(-1)).toEqual([
      "list",
      "org-a",
      "card",
      {
        filter: { metadata: { lane: "now" } },
        sort: { field: "title", direction: "asc" },
        limit: 20,
        offset: 0,
      },
    ]);
    await expect(store.list({ filter: { sql: "x" } as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      store.list({ sort: { field: "sql" as never, direction: "asc" } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(store.list({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates the complete merged update rather than accepting a partial invalid record", async () => {
    const tx = transaction();
    const store = compileEntity<Card>("kanban", "card", { schema: card }).createStore("org-a", tx);
    const created = await store.create({ title: "A" } as Card);
    const updated = await store.update(created.id, { title: "B" });
    expect(updated.data).toMatchObject({ title: "B", status: "todo" });
    await expect(store.update(created.id, { title: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(store.update(created.id, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("bulk reads preserve order and bulk updates reject unsafe inputs", async () => {
    const tx = transaction();
    const store = compileEntity<Card>("kanban", "card", { schema: card }).createStore("org-a", tx);
    // Use the repository fixture's stable first ID and an explicitly inserted second record.
    const first = await store.create({ title: "A" } as Card);
    const second = await store.create({ title: "B" } as Card);

    expect((await store.getMany([second.id, first.id])).map(({ id }) => id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(await store.getMany([])).toEqual([]);
    await expect(
      store.getMany([first.id, "00000000-0000-4000-8000-999999999999"]),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.updateMany([])).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.updateMany([
        { id: first.id, data: { status: "done" } },
        { id: first.id, data: { title: "duplicate" } },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects invalid declarations during compilation", () => {
    expect(() => compileEntity("kanban", "card", { schema: card, indexes: ["missing"] })).toThrow(
      ValidationError,
    );
    expect(() =>
      compileEntity("kanban", "card", {
        schema: card,
        defaultSort: { field: "missing", direction: "asc" },
      }),
    ).toThrow(ValidationError);
  });
});
