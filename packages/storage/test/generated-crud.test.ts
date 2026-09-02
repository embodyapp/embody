import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, NotFoundError, ValidationError, z } from "@embody/core";
import { describe, expect, it } from "vitest";

import { SqliteStorage } from "../src/index.js";

const principal = {
  orgId: "org-a",
  actorId: "user-a",
  actorType: "human" as const,
  roles: [],
  scopes: [],
};

describe("generated entity CRUD", () => {
  it("registers five transactional actions with hooks and outbox events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "embody-crud-"));
    const storage = new SqliteStorage({ filename: join(directory, "storage.sqlite") });
    const calls: string[] = [];
    const kernel = new Kernel({
      storage,
      plugins: [
        {
          id: "kanban",
          version: "1.0.0",
          entities: {
            card: {
              schema: z.object({ title: z.string().min(1), status: z.string().default("todo") }),
            },
          },
          hooks: {
            "kanban.card.beforeCreate": () => {
              calls.push("before");
            },
            "kanban.card.afterCreate": () => {
              calls.push("after");
            },
            "kanban.card.beforeUpdate": () => {
              calls.push("beforeUpdate");
            },
            "kanban.card.afterUpdate": () => {
              calls.push("afterUpdate");
            },
            "kanban.card.beforeDelete": () => {
              calls.push("beforeDelete");
            },
            "kanban.card.afterDelete": () => {
              calls.push("afterDelete");
            },
          },
        },
      ],
    });
    await kernel.boot();
    expect(kernel.actionTargets).toEqual([
      "kanban.card.create",
      "kanban.card.delete",
      "kanban.card.get",
      "kanban.card.list",
      "kanban.card.update",
    ]);
    const created = (await kernel.execute(
      "kanban.card.create",
      { data: { title: "A" } },
      principal,
    )) as {
      id: string;
      data: { title: string; status: string };
    };
    expect(created.data).toEqual({ title: "A", status: "todo" });
    const updated = (await kernel.execute(
      "kanban.card.update",
      { id: created.id, data: { title: "B" } },
      principal,
    )) as { data: { title: string } };
    expect(updated.data.title).toBe("B");
    await kernel.execute("kanban.card.delete", { id: created.id }, principal);
    await expect(
      kernel.execute("kanban.card.get", { id: created.id }, principal),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kernel.execute("kanban.card.create", { data: { title: "", extra: true } }, principal),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toEqual([
      "before",
      "after",
      "beforeUpdate",
      "afterUpdate",
      "beforeDelete",
      "afterDelete",
    ]);
    const events = await storage.transaction("org-a", (tx) => tx.outbox.list());
    expect(events.map(({ eventName }) => eventName)).toEqual([
      "kanban.card.created",
      "kanban.card.updated",
      "kanban.card.deleted",
    ]);
    await kernel.stop();
  });
});
