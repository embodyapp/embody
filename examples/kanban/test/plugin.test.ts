import { createTestHarness } from "@embody/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { EntityRecord, Principal } from "@embody/core";
import { kanbanPlugin, type KanbanCard } from "../src/plugin.js";

const harnesses: { close(): Promise<void> }[] = [];
async function harness(principal?: Principal) {
  const value = await createTestHarness({
    plugins: [kanbanPlugin],
    ...(principal === undefined ? {} : { principal }),
  });
  harnesses.push(value);
  return value;
}
async function card(h: Awaited<ReturnType<typeof harness>>, data: Partial<KanbanCard> = {}) {
  return (await h.call("kanban.card.create", {
    data: { title: "Implement reference app", ...data },
  })) as EntityRecord<KanbanCard>;
}
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((value) => value.close()));
});

describe("Kanban reference plugin", () => {
  it("applies exact card defaults and validation", async () => {
    const h = await harness();
    const created = await card(h);
    expect(created.data).toMatchObject({ status: "todo", priority: "medium" });
    await expect(
      h.call("kanban.card.create", { data: { title: "", prUrl: "not-a-url" } }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("vetoes an agent completion without a PR and rolls back", async () => {
    const h = await harness();
    const created = await card(h);
    await expect(
      h.call("kanban.card.update", { id: created.id, data: { status: "done" } }),
    ).rejects.toMatchObject({ code: "HOOK_VETO" });
    expect(
      (await h.call("kanban.card.get", { id: created.id })) as EntityRecord<KanbanCard>,
    ).toMatchObject({
      data: { status: "todo" },
    });
    expect(
      (await h.events()).filter((event) => event.eventName === "kanban.card.ready_for_review"),
    ).toHaveLength(0);
  });

  it("allows agent completion when the card already has or receives a valid PR", async () => {
    const h = await harness();
    const created = await card(h);
    await expect(
      h.call("kanban.card.update", {
        id: created.id,
        data: { status: "done", prUrl: "https://github.com/embody/embody/pull/10" },
      }),
    ).resolves.toMatchObject({ data: { status: "done" } });
  });

  it("does not apply the agent guardrail to human actors", async () => {
    const h = await harness({
      orgId: "test",
      actorId: "human",
      actorType: "human",
      roles: [],
      scopes: ["kanban:*"],
    });
    const created = await card(h);
    await expect(
      h.call("kanban.card.update", { id: created.id, data: { status: "done" } }),
    ).resolves.toMatchObject({
      data: { status: "done" },
    });
  });

  it("emits ready_for_review exactly once per transition", async () => {
    const h = await harness();
    const created = await card(h);
    await h.call("kanban.card.update", { id: created.id, data: { status: "in_review" } });
    await h.call("kanban.card.update", { id: created.id, data: { title: "Still in review" } });
    expect(
      (await h.events()).filter((event) => event.eventName === "kanban.card.ready_for_review"),
    ).toHaveLength(1);
  });

  it("bulkMove is atomic and rejects empty or duplicate IDs", async () => {
    const h = await harness();
    const first = await card(h, { prUrl: "https://example.com/pr/1" });
    const second = await card(h);
    await expect(
      h.call("kanban.bulkMove", { cardIds: [], newStatus: "in_progress" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      h.call("kanban.bulkMove", { cardIds: [first.id, first.id], newStatus: "in_progress" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      h.call("kanban.bulkMove", { cardIds: [first.id, second.id], newStatus: "done" }),
    ).rejects.toMatchObject({
      code: "HOOK_VETO",
    });
    const listed = (await h.call("kanban.card.list", {})) as readonly EntityRecord<KanbanCard>[];
    expect(listed.map((value) => value.data.status)).toEqual(["todo", "todo"]);
  });

  it("advertises generated CRUD actions and bulkMove", async () => {
    const h = await harness();
    expect(Object.keys(h.kernel.manifest.actions)).toEqual([
      "kanban.bulkMove",
      "kanban.card.create",
      "kanban.card.delete",
      "kanban.card.get",
      "kanban.card.list",
      "kanban.card.update",
    ]);
    expect(h.kernel.manifest.entities["kanban.card"]?.indexes).toEqual([
      "assigneeId",
      "priority",
      "status",
    ]);
  });
});
