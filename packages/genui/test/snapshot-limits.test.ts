import { expect, it } from "vitest";
import { z } from "zod";
import { createGenUiSession } from "../src/index.js";

it("keeps the old snapshot stale when a refreshed snapshot exceeds limits", async () => {
  let validations = 0;
  const snapshotSchema = z.object({ text: z.string() }).superRefine(() => {
    validations++;
  });
  const session = createGenUiSession({
    generation: "g1",
    initialSnapshot: { text: "Before" },
    snapshotSchema,
    readTarget: "cards.board",
    mutations: {},
    dispatch: () => Promise.resolve({ text: "x".repeat(1_048_577) }),
  });
  await session.refresh();
  expect(session.state).toMatchObject({
    phase: "stale",
    stale: true,
    snapshot: { text: "Before" },
  });
  expect(validations).toBe(1);
});

it("rejects non-JSON schema output rather than retaining an unrenderable snapshot", () => {
  expect(() =>
    createGenUiSession({
      generation: "g1",
      initialSnapshot: "2026-10-02",
      snapshotSchema: z.string().transform((value) => new Date(value)),
      readTarget: "cards.board",
      mutations: {},
      dispatch: () => Promise.resolve("2026-10-02"),
    }),
  ).toThrow(/JSON/);
});

it.each(["depth", "count", "cycle"])(
  "rejects a snapshot exceeding its %s boundary before schema validation",
  (boundary) => {
    let value: unknown = null;
    if (boundary === "depth") for (let index = 0; index < 33; index++) value = { child: value };
    if (boundary === "count") value = Array.from({ length: 10_001 }, () => 0);
    if (boundary === "cycle") {
      const cyclic: Record<string, unknown> = {};
      cyclic["self"] = cyclic;
      value = cyclic;
    }
    let validations = 0;
    expect(() =>
      createGenUiSession({
        generation: "g1",
        initialSnapshot: value,
        snapshotSchema: z.unknown().superRefine(() => {
          validations++;
        }),
        readTarget: "cards.board",
        mutations: {},
        dispatch: () => Promise.resolve(null),
      }),
    ).toThrow(/limit|JSON/);
    expect(validations).toBe(0);
  },
);

it("rejects oversized initial snapshots before schema validation", () => {
  let validations = 0;
  const snapshotSchema = z.unknown().superRefine(() => {
    validations++;
  });
  expect(() =>
    createGenUiSession({
      generation: "g1",
      initialSnapshot: { text: "x".repeat(1_048_577) },
      snapshotSchema,
      readTarget: "cards.board",
      mutations: {},
      dispatch: () => Promise.resolve({}),
    }),
  ).toThrow(/limit/);
  expect(validations).toBe(0);
});
