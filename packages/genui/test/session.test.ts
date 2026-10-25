import { expect, it } from "vitest";
import { z } from "zod";
import { createGenUiSession } from "../src/index.js";

const snapshotSchema = z.object({ title: z.string() });
const inputSchema = z.object({ status: z.string(), prUrl: z.string().optional() });

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("prevents duplicate submissions and clears the draft only after authoritative refresh", async () => {
  const mutation = deferred();
  const refresh = deferred();
  const requests: string[] = [];
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: { "kanban.card.update": inputSchema },
    dispatch: (target) => {
      requests.push(target);
      return target === "kanban.board" ? refresh.promise : mutation.promise;
    },
  });
  session.edit({ status: "done" });
  const pending = session.submit("kanban.card.update");
  await session.submit("kanban.card.update");
  expect(requests).toEqual(["kanban.card.update"]);
  mutation.resolve({});
  await Promise.resolve();
  expect(session.state.draft).toEqual({ status: "done" });
  expect(requests).toEqual(["kanban.card.update", "kanban.board"]);
  refresh.resolve({ title: "After" });
  await pending;
  expect(session.state.draft).toEqual({});
  expect(session.state).toMatchObject({
    phase: "ready",
    snapshot: { title: "After" },
    draft: {},
    stale: false,
  });
});

it("cancels with unknown commit status and ignores a late mutation result", async () => {
  const mutation = deferred();
  const requests: string[] = [];
  let signal: AbortSignal | undefined;
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: { "kanban.card.update": inputSchema },
    dispatch: async (target, _input, requestSignal) => {
      requests.push(target);
      signal = requestSignal;
      return target === "kanban.board" ? { title: "Reconciled" } : mutation.promise;
    },
  });
  session.edit({ status: "done" });
  const pending = session.submit("kanban.card.update");
  session.cancel();
  expect(signal?.aborted).toBe(true);
  expect(session.state).toMatchObject({
    phase: "uncertain",
    stale: true,
    outcome: { status: "uncertain" },
  });
  await session.submit("kanban.card.update");
  expect(requests).toEqual(["kanban.card.update"]);
  await session.refresh();
  mutation.resolve({});
  await pending;
  expect(session.state).toMatchObject({
    phase: "ready",
    snapshot: { title: "Reconciled" },
    outcome: { status: "uncertain" },
    draft: { status: "done" },
  });
});

it("treats a lost mutation response as uncertain rather than a rejection", async () => {
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: { "kanban.card.update": inputSchema },
    dispatch: () => Promise.reject(new Error("connection lost with private details")),
  });
  session.edit({ status: "done" });
  await session.submit("kanban.card.update");
  expect(session.state).toMatchObject({
    phase: "uncertain",
    stale: true,
    outcome: { status: "uncertain" },
  });
  expect(JSON.stringify(session.state.outcome)).not.toContain("private");
});

it("never replaces a newer authoritative snapshot with a late read", async () => {
  const first = deferred();
  const second = deferred();
  const reads = [first, second];
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: {},
    dispatch: () => reads.shift()!.promise,
  });
  const oldRead = session.refresh();
  const newRead = session.refresh();
  second.resolve({ title: "Newer" });
  await newRead;
  first.resolve({ title: "Older" });
  await oldRead;
  expect(session.state.snapshot).toEqual({ title: "Newer" });
});

it("disposes a generation without retaining drafts or accepting late results", async () => {
  const result = deferred();
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: {},
    dispatch: () => result.promise,
  });
  session.edit({ prUrl: "secret draft" });
  const pending = session.refresh();
  session.dispose();
  result.resolve({ title: "After disposal" });
  await pending;
  expect(session.state).toMatchObject({
    phase: "disposed",
    draft: {},
    snapshot: { title: "Before" },
  });
  expect(session.state.draft).toEqual({});
  expect(() => session.edit({ status: "done" })).toThrow(/disposed/);
});

it("rejects oversized and cyclic drafts before changing local state", () => {
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: {},
    dispatch: () => Promise.resolve({}),
  });
  expect(() => session.edit({ value: "x".repeat(65_537) })).toThrow(/limit/);
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  expect(() => session.edit(cyclic)).toThrow(/JSON/);
  expect(session.state.draft).toEqual({});
});

