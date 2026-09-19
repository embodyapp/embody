import { describe, expect, it } from "vitest";
import { appManifestSchema, compileManifest, definePlugin, stableStringify, z } from "@embody/core";
import {
  compileGenUiManifest,
  defineGenUi,
  GENUI_MAX_RESOURCE_BYTES,
  GENUI_MAX_VIEWS,
  defineView,
  genUiResourceIntegrity,
  genUiResourceUri,
  withGenUi,
} from "../src/index.js";

const boardResult = z.object({
  title: z.string(),
  cards: z.array(z.object({ id: z.string(), title: z.string() })),
});
const plugin = definePlugin({
  id: "cards",
  version: "1.0.0",
  actions: {
    board: {
      input: z.object({}),
      output: boardResult,
      handler: () => ({ title: "Sprint", cards: [] }),
    },
    move: {
      input: z.object({ id: z.string() }),
      output: z.object({ moved: z.boolean() }),
      handler: () => ({ moved: true }),
    },
    noOutput: {
      input: z.object({}),
      handler: () => undefined,
    },
  },
});
const html = '<!doctype html><html><body><main id="app"></main></body></html>';

function definition() {
  return defineGenUi({
    views: {
      board: defineView({
        kind: "standard",
        version: "1.0.0",
        description: "Sprint board",
        props: boardResult,
        resource: { text: html, metadata: { prefersBorder: true } },
        callableTargets: ["cards.move"],
        fallback: "markdown",
      }),
    },
    actions: { "cards.board": "board" },
  });
}

function app() {
  return { appId: "kanban", version: "1.0.0", plugins: [plugin] as const };
}

// Runtime validation is defense in depth for JavaScript and deliberately cast TypeScript callers.
function unsafeWithGenUi(definition: unknown) {
  return withGenUi(app(), definition as never);
}

