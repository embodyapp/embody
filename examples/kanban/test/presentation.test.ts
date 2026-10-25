import { createTestHarness } from "@embody/testing";
import { expect, it } from "vitest";
import { kanbanPlugin, KanbanBoardSchema } from "../src/plugin.js";
import { renderGenUiText, renderGenUiMarkdown, parseGenUiEvent } from "@embody/genui";
import { createKanbanBoardDocument, createKanbanTaskDocument } from "../src/presentation.js";

it("renders the real board and task details while leaving mutation validation in the kernel", async () => {
  const harness = await createTestHarness({ plugins: [kanbanPlugin] });
  try {
    await harness.call("kanban.card.create", { data: { title: "Add <script>login</script>" } });
    const result = KanbanBoardSchema.parse(await harness.call("kanban.board", {}));
    const card = result.cards[0]!;
    const board = createKanbanBoardDocument(result);
    expect(renderGenUiText(board)).toContain("Add <script>login</script>");
    expect(renderGenUiMarkdown(board)).toContain("&lt;script&gt;login&lt;/script&gt;");
    const details = createKanbanTaskDocument(card);
    const input = parseGenUiEvent(
      details,
      "complete-task",
      { id: card.id, data: { status: "done" } },
      { callableTargets: ["kanban.card.update"] },
    );
    await expect(harness.call("kanban.card.update", input)).rejects.toMatchObject({
      code: "HOOK_VETO",
    });
    const corrected = parseGenUiEvent(
      details,
      "complete-task",
      { id: card.id, data: { status: "done", prUrl: "https://example.com/pr/1" } },
      { callableTargets: ["kanban.card.update"] },
    );
    await harness.call("kanban.card.update", corrected);
    expect(
      KanbanBoardSchema.parse(await harness.call("kanban.board", {})).cards[0]?.data.status,
    ).toBe("done");
    expect(
      renderGenUiText(
        createKanbanTaskDocument({
          ...card,
          data: { ...card.data, prUrl: "https://private.example/pr/1" },
        }),
      ),
    ).not.toContain("https://private");
  } finally {
    await harness.close();
  }
});

it("bounds board pages and exposes an explicit continuation without silently hiding tasks", async () => {
  const harness = await createTestHarness({ plugins: [kanbanPlugin] });
  try {
    for (let index = 0; index < 21; index++)
      await harness.call("kanban.card.create", { data: { title: `Task ${index}` } });
    const first = KanbanBoardSchema.parse(await harness.call("kanban.board", {}));
    expect(first.cards).toHaveLength(20);
    expect(first.nextOffset).toBe(20);
    expect(renderGenUiText(createKanbanBoardDocument(first))).toContain("More tasks are available");
    const second = KanbanBoardSchema.parse(
      await harness.call("kanban.board", { offset: first.nextOffset }),
    );
    expect(second.cards).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.cards, ...second.cards].map((card) => card.id)).size).toBe(21);
  } finally {
    await harness.close();
  }
});

it("returns an ordinary validated board snapshot independently of rendering", async () => {
  const harness = await createTestHarness({ plugins: [kanbanPlugin] });
  try {
    await harness.call("kanban.card.create", { data: { title: "Add login" } });
    expect(await harness.call("kanban.board", {})).toMatchObject({
      title: "Kanban board",
      cards: [{ data: { title: "Add login", status: "todo" } }],
      nextOffset: null,
    });
    expect(harness.kernel.manifest.actions["kanban.board"]?.outputSchema).toMatchObject({
      type: "object",
    });
  } finally {
    await harness.close();
  }
});