it("shows safe local validation errors without issuing a mutation", async () => {
  const requests: string[] = [];
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: { "kanban.card.update": inputSchema },
    dispatch: (target) => {
      requests.push(target);
      return Promise.resolve({});
    },
  });
  session.edit({ prUrl: "private" });
  await session.submit("kanban.card.update");
  expect(requests).toEqual([]);
  expect(session.state).toMatchObject({
    phase: "rejected",
    draft: { prUrl: "private" },
    outcome: { status: "rejected", code: "VALIDATION_ERROR" },
  });
});

it("retains confirmed success when its authoritative refresh fails", async () => {
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: { "kanban.card.update": inputSchema },
    dispatch: (target) =>
      target === "kanban.board" ? Promise.reject(new Error("network secret")) : Promise.resolve({}),
  });
  session.edit({ status: "done" });
  await session.submit("kanban.card.update");
  expect(session.state).toMatchObject({
    phase: "stale",
    stale: true,
    draft: { status: "done" },
    outcome: { status: "confirmed" },
  });
});

it("clears the confirmed mutation draft when a failed refresh is later recovered", async () => {
  let failRead = true;
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: { "kanban.card.update": inputSchema },
    dispatch: (target) =>
      target === "kanban.board" && failRead
        ? Promise.reject(new Error("disconnected"))
        : Promise.resolve({ title: "After" }),
  });
  session.edit({ status: "done" });
  await session.submit("kanban.card.update");
  expect(session.state.draft).toEqual({ status: "done" });
  failRead = false;
  await session.refresh();
  expect(session.state.draft).toEqual({});
  expect(session.state).toMatchObject({ phase: "ready", outcome: { status: "confirmed" } });
});

it("preserves a newly edited draft when recovering a confirmed mutation's failed refresh", async () => {
  let failRead = true;
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: { "kanban.card.update": inputSchema },
    dispatch: (target) =>
      target === "kanban.board" && failRead
        ? Promise.reject(new Error("disconnected"))
        : Promise.resolve({ title: "After" }),
  });
  session.edit({ status: "done" });
  await session.submit("kanban.card.update");
  session.edit({ status: "in_review" });
  failRead = false;
  await session.refresh();
  expect(session.state.draft).toEqual({ status: "in_review" });
});

it("invalidates a changed resource generation without accepting late results and confirms draft discard", async () => {
  const read = deferred();
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { title: "Before" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: {},
    dispatch: () => read.promise,
  });
  session.edit({ prUrl: "private" });
  session.invalidateGeneration("g1");
  expect(session.state.phase).toBe("ready");
  const pending = session.refresh();
  session.invalidateGeneration("g2");
  read.resolve({ title: "Late old generation" });
  await pending;
  expect(session.state).toMatchObject({
    phase: "invalidated",
    generation: "g1",
    stale: true,
    draft: { prUrl: "private" },
    snapshot: { title: "Before" },
  });
  await expect(session.refresh()).rejects.toThrow(/invalidated/);
  expect(() => session.close()).toThrow(/discard/);
  session.close({ discardDraft: true });
  expect(session.state.draft).toEqual({});
  expect(session.state).toMatchObject({ phase: "disposed", draft: {} });
});

it("preserves an editable draft after a policy veto without publishing its fields", async () => {
  const session = createGenUiSession({
    generation: "generation-1",
    initialSnapshot: { title: "Sprint" },
    snapshotSchema,
    readTarget: "kanban.board",
    mutations: { "kanban.card.update": inputSchema },
    dispatch: () =>
      Promise.reject(Object.assign(new Error("secret server cause"), { code: "HOOK_VETO" })),
  });
  session.edit({ status: "done", prUrl: "sensitive draft" });
  await session.submit("kanban.card.update");
  expect(session.state).toMatchObject({
    phase: "rejected",
    draft: { status: "done", prUrl: "sensitive draft" },
    outcome: { target: "kanban.card.update", status: "rejected", code: "HOOK_VETO" },
  });
  expect(JSON.stringify(session.state.outcome)).not.toMatch(/sensitive|secret/);
  session.edit({ status: "in_review" });
  expect(session.state.draft).toEqual({ status: "in_review" });
});
