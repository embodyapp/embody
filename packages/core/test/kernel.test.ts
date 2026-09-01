import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DependencyError,
  HookVetoError,
  Kernel,
  sortPlugins,
  type EmbodyPlugin,
} from "../src/index.js";

const plugin = (id: string, dependsOn?: readonly string[]): EmbodyPlugin => ({
  id,
  version: "1.0.0",
  ...(dependsOn === undefined ? {} : { dependsOn }),
});
const storage = () => ({
  ensureSchema: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
});

describe("plugin graph", () => {
  it("sorts independent plugins and dependencies deterministically", () => {
    const input = [
      plugin("leaf", ["left", "right"]),
      plugin("right", ["root"]),
      plugin("left", ["root"]),
      plugin("root"),
    ];
    expect(sortPlugins(input).map(({ id }) => id)).toEqual(["root", "left", "right", "leaf"]);
    expect(sortPlugins([...input].reverse()).map(({ id }) => id)).toEqual([
      "root",
      "left",
      "right",
      "leaf",
    ]);
  });
  it("fails missing dependencies and useful cycle paths before initialization", () => {
    expect(() => sortPlugins([plugin("a", ["missing"])])).toThrow(DependencyError);
    expect(() => sortPlugins([plugin("a", ["b"]), plugin("b", ["a"])])).toThrow("a -> b -> a");
  });
});

describe("kernel lifecycle", () => {
  it("runs the seven phases once for concurrent boots and exposes dependency services", async () => {
    const phases: string[] = [];
    const db = storage();
    const init = vi.fn();
    const kernel = new Kernel({
      storage: db,
      onPhase: (phase) => phases.push(phase),
      plugins: [
        {
          ...plugin("dependent", ["source"]),
          init: (ctx) => {
            expect(ctx.services.get<number>("source.value")).toBe(7);
            init();
          },
        },
        { ...plugin("source"), services: () => ({ value: 7 }) },
      ],
    });
    await Promise.all([kernel.boot(), kernel.boot()]);
    expect(phases).toEqual([
      "resolve",
      "schema",
      "services",
      "init",
      "registries",
      "manifest",
      "start",
    ]);
    expect(init).toHaveBeenCalledOnce();
    expect(db.ensureSchema).toHaveBeenCalledOnce();
    expect(kernel.state).toBe("ready");
    await kernel.boot();
    expect(init).toHaveBeenCalledOnce();
  });
  it("fails undeclared service access before later initialization and closes storage", async () => {
    const db = storage();
    const later = vi.fn();
    const kernel = new Kernel({
      storage: db,
      plugins: [
        { ...plugin("source"), services: () => ({ value: 7 }) },
        { ...plugin("other"), init: (ctx) => ctx.services.get("source.value") },
        { ...plugin("later", ["other"]), init: later },
      ],
    });
    await expect(kernel.boot()).rejects.toThrow("has not declared dependency");
    expect(later).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledOnce();
    expect(kernel.state).toBe("failed");
    await kernel.stop();
    expect(db.close).toHaveBeenCalledOnce();
  });
  it("rejects workflows until the deferred workflow contract is approved", async () => {
    const kernel = new Kernel({
      storage: storage(),
      plugins: [{ ...plugin("flow"), workflows: { work: { input: z.object({}), steps: {} } } }],
    });
    await expect(kernel.boot()).rejects.toThrow("UNSUPPORTED_WORKFLOW");
  });
  it("stops components in reverse order and is idempotent", async () => {
    const stopped: string[] = [];
    const db = storage();
    const kernel = new Kernel({
      storage: db,
      plugins: [],
      components: [
        {
          start: () => Promise.resolve(),
          stop: () => {
            stopped.push("one");
            return Promise.resolve();
          },
        },
        {
          stop: () => {
            stopped.push("two");
            return Promise.resolve();
          },
        },
      ],
    });
    await kernel.boot();
    await kernel.stop();
    await kernel.stop();
    expect(stopped).toEqual(["two", "one"]);
    expect(db.close).toHaveBeenCalledOnce();
  });
});

describe("hook registry", () => {
  it("runs hooks in plugin order and records deterministic traces", async () => {
    const calls: string[] = [];
    const kernel = new Kernel({
      storage: storage(),
      plugins: [
        {
          ...plugin("first"),
          hooks: {
            "card.beforeUpdate": () => {
              calls.push("first");
            },
          },
        },
        {
          ...plugin("second", ["first"]),
          hooks: {
            "card.beforeUpdate": () => {
              calls.push("second");
            },
          },
        },
      ],
    });
    await kernel.boot();
    const context = {} as never;
    const trace = await kernel.runHooks(
      "card.beforeUpdate",
      {},
      context,
      (() => {
        let time = 0;
        return () => ++time;
      })(),
    );
    expect(calls).toEqual(["first", "second"]);
    expect(trace.map(({ handlerId, outcome }) => [handlerId, outcome])).toEqual([
      ["first.card.beforeUpdate", "success"],
      ["second.card.beforeUpdate", "success"],
    ]);
  });
  it("stops at a veto", async () => {
    const later = vi.fn();
    const kernel = new Kernel({
      storage: storage(),
      plugins: [
        {
          ...plugin("guard"),
          hooks: {
            "card.beforeDelete": () => {
              throw new HookVetoError();
            },
          },
        },
        { ...plugin("later", ["guard"]), hooks: { "card.beforeDelete": later } },
      ],
    });
    await kernel.boot();
    await expect(kernel.runHooks("card.beforeDelete", {}, {} as never)).rejects.toBeInstanceOf(
      HookVetoError,
    );
    expect(later).not.toHaveBeenCalled();
  });
});
