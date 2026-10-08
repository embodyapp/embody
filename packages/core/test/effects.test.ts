import { describe, expect, it } from "vitest";
import {
  actionEffect,
  Kernel,
  appManifestSchema,
  compileManifest,
  definePlugin,
  defineWorkflow,
  ValidationError,
  z,
} from "../src/index.js";

const step = { handler: () => ({ ok: true }) };

function manifestWith(actions: Record<string, unknown>) {
  return compileManifest([
    definePlugin({ id: "demo", version: "1.0.0", actions: actions as never }),
  ]);
}

describe("action effects", () => {
  it("marks generated CRUD actions", () => {
    const manifest = compileManifest([
      definePlugin({
        id: "kanban",
        version: "1.0.0",
        entities: { card: { schema: z.object({ title: z.string() }) } },
      }),
    ]);
    const effects = Object.fromEntries(
      Object.entries(manifest.actions).map(([target, action]) => [
        target,
        { effect: action.effect, idempotent: action.idempotent },
      ]),
    );
    expect(effects).toEqual({
      "kanban.card.create": { effect: "write", idempotent: undefined },
      "kanban.card.delete": { effect: "destructive", idempotent: undefined },
      "kanban.card.get": { effect: "read", idempotent: undefined },
      "kanban.card.list": { effect: "read", idempotent: undefined },
      "kanban.card.update": { effect: "write", idempotent: true },
    });
  });

  it("marks workflow controls", () => {
    const flow = defineWorkflow(z.object({}))({ version: "1.0.0", steps: { only: step } });
    const manifest = compileManifest([
      definePlugin({ id: "ops", version: "1.0.0", workflows: { flow } }),
    ]);
    expect(
      Object.fromEntries(
        Object.entries(manifest.actions).map(([target, action]) => [target, action.effect]),
      ),
    ).toEqual({
      "ops.flow.cancel": "destructive",
      "ops.flow.retry": "write",
      "ops.flow.start": "write",
      "ops.flow.status": "read",
    });
  });

  it("passes declared custom action metadata through and defaults to write", () => {
    const manifest = manifestWith({
      board: { title: "Board", effect: "read", input: z.object({}), handler: () => ({}) },
      move: { effect: "write", idempotent: true, input: z.object({}), handler: () => ({}) },
      legacy: { input: z.object({}), handler: () => ({}) },
    });
    expect(manifest.actions["demo.board"]).toMatchObject({ title: "Board", effect: "read" });
    expect(manifest.actions["demo.move"]).toMatchObject({ effect: "write", idempotent: true });
    expect(manifest.actions["demo.legacy"]?.effect).toBeUndefined();
    expect(actionEffect(manifest.actions["demo.legacy"]!)).toBe("write");
    expect(actionEffect(manifest.actions["demo.board"]!)).toBe("read");
  });

  it("rejects invalid action titles", () => {
    for (const title of ["", "   ", "x".repeat(81), "two\nlines", "bell\u0007"])
      expect(() =>
        manifestWith({ bad: { title, input: z.object({}), handler: () => ({}) } }),
      ).toThrow(ValidationError);
  });
});

describe("app metadata", () => {
  it("is included only when provided", () => {
    expect(compileManifest([]).app).toBeUndefined();
    expect(compileManifest([], { app: {} }).app).toBeUndefined();
    expect(
      compileManifest([], {
        app: { title: "Kanban", description: "Cards.\nColumns.", instructions: "Use list first." },
      }).app,
    ).toEqual({
      title: "Kanban",
      description: "Cards.\nColumns.",
      instructions: "Use list first.",
    });
  });

  it("rejects oversized, blank, multi-line titles and control characters", () => {
    for (const app of [
      { title: "x".repeat(81) },
      { title: "a\nb" },
      { title: " " },
      { description: "x".repeat(501) },
      { instructions: "x".repeat(2049) },
      { description: "hidden‮text" },
    ])
      expect(() => compileManifest([], { app })).toThrow(ValidationError);
  });

  it("is accepted by the protocol schema, which still accepts manifests without it", () => {
    const withMetadata = compileManifest(
      [
        definePlugin({
          id: "demo",
          version: "1.0.0",
          actions: {
            ping: { effect: "read", title: "Ping", input: z.object({}), handler: () => ({}) },
          },
        }),
      ],
      { app: { title: "Demo" } },
    );
    expect(appManifestSchema.safeParse(withMetadata).success).toBe(true);
    expect(appManifestSchema.safeParse(compileManifest([])).success).toBe(true);
    expect(appManifestSchema.safeParse({ ...withMetadata, app: { title: "a\nb" } }).success).toBe(
      false,
    );
    expect(
      appManifestSchema.safeParse({
        ...withMetadata,
        actions: { "demo.ping": { ...withMetadata.actions["demo.ping"], effect: "delete" } },
      }).success,
    ).toBe(false);
  });
});

describe("kernel app metadata", () => {
  it("includes the configured app metadata in the booted manifest", async () => {
    const kernel = new Kernel({
      plugins: [],
      storage: { ensureSchema: () => Promise.resolve(), close: () => Promise.resolve() },
      app: { title: "Demo", instructions: "Read before writing." },
    });
    await kernel.boot();
    expect(kernel.manifest.app).toEqual({ title: "Demo", instructions: "Read before writing." });
  });
});
