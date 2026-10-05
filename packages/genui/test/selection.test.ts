import { expect, it } from "vitest";
import { z } from "zod";
import { createGenUiSession } from "../src/index.js";

const boardSchema = z.array(z.object({ id: z.string(), title: z.string() }));
const initial = [{ id: "task-1", title: "Before" }];

it("requires review of a preserved draft when the selected task changes", async () => {
  let board = initial;
  const mutations: unknown[] = [];
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: initial,
    snapshotSchema: boardSchema,
    readTarget: "cards.board",
    mutations: { "cards.update": z.object({ title: z.string() }) },
    items: (snapshot) => snapshot,
    dispatch: (target, input) => {
      if (target !== "cards.board") mutations.push(input);
      return Promise.resolve(board);
    },
  });
  await session.openItem("task-1");
  session.edit({ title: "My draft" });
  board = [{ id: "task-1", title: "Someone else's edit" }];
  await session.refresh();
  expect(session.state).toMatchObject({
    selectedId: "task-1",
    reviewRequired: true,
    draft: { title: "My draft" },
  });
  await session.submit("cards.update");
  expect(mutations).toEqual([]);
  session.confirmReview();
  await session.submit("cards.update");
  expect(mutations).toEqual([{ title: "My draft" }]);
  expect(session.state.reviewRequired).toBe(false);
});

it("cannot bypass draft review by reopening or silently carry a draft to another task", async () => {
  let board = [...initial, { id: "task-2", title: "Other" }];
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: board,
    snapshotSchema: boardSchema,
    readTarget: "cards.board",
    mutations: {},
    items: (snapshot) => snapshot,
    dispatch: () => Promise.resolve(board),
  });
  await session.openItem("task-1");
  session.edit({ title: "My draft" });
  board = [
    { id: "task-1", title: "Changed" },
    { id: "task-2", title: "Other" },
  ];
  await session.openItem("task-1");
  expect(session.state.reviewRequired).toBe(true);
  await expect(session.openItem("task-2")).rejects.toThrow(/discard/);
  expect(session.state.selectedId).toBe("task-1");
  await session.openItem("task-2", { discardDraft: true });
  expect(session.state.draft).toEqual({});
  expect(session.state).toMatchObject({ selectedId: "task-2", draft: {}, reviewRequired: false });
});

it("clears selection and its draft with a safe notice when a task disappears", async () => {
  let board = initial;
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: initial,
    snapshotSchema: boardSchema,
    readTarget: "cards.board",
    mutations: {},
    items: (snapshot) => snapshot,
    dispatch: () => Promise.resolve(board),
  });
  await session.openItem("task-1");
  session.edit({ title: "Private draft" });
  board = [];
  await session.refresh();
  expect(session.state.selectedId).toBeUndefined();
  expect(session.state.draft).toEqual({});
  expect(session.state).toMatchObject({
    draft: {},
    reviewRequired: false,
    notice: "selection-removed",
  });
});

it("refreshes authoritative data before opening a task", async () => {
  const requests: string[] = [];
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: initial,
    snapshotSchema: boardSchema,
    readTarget: "cards.board",
    mutations: {},
    items: (snapshot) => snapshot,
    dispatch: (target) => {
      requests.push(target);
      return Promise.resolve([{ id: "task-1", title: "Current" }]);
    },
  });
  await session.openItem("task-1");
  expect(requests).toEqual(["cards.board"]);
  expect(session.state).toMatchObject({
    selectedId: "task-1",
    snapshot: [{ title: "Current" }],
    reviewRequired: false,
  });
});
