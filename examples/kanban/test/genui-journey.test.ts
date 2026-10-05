import { createGenUiSession } from "@embody/genui";
import { createTestHarness } from "@embody/testing";
import { z } from "@embody/core";
import { expect, it } from "vitest";
import { kanbanPlugin, KanbanCardSchema } from "../src/plugin.js";

const recordSchema = z.object({ id: z.string(), data: KanbanCardSchema });
const snapshotSchema = z.array(recordSchema);
const updateSchema = z.object({
  id: z.string(),
  data: z.object({ status: z.literal("done"), prUrl: z.url().optional() }),
});

it("requires explicit draft review after an ordinary action changes the selected card", async () => {
  const harness = await createTestHarness({ plugins: [kanbanPlugin] });
  try {
    const card = recordSchema.parse(
      await harness.call("kanban.card.create", { data: { title: "Before" } }),
    );
    const session = createGenUiSession({
      generation: "fixture-1",
      initialSnapshot: snapshotSchema.parse(await harness.call("kanban.card.list", {})),
      snapshotSchema,
      readTarget: "kanban.card.list",
      mutations: { "kanban.card.update": updateSchema },
      items: (snapshot) => snapshot,
      dispatch: (target, input, signal) => harness.call(target, input, { signal }),
    });
    await session.openItem(card.id);
    session.edit({ id: card.id, data: { status: "done", prUrl: "https://example.com/pull/1" } });
    await harness.call("kanban.card.update", {
      id: card.id,
      data: { title: "Updated outside the view" },
    });
    await session.refresh();
    expect(session.state.reviewRequired).toBe(true);
    await session.submit("kanban.card.update");
    expect(
      recordSchema.parse(await harness.call("kanban.card.get", { id: card.id })).data.status,
    ).toBe("todo");
    session.confirmReview();
    await session.submit("kanban.card.update");
    expect(session.state).toMatchObject({
      draft: {},
      reviewRequired: false,
      snapshot: [{ data: { title: "Updated outside the view", status: "done" } }],
    });
    expect(session.state.draft).toEqual({});
    await harness.call("kanban.card.delete", { id: card.id });
    await session.refresh();
    expect(session.state.selectedId).toBeUndefined();
    expect(session.state.notice).toBe("selection-removed");
    session.dispose();
  } finally {
    await harness.close();
  }
});

it("preserves a vetoed agent draft, accepts correction, and refreshes from ordinary actions", async () => {
  const harness = await createTestHarness({
    plugins: [kanbanPlugin],
    principal: {
      orgId: "genui-test",
      actorId: "agent-1",
      actorType: "agent",
      roles: [],
      scopes: ["kanban:*"],
    },
  });
  try {
    const card = recordSchema.parse(
      await harness.call("kanban.card.create", { data: { title: "Add login" } }),
    );
    const session = createGenUiSession({
      generation: "fixture-1",
      initialSnapshot: snapshotSchema.parse(await harness.call("kanban.card.list", {})),
      snapshotSchema,
      readTarget: "kanban.card.list",
      mutations: { "kanban.card.update": updateSchema },
      items: (snapshot) => snapshot,
      dispatch: (target, input, signal) => harness.call(target, input, { signal }),
    });
    await session.openItem(card.id);
    session.edit({ id: card.id, data: { status: "done" } });
    await session.submit("kanban.card.update");
    expect(session.state).toMatchObject({
      phase: "rejected",
      selectedId: card.id,
      draft: { id: card.id, data: { status: "done" } },
      outcome: { code: "HOOK_VETO" },
    });
    expect(
      recordSchema.parse(await harness.call("kanban.card.get", { id: card.id })).data.status,
    ).toBe("todo");

    session.edit({ id: card.id, data: { status: "done", prUrl: "https://example.com/pull/1" } });
    await session.submit("kanban.card.update");
    expect(session.state).toMatchObject({
      phase: "ready",
      selectedId: card.id,
      reviewRequired: false,
      stale: false,
      draft: {},
      outcome: { status: "confirmed" },
      snapshot: [{ id: card.id, data: { status: "done" } }],
    });
    expect(session.state.draft).toEqual({});
    expect(JSON.stringify(session.state.outcome)).not.toContain("https://");
    session.dispose();
  } finally {
    await harness.close();
  }
});
