import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createGenUiAppBridge } from "../src/apps.js";

it("forwards only initialized same-view declared app-visible tools and records a minimal ordered outcome", async () => {
  let generation = "a".repeat(64);
  const recorded: unknown[] = [];
  const dispatched: unknown[] = [];
  const hosted = createGenUiAppBridge({
    appId: "cards",
    generation,
    currentGeneration: () => generation,
    callableTargets: ["cards.update"],
    tools: [
      {
        target: "cards.update",
        tool: {
          name: "cards_update",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["app"] } },
        },
      },
      { target: "other.delete", tool: { name: "other_delete", inputSchema: { type: "object" } } },
    ],
    callTool: (name, input) => {
      dispatched.push({ name, input });
      return Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { private: "not-for-extra-context" },
      });
    },
    publishOutcome: (outcome) => {
      recorded.push(outcome);
      return Promise.resolve();
    },
  });
  const app = new App(
    { name: "reference-widget", version: "1.0.0" },
    {},
    { autoResize: false, strict: true },
  );
  const [view, host] = InMemoryTransport.createLinkedPair();
  try {
    await hosted.bridge.connect(host);
    await app.connect(view);
    expect((await app.callServerTool({ name: "other_delete", arguments: {} })).isError).toBe(true);
    expect(dispatched).toEqual([]);
    expect(
      (await app.callServerTool({ name: "cards_update", arguments: { pr: "private draft" } }))
        .isError,
    ).toBeUndefined();
    expect(dispatched).toEqual([{ name: "cards_update", input: { pr: "private draft" } }]);
    expect(recorded).toEqual([
      { target: "cards.update", status: "confirmed", reconciliation: "read-required" },
    ]);
    generation = "b".repeat(64);
    expect((await app.callServerTool({ name: "cards_update", arguments: {} })).isError).toBe(true);
    expect(dispatched).toHaveLength(1);
  } finally {
    hosted.dispose();
    await view.close();
  }
});

it("distinguishes a definitive safe veto from an uncertain transport failure without publishing its payload", async () => {
  const outcomes: unknown[] = [];
  const hosted = createGenUiAppBridge({
    appId: "cards",
    generation: "a",
    currentGeneration: () => "a",
    callableTargets: ["cards.update"],
    tools: [
      {
        target: "cards.update",
        tool: {
          name: "cards_update",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["app"] } },
        },
      },
    ],
    callTool: () =>
      Promise.resolve({
        isError: true,
        content: [{ type: "text", text: "private cause and draft" }],
        _meta: { "embody/errorCode": "HOOK_VETO" },
      }),
    publishOutcome: (outcome) => {
      outcomes.push(outcome);
      return Promise.resolve();
    },
  });
  const app = new App({ name: "widget", version: "1" }, {}, { autoResize: false, strict: true });
  const [view, host] = InMemoryTransport.createLinkedPair();
  try {
    await hosted.bridge.connect(host);
    await app.connect(view);
    await app.callServerTool({ name: "cards_update", arguments: { private: "draft" } });
    expect(outcomes).toEqual([
      {
        target: "cards.update",
        status: "rejected",
        reconciliation: "read-required",
        code: "HOOK_VETO",
      },
    ]);
  } finally {
    hosted.dispose();
    await view.close();
  }
});

it("denies empty or malformed visibility and a foreign app even when the target is declared", async () => {
  let calls = 0;
  const hosted = createGenUiAppBridge({
    appId: "cards",
    generation: "a",
    currentGeneration: () => "a",
    callableTargets: ["cards.empty", "cards.malformed", "cards.foreign"],
    tools: [
      {
        target: "cards.empty",
        tool: { name: "empty", inputSchema: { type: "object" }, _meta: { ui: { visibility: [] } } },
      },
      {
        target: "cards.malformed",
        tool: {
          name: "malformed",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: "app" } },
        },
      },
      {
        appId: "other",
        target: "cards.foreign",
        tool: {
          name: "foreign",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["app"] } },
        },
      },
    ],
    callTool: () => {
      calls++;
      return Promise.resolve({ content: [] });
    },
    publishOutcome: () => Promise.resolve(),
  });
  const app = new App({ name: "widget", version: "1" }, {}, { autoResize: false, strict: true });
  const [view, host] = InMemoryTransport.createLinkedPair();
  try {
    await hosted.bridge.connect(host);
    await app.connect(view);
    for (const name of ["empty", "malformed", "foreign"])
      expect((await app.callServerTool({ name, arguments: {} })).isError).toBe(true);
    expect(calls).toBe(0);
  } finally {
    hosted.dispose();
    await view.close();
  }
});