describe("GenUI contracts", () => {
  it("binds a typed action output to an immutable view and enriches its manifest", () => {
    const configured = withGenUi(app(), definition());
    const base = compileManifest(configured.plugins);
    const manifest = compileGenUiManifest(configured, base);

    expect(manifest.actions["cards.board"]?.presentation).toEqual({ view: "board" });
    expect(manifest.actions["cards.move"]?.presentation).toBeUndefined();
    expect(manifest.views?.["board"]).toMatchObject({
      protocolVersion: 1,
      id: "board",
      kind: "standard",
      version: "1.0.0",
      resourceUri: "ui://kanban/board@1.0.0",
      callableTargets: ["cards.move"],
      fallback: "markdown",
      integrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      propsSchema: { type: "object" },
    });
    expect(appManifestSchema.parse(manifest)).toEqual(manifest);
    expect(base.views).toBeUndefined();
    expect(base.actions["cards.board"]?.presentation).toBeUndefined();
  });

  it("is deterministic across view and callable-target insertion order", () => {
    const secondResult = z.object({ value: z.string() });
    const secondPlugin = definePlugin({
      id: "second",
      version: "1.0.0",
      actions: {
        show: {
          input: z.object({}),
          output: secondResult,
          handler: () => ({ value: "ok" }),
        },
      },
    });
    const application = {
      appId: "demo",
      version: "1.0.0",
      plugins: [plugin, secondPlugin] as const,
    };
    const board = definition().views.board;
    const second = defineView({
      kind: "custom",
      version: "1.1.0",
      props: secondResult,
      resource: { text: "<!doctype html><title>Second</title>" },
      callableTargets: ["second.show", "cards.move"],
      fallback: "text",
    });
    const left = withGenUi(
      application,
      defineGenUi({
        views: { board, second },
        actions: { "cards.board": "board", "second.show": "second" },
      }),
    );
    const right = withGenUi(
      application,
      defineGenUi({
        views: { second, board },
        actions: { "second.show": "second", "cards.board": "board" },
      }),
    );

    expect(stableStringify(compileGenUiManifest(left))).toBe(
      stableStringify(compileGenUiManifest(right)),
    );
    expect(compileGenUiManifest(left).views?.["second"]?.callableTargets).toEqual([
      "cards.move",
      "second.show",
    ]);
  });

  it("hashes resource bytes and metadata but never action data", () => {
    const resource = { text: html, metadata: { prefersBorder: true } } as const;
    expect(genUiResourceIntegrity(resource)).toBe(genUiResourceIntegrity(resource));
    expect(genUiResourceIntegrity({ ...resource, text: `${html}\n` })).not.toBe(
      genUiResourceIntegrity(resource),
    );
    expect(genUiResourceIntegrity({ ...resource, metadata: { prefersBorder: false } })).not.toBe(
      genUiResourceIntegrity(resource),
    );
  });

  it.each([
    [
      "missing target",
      () => unsafeWithGenUi({ ...definition(), actions: { "cards.missing": "board" } }),
    ],
    [
      "missing view",
      () => unsafeWithGenUi({ ...definition(), actions: { "cards.board": "missing" } }),
    ],
    [
      "missing output",
      () => unsafeWithGenUi({ ...definition(), actions: { "cards.noOutput": "board" } }),
    ],
    [
      "different schema object",
      () =>
        unsafeWithGenUi({
          views: {
            board: { ...definition().views.board, props: z.object({ title: z.string() }) },
          },
          actions: { "cards.board": "board" },
        }),
    ],
    [
      "missing callable target",
      () =>
        unsafeWithGenUi({
          views: {
            board: { ...definition().views.board, callableTargets: ["cards.missing"] },
          },
          actions: { "cards.board": "board" },
        }),
    ],
    [
      "duplicate callable target",
      () =>
        unsafeWithGenUi({
          views: {
            board: { ...definition().views.board, callableTargets: ["cards.move", "cards.move"] },
          },
          actions: { "cards.board": "board" },
        }),
    ],
    [
      "runtime URL resource",
      () =>
        unsafeWithGenUi({
          views: {
            board: {
              ...definition().views.board,
              resource: {
                text: html,
                metadata: { csp: { connectDomains: ["https://example.test/path"] } },
              },
            },
          },
          actions: { "cards.board": "board" },
        }),
    ],
    [
      "unknown kind",
      () =>
        unsafeWithGenUi({
          ...definition(),
          views: { board: { ...definition().views.board, kind: "remote" } },
        }),
    ],
    [
      "unknown fallback",
      () =>
        unsafeWithGenUi({
          ...definition(),
          views: { board: { ...definition().views.board, fallback: "html" } },
        }),
    ],
    [
      "invalid view ID",
      () =>
        unsafeWithGenUi({
          views: { Bad: definition().views.board },
          actions: {},
        }),
    ],
    [
      "invalid semantic version",
      () =>
        unsafeWithGenUi({
          ...definition(),
          views: { board: { ...definition().views.board, version: "latest" } },
        }),
    ],
    [
      "empty resource",
      () =>
        unsafeWithGenUi({
          ...definition(),
          views: { board: { ...definition().views.board, resource: { text: "" } } },
        }),
    ],
    [
      "oversized resource",
      () =>
        unsafeWithGenUi({
          ...definition(),
          views: {
            board: {
              ...definition().views.board,
              resource: { text: "x".repeat(GENUI_MAX_RESOURCE_BYTES + 1) },
            },
          },
        }),
    ],
    [
      "too many views",
      () =>
        unsafeWithGenUi({
          views: Object.fromEntries(
            Array.from({ length: GENUI_MAX_VIEWS + 1 }, (_, index) => [
              `view-${index}`,
              definition().views.board,
            ]),
          ),
          actions: {},
        }),
    ],
  ])("rejects %s", (_name, run) => {
    expect(run).toThrow(/GenUI/);
  });

  it.each([
    ["invalid app", () => genUiResourceUri("Bad", "board", "1.0.0")],
    ["invalid view", () => genUiResourceUri("app", "Bad", "1.0.0")],
    ["invalid version", () => genUiResourceUri("app", "board", "latest")],
  ])("rejects %s resource URI input", (_name, run) => {
    expect(run).toThrow(/GenUI/);
  });
});
